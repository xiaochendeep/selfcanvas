import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSelfCanvasMcpServer } from './createServer.mjs';
import { SelfCanvasClient } from './selfCanvasClient.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const draftInput = { kind: 'script', requestId: 'creative-request-123', canvasId: 'canvas-1', brief: '写一个雨夜茶铺的悬疑短剧', confirmed: true };

async function connectedPair(t, apiClient, scopes) {
  const server = createSelfCanvasMcpServer({ apiClient, scopes: new Set(scopes) });
  const client = new Client({ name: 'creative-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('creative client uses fixed routes, stable request ID and a scoped long timeout', async (t) => {
  const calls = [];
  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (handler, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(handler, delay, ...args);
  });
  const client = new SelfCanvasClient({
    baseUrl: 'http://selfcanvas.test:8787', timeoutMs: 9_000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body), requestId: init.headers['X-Request-Id'] });
      return response({ runId: 'run-1', canvasId: 'canvas-1', sourceRevision: 3, draft: { script: '雨夜'.repeat(3_000) } });
    },
  });
  await client.getCreativeCapabilities();
  const draft = await client.createCreativeDraft(draftInput);
  await client.getJob({ jobId: 'job-1' });
  assert.deepEqual(calls.map(({ url, method }) => [method, new URL(url).pathname]), [
    ['GET', '/api/v2/creative/capabilities'], ['POST', '/api/v2/creative/runs'], ['GET', '/api/v2/jobs/job-1'],
  ]);
  assert.deepEqual(calls[1].body, draftInput);
  assert.equal(calls[1].requestId, draftInput.requestId);
  assert.deepEqual(delays, [9_000, 190_000, 9_000]);
  assert.equal(draft.draft.script.length, 6_000, 'long scripts must not use generic 4000-character truncation');
});

test('creative client never retries an uncertain request or generates a replacement ID', async () => {
  let calls = 0;
  const client = new SelfCanvasClient({ fetchImpl: async () => { calls += 1; throw new DOMException('aborted', 'AbortError'); } });
  await assert.rejects(client.createCreativeDraft(draftInput), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.details.requestId, draftInput.requestId);
    assert.equal(error.details.outcome, 'unknown');
    assert.match(error.message, /相同 requestId/);
    return true;
  });
  assert.equal(calls, 1);
});

test('creative draft output redacts credentials, absolute paths, supplier URLs and inline media', async () => {
  const client = new SelfCanvasClient({ fetchImpl: async () => response({
    runId: 'run-1', model: 'text-model', draft: { script: '故事', sourcePath: '/Users/person/private/video.mp4', providerEndpoint: 'https://private.vendor.test', apiKey: 'PRIVATE_KEY', sourceVideo: 'data:video/mp4;base64,SECRET_DATA', note: 'See https://private.vendor.test?token=secret and /home/deploy/secret.txt' },
    skillSources: [{ id: 'short-drama-write', path: '/Users/person/.codex/skills/secret/SKILL.md' }],
  }) });
  const payload = await client.createCreativeDraft(draftInput);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /PRIVATE_KEY|SECRET_DATA|private\.vendor|\/Users\/person|\/home\/deploy/);
  assert.equal(payload.draft.script, '故事');
  assert.equal(payload.skillSources[0].id, 'short-drama-write');
});

test('creative capability is readable without generation permission', async (t) => {
  const calls = [];
  const client = await connectedPair(t, { getCreativeCapabilities: async () => { calls.push('read'); return { kinds: ['script'] }; } }, ['canvas:read']);
  const read = await client.callTool({ name: 'canvas_get_creative_capabilities', arguments: {} });
  assert.equal(read.isError, undefined);
  const denied = await client.callTool({ name: 'canvas_create_creative_draft', arguments: draftInput });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /insufficient_scope/);
  assert.deepEqual(calls, ['read']);
});

test('creative tool requires explicit paid-call confirmation and forbids transport fields', async (t) => {
  const calls = [];
  const client = await connectedPair(t, { createCreativeDraft: async (input) => { calls.push(input); return { runId: 'run-1', draft: {} }; } }, ['generation:run']);
  for (const invalid of [
    { ...draftInput, confirmed: false }, { ...draftInput, confirmed: undefined },
    { ...draftInput, endpoint: 'https://evil.test' }, { ...draftInput, apiKey: 'secret' },
    { ...draftInput, url: 'https://evil.test/video.mp4' }, { ...draftInput, path: '/tmp/video.mp4' },
    { ...draftInput, imageModel: 'https://evil.test/model' },
    { ...draftInput, kind: 'video-analysis' },
    { ...draftInput, kind: 'video-analysis', sourceNodeId: '/tmp/video.mp4' },
  ]) {
    const result = await client.callTool({ name: 'canvas_create_creative_draft', arguments: invalid });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
  const valid = { ...draftInput, kind: 'video-analysis', sourceNodeId: 'video-1' };
  const result = await client.callTool({ name: 'canvas_create_creative_draft', arguments: valid });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [valid]);
});

test('creative tools enforce read scope and server-aligned request bounds', async (t) => {
  let calls = 0;
  const client = await connectedPair(t, { createCreativeDraft: async () => { calls += 1; return { draft: {} }; }, getCreativeCapabilities: async () => ({ skills: [] }) }, ['generation:run']);
  const deniedRead = await client.callTool({ name: 'canvas_get_creative_capabilities', arguments: {} });
  assert.equal(deniedRead.isError, true);
  assert.match(deniedRead.content[0].text, /canvas:read/);
  for (const patch of [
    { shotCount: 0 }, { shotCount: 21 }, { shotCount: 1.5 },
    { durationSeconds: 4 }, { durationSeconds: 601 }, { aspectRatio: 'adaptive' },
    { brief: 'x'.repeat(8001) }, { sourceText: 'x'.repeat(40001) }, { style: 'x'.repeat(1001) },
    { brief: '  ', sourceText: '' }, { sourceNodeId: 'video-1' },
  ]) {
    const result = await client.callTool({ name: 'canvas_create_creative_draft', arguments: { ...draftInput, ...patch } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
});
