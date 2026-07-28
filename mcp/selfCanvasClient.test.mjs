import assert from 'node:assert/strict';
import test from 'node:test';

import { SelfCanvasApiError, SelfCanvasClient } from './selfCanvasClient.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('listCanvases calls only the v2 REST route and adds opaque local pagination', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse([
      { id: 'canvas-1', name: '一' },
      { id: 'canvas-2', name: '二' },
      { id: 'canvas-3', name: '三' },
    ]);
  };
  const client = new SelfCanvasClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

  const first = await client.listCanvases({ limit: 2 });
  assert.equal(calls[0].url.pathname, '/api/v2/canvases');
  assert.equal(calls[0].url.searchParams.get('limit'), '2');
  assert.deepEqual(first.items.map((item) => item.id), ['canvas-1', 'canvas-2']);
  assert.match(first.nextCursor, /^mcp:/);

  const second = await client.listCanvases({ cursor: first.nextCursor, limit: 2 });
  assert.equal(calls[1].url.searchParams.has('cursor'), false, 'local cursor must not be forwarded upstream');
  assert.deepEqual(second.items.map((item) => item.id), ['canvas-3']);
  assert.equal(second.nextCursor, null);
});

test('mutating calls forward revision and idempotency key without accepting arbitrary URLs', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ revision: 8, applied: 1 });
  };
  const client = new SelfCanvasClient({ baseUrl: 'http://selfcanvas.test:8787/ignored', fetchImpl });
  const input = {
    canvasId: 'canvas_main',
    baseRevision: 7,
    requestId: 'req-12345678',
    operations: [{ type: 'rename_canvas', name: '新画布' }],
  };

  await client.applyOperations(input);
  assert.equal(calls[0].url.href, 'http://selfcanvas.test:8787/api/v2/canvases/canvas_main/operations');
  assert.equal(calls[0].init.headers['X-Request-Id'], input.requestId);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    baseRevision: 7,
    requestId: input.requestId,
    operations: input.operations,
  });

  await assert.rejects(() => client.request('GET', 'https://evil.test/api/v2/canvases'), /v2 API/);
});

test('all planned MCP operations map to the fixed v2 REST surface', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, url: new URL(url), body: init.body ? JSON.parse(init.body) : undefined });
    return jsonResponse({ items: [], nextCursor: null });
  };
  const client = new SelfCanvasClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });
  const common = { canvasId: 'canvas_main', baseRevision: 3, requestId: 'request-12345678' };

  await client.getCanvas({ canvasId: 'canvas_main', limit: 10 });
  await client.searchNodes({ canvasId: 'canvas_main', query: '茶铺', kinds: ['video'], limit: 10 });
  await client.runNode({ ...common, nodeId: 'video-1' });
  await client.createVideoEdit({
    ...common,
    mode: 'merge',
    sourceNodeIds: ['video-1', 'video-2'],
    transition: 'cut',
    audioPolicy: 'preserve',
  });
  await client.getJob({ jobId: 'job-1' });
  await client.listArtifacts({ canvasId: 'canvas_main', nodeId: 'video-1', types: ['video'], limit: 10 });
  await client.prepareDownload({
    canvasId: 'canvas_main',
    artifactIds: ['artifact-1'],
    requestId: 'download-12345678',
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname]),
    [
      ['GET', '/api/v2/canvases/canvas_main'],
      ['GET', '/api/v2/canvases/canvas_main/nodes'],
      ['POST', '/api/v2/canvases/canvas_main/nodes/video-1/run'],
      ['POST', '/api/v2/canvases/canvas_main/video-edits'],
      ['GET', '/api/v2/jobs/job-1'],
      ['GET', '/api/v2/canvases/canvas_main/artifacts'],
      ['POST', '/api/v2/downloads'],
    ],
  );
  assert.deepEqual(calls[3].body.sourceNodeIds, ['video-1', 'video-2']);
  assert.deepEqual(calls[6].body.artifactIds, ['artifact-1']);
});

test('upstream errors are sanitized before reaching MCP handlers', async () => {
  const fetchImpl = async () =>
    jsonResponse(
      {
        error: {
          code: 'revision_conflict',
          message: 'failed at /home/deploy/selfcanvas/output/private.mp4',
        },
        apiKey: 'must-not-leak',
        providerEndpoint: 'https://api.anycap.example/v1',
        localPath: '/home/deploy/selfcanvas/output/private.mp4',
      },
      409,
    );
  const client = new SelfCanvasClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

  await assert.rejects(
    () => client.getCanvas({ canvasId: 'canvas_main', limit: 20 }),
    (error) => {
      assert.ok(error instanceof SelfCanvasApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'revision_conflict');
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.doesNotMatch(serialized, /must-not-leak|api\.anycap|\/home\/deploy|private\.mp4/);
      assert.match(serialized, /redacted-path/);
      return true;
    },
  );
});

test('artifact responses keep controlled SelfCanvas URLs and remove paths', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      artifacts: [
        {
          id: 'artifact-1',
          type: 'video',
          downloadUrl: 'http://127.0.0.1:8787/api/v2/artifacts/artifact-1/download',
          previewUrl: 'https://remote-provider.example/video.mp4',
          absolutePath: '/Users/person/output/video.mp4',
        },
      ],
    });
  const client = new SelfCanvasClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

  const result = await client.listArtifacts({ canvasId: 'canvas_main', limit: 20 });
  assert.equal(result.artifacts[0].downloadUrl, 'http://127.0.0.1:8787/api/v2/artifacts/artifact-1/download');
  assert.equal(result.artifacts[0].previewUrl, '[redacted-external-url]');
  assert.equal('absolutePath' in result.artifacts[0], false);
});

test('relative artifact URLs use the externally reachable SelfCanvas public host', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      artifacts: [
        {
          id: 'opaque-artifact',
          type: 'image',
          downloadUrl: '/api/files/download/opaque-artifact',
          previewUrl: '/output/images/example.png',
        },
      ],
    });
  const client = new SelfCanvasClient({
    baseUrl: 'http://selfcanvas:8787',
    publicBaseUrl: 'http://192.168.15.185:8787',
    fetchImpl,
  });

  const result = await client.listArtifacts({ canvasId: 'canvas_main', limit: 20 });
  assert.equal(result.artifacts[0].downloadUrl, 'http://192.168.15.185:8787/api/files/download/opaque-artifact');
  assert.equal(result.artifacts[0].previewUrl, 'http://192.168.15.185:8787/output/images/example.png');
});
