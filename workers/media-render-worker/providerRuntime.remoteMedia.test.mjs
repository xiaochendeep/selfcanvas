import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { persistRemoteFile, validateRemoteMediaUrl } from './providerRuntime.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REMOTE_MEDIA_ENV_KEYS = [
  'SUB2API_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_BASE_URL',
  'SELF_CANVAS_REMOTE_MEDIA_ORIGINS',
  'SELF_CANVAS_REMOTE_MEDIA_MAX_MB',
  'SELF_CANVAS_STORAGE_ROOT',
];

function snapshotEnvironment() {
  return Object.fromEntries(REMOTE_MEDIA_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const key of REMOTE_MEDIA_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function clearTrustedOrigins() {
  delete process.env.SUB2API_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS;
}

async function startServer(handler, { host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function outputFile(storageRoot, relativeUrl) {
  assert.match(relativeUrl, /^\/output\//);
  const name = decodeURIComponent(relativeUrl.slice('/output/'.length));
  return path.join(storageRoot, 'output', name);
}

test('remote provider media is validated and streamed to disk safely', { concurrency: false }, async (t) => {
  const originalEnvironment = snapshotEnvironment();
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-remote-media-'));
  clearTrustedOrigins();
  process.env.SELF_CANVAS_STORAGE_ROOT = storageRoot;

  t.after(async () => {
    restoreEnvironment(originalEnvironment);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  await t.test('rejects loopback and private addresses when no origin is configured', async () => {
    clearTrustedOrigins();
    await assert.rejects(
      validateRemoteMediaUrl('http://127.0.0.1:8080/generated.png'),
      /私网、回环或保留地址|本机或 metadata/,
    );
    await assert.rejects(
      validateRemoteMediaUrl('http://10.23.45.67/generated.png'),
      /私网、回环或保留地址/,
    );
    await assert.rejects(
      validateRemoteMediaUrl('http://localhost/generated.png'),
      /本机或 metadata/,
    );
  });

  await t.test('downloads a PNG from the exact explicitly trusted private origin', async (t) => {
    const expected = Buffer.concat([PNG_SIGNATURE, Buffer.from('streamed-png-body')]);
    const server = await startServer((request, response) => {
      assert.equal(request.url, '/generated.png');
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.write(expected.subarray(0, 5));
      response.write(expected.subarray(5, 13));
      response.end(expected.subarray(13));
    });
    t.after(server.close);
    clearTrustedOrigins();
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = server.origin;

    const relativeUrl = await persistRemoteFile(`${server.origin}/generated.png`, 'trusted-private-origin');
    assert.equal(relativeUrl, '/output/trusted-private-origin.png');
    assert.deepEqual(await fs.readFile(await outputFile(storageRoot, relativeUrl)), expected);
  });

  await t.test('pins the first validated DNS address and never re-resolves to a rebound address', async (t) => {
    const firstResponse = Buffer.concat([PNG_SIGNATURE, Buffer.from('first-validated-address')]);
    let firstAddressHits = 0;
    const firstAddressServer = await startServer((_request, response) => {
      firstAddressHits += 1;
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(firstResponse);
    });
    t.after(firstAddressServer.close);

    const hostname = 'rebind.selfcanvas.test';
    const originalLookup = dns.lookup;
    let lookupCalls = 0;
    dns.lookup = async (requestedHostname, options) => {
      assert.equal(requestedHostname, hostname);
      lookupCalls += 1;
      const address = lookupCalls === 1 ? '127.0.0.1' : '127.0.0.2';
      if (options?.all) return [{ address, family: 4 }];
      return { address, family: 4 };
    };
    t.after(() => {
      dns.lookup = originalLookup;
    });

    clearTrustedOrigins();
    const trustedOrigin = `http://${hostname}:${firstAddressServer.port}`;
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = trustedOrigin;

    const relativeUrl = await persistRemoteFile(`${trustedOrigin}/dns-rebinding.png`, 'dns-rebinding');
    assert.equal(lookupCalls, 1, 'validation DNS must be called exactly once for a non-redirected URL');
    assert.equal(firstAddressHits, 1, 'the connection must use the address returned during validation');
    assert.deepEqual(await fs.readFile(await outputFile(storageRoot, relativeUrl)), firstResponse);
  });

  await t.test('revalidates a redirect to another origin and port before following it', async (t) => {
    let untrustedServerHits = 0;
    const untrusted = await startServer((_request, response) => {
      untrustedServerHits += 1;
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(PNG_SIGNATURE);
    });
    const trusted = await startServer((_request, response) => {
      response.writeHead(302, { Location: `${untrusted.origin}/redirected.png` });
      response.end();
    });
    t.after(async () => {
      await trusted.close();
      await untrusted.close();
    });
    clearTrustedOrigins();
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = trusted.origin;

    await assert.rejects(
      persistRemoteFile(`${trusted.origin}/start`, 'redirect-cross-origin'),
      /私网、回环或保留地址/,
    );
    assert.equal(untrustedServerHits, 0, 'the untrusted redirect target must not be requested');
  });

  await t.test('rejects a declared Content-Length above the configured limit', async (t) => {
    const overLimit = 1024 * 1024 + 1;
    const body = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(overLimit - PNG_SIGNATURE.length)]);
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(body.byteLength),
      });
      response.end(body);
    });
    t.after(server.close);
    clearTrustedOrigins();
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = server.origin;
    process.env.SELF_CANVAS_REMOTE_MEDIA_MAX_MB = '1';

    await assert.rejects(
      persistRemoteFile(`${server.origin}/declared-too-large.png`, 'declared-too-large'),
      /超过 1 MB 安全上限/,
    );
  });

  await t.test('rejects a chunked stream that grows beyond the configured limit and removes partial files', async (t) => {
    const chunk = Buffer.alloc(256 * 1024, 0x5a);
    PNG_SIGNATURE.copy(chunk, 0);
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      for (let index = 0; index < 5; index += 1) response.write(chunk);
      response.end();
    });
    t.after(server.close);
    clearTrustedOrigins();
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = server.origin;
    process.env.SELF_CANVAS_REMOTE_MEDIA_MAX_MB = '1';

    await assert.rejects(
      persistRemoteFile(`${server.origin}/chunked-too-large.png`, 'chunked-too-large'),
      /超过 1 MB 安全上限/,
    );
    const outputNames = await fs.readdir(path.join(storageRoot, 'output'));
    assert.equal(outputNames.some((name) => name.includes('chunked-too-large')), false);
  });

  await t.test('rejects HTML, SVG, and image responses without supported magic bytes', async (t) => {
    const cases = new Map([
      ['/html', { contentType: 'text/html', body: Buffer.from('<!doctype html><h1>not an image</h1>') }],
      ['/svg', { contentType: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }],
      ['/svg-octets', { contentType: 'application/octet-stream', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }],
      ['/fake-png', { contentType: 'image/png', body: Buffer.from('this is not really a png') }],
    ]);
    const server = await startServer((request, response) => {
      const fixture = cases.get(request.url);
      assert.ok(fixture, `unexpected fixture URL ${request.url}`);
      response.writeHead(200, { 'Content-Type': fixture.contentType });
      response.end(fixture.body);
    });
    t.after(server.close);
    clearTrustedOrigins();
    process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS = server.origin;

    for (const [route] of cases) {
      await assert.rejects(
        persistRemoteFile(`${server.origin}${route}`, `invalid${route.replaceAll('/', '-')}`),
        /不支持的媒体类型|不是受支持的 PNG\/JPEG\/WebP\/AVIF 图片/,
      );
    }
  });
});
