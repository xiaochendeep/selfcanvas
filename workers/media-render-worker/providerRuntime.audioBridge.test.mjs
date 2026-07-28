import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { startAnyCapCapabilityBridge } from './providerRuntime.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('AnyCap capability bridge maps music CLI routes to the audio capability without exposing auth', async () => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const body = Buffer.from(JSON.stringify({ status: 'success', data: { ok: true } }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.byteLength });
    response.end(body);
  });
  const address = await listen(upstream);
  const previousEndpoint = process.env.ANYCAP_ENDPOINT;
  process.env.ANYCAP_ENDPOINT = `http://127.0.0.1:${address.port}`;
  const bridge = await startAnyCapCapabilityBridge('music', 'audio');
  try {
    const schemaResponse = await fetch(`${bridge.endpoint}/v1/music/models/doubao-seed-audio-1-0/schema?mode=text-to-audio`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(schemaResponse.status, 200);
    const generationResponse = await fetch(`${bridge.endpoint}/v1/music/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-seed-audio-1-0', mode: 'text-to-audio', prompt: 'rain' }),
    });
    assert.equal(generationResponse.status, 200);
    assert.deepEqual(requests.map((item) => item.path), [
      '/v1/audio/models/doubao-seed-audio-1-0/schema?mode=text-to-audio',
      '/v1/audio/generate',
    ]);
    assert.equal(requests[1].authorization, 'Bearer test-token');
    assert.match(requests[1].body, /doubao-seed-audio-1-0/);
  } finally {
    await bridge.close();
    await close(upstream);
    if (previousEndpoint === undefined) delete process.env.ANYCAP_ENDPOINT;
    else process.env.ANYCAP_ENDPOINT = previousEndpoint;
  }
});
