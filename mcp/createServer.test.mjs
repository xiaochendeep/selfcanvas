import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ALL_SCOPES, createSelfCanvasMcpServer } from './createServer.mjs';

async function connectedPair(apiClient, scopes = new Set(ALL_SCOPES)) {
  const server = createSelfCanvasMcpServer({ apiClient, scopes });
  const client = new Client({ name: 'selfcanvas-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('registers canvas and creative tools with accurate safety annotations', async (t) => {
  const apiClient = {};
  const pair = await connectedPair(apiClient);
  t.after(() => pair.close());
  const { tools } = await pair.client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual([...byName.keys()], [
    'canvas_list_canvases',
    'canvas_get_canvas',
    'canvas_search_nodes',
    'canvas_apply_operations',
    'canvas_run_node',
    'canvas_create_video_edit',
    'canvas_get_job',
    'canvas_list_artifacts',
    'canvas_prepare_download',
    'canvas_get_creative_capabilities',
    'canvas_create_creative_draft',
  ]);
  assert.deepEqual(byName.get('canvas_get_canvas').annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(byName.get('canvas_apply_operations').annotations.readOnlyHint, false);
  assert.equal(byName.get('canvas_apply_operations').annotations.destructiveHint, true);
  assert.equal(byName.get('canvas_run_node').annotations.openWorldHint, true);
  assert.equal(byName.get('canvas_prepare_download').annotations.destructiveHint, false);
  assert.equal(byName.get('canvas_get_creative_capabilities').annotations.readOnlyHint, true);
  assert.equal(byName.get('canvas_create_creative_draft').annotations.openWorldHint, true);
  assert.equal(byName.get('canvas_create_creative_draft').annotations.destructiveHint, false);
});

test('tool calls validate input and preserve REST contract arguments', async (t) => {
  const calls = [];
  const apiClient = {
    async listCanvases(input) {
      calls.push(input);
      return { items: [{ id: 'canvas_main', name: '主画布', revision: 4 }], nextCursor: null };
    },
  };
  const pair = await connectedPair(apiClient);
  t.after(() => pair.close());

  const result = await pair.client.callTool({
    name: 'canvas_list_canvases',
    arguments: { limit: 10 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ limit: 10 }]);
  assert.equal(result.structuredContent.result.items[0].id, 'canvas_main');
});

test('missing scopes are returned as safe MCP tool errors', async (t) => {
  const pair = await connectedPair(
    { applyOperations: async () => ({ revision: 2 }) },
    new Set(['canvas:read']),
  );
  t.after(() => pair.close());

  const result = await pair.client.callTool({
    name: 'canvas_apply_operations',
    arguments: {
      canvasId: 'canvas_main',
      baseRevision: 1,
      requestId: 'request-12345678',
      operations: [{ type: 'rename_canvas', name: '新名字' }],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /insufficient_scope/);
  assert.doesNotMatch(result.content[0].text, /stack|at file:/i);
});

test('focus_node is a validated CAS canvas operation', async (t) => {
  let received;
  const pair = await connectedPair({
    async applyOperations(input) {
      received = input;
      return { revision: 5, applied: 1 };
    },
  });
  t.after(() => pair.close());

  const result = await pair.client.callTool({
    name: 'canvas_apply_operations',
    arguments: {
      canvasId: 'canvas_main',
      baseRevision: 4,
      requestId: 'focus-request-1234',
      operations: [{ type: 'focus_node', nodeId: 'image-123' }],
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(received.operations, [{ type: 'focus_node', nodeId: 'image-123' }]);
});

test('bind_references validates source node IDs and applies safe defaults', async (t) => {
  let received;
  const pair = await connectedPair({
    async applyOperations(input) {
      received = input;
      return { revision: 6, applied: 1 };
    },
  });
  t.after(() => pair.close());

  const result = await pair.client.callTool({
    name: 'canvas_apply_operations',
    arguments: {
      canvasId: 'canvas_main',
      baseRevision: 5,
      requestId: 'bind-request-1234',
      operations: [
        {
          type: 'bind_references',
          targetNodeId: 'shot-video-01',
          sourceNodeIds: ['character-shen', 'scene-hospital'],
        },
      ],
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(received.operations, [
    {
      type: 'bind_references',
      targetNodeId: 'shot-video-01',
      sourceNodeIds: ['character-shen', 'scene-hospital'],
      ensureEdges: true,
      appendMentions: true,
    },
  ]);
});

test('bind_references rejects duplicate IDs, self references, and URL fields before REST', async (t) => {
  let calls = 0;
  const pair = await connectedPair({
    async applyOperations() {
      calls += 1;
      return { revision: 6 };
    },
  });
  t.after(() => pair.close());

  for (const operation of [
    {
      type: 'bind_references',
      targetNodeId: 'target-video',
      sourceNodeIds: ['same-node', 'same-node'],
    },
    {
      type: 'bind_references',
      targetNodeId: 'target-video',
      sourceNodeIds: ['target-video'],
    },
    {
      type: 'bind_references',
      targetNodeId: 'target-video',
      sourceNodeIds: ['source-image'],
      url: 'https://example.test/unsafe.png',
    },
  ]) {
    const result = await pair.client.callTool({
      name: 'canvas_apply_operations',
      arguments: {
        canvasId: 'canvas_main',
        baseRevision: 5,
        requestId: `bind-invalid-${Math.random().toString(36).slice(2)}`,
        operations: [operation],
      },
    });
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
});

test('video edit schema enforces mode-specific input limits before calling the API', async (t) => {
  let called = false;
  const pair = await connectedPair({ createVideoEdit: async () => (called = true) });
  t.after(() => pair.close());

  const result = await pair.client.callTool({
    name: 'canvas_create_video_edit',
    arguments: {
      canvasId: 'canvas_main',
      baseRevision: 2,
      requestId: 'request-12345678',
      mode: 'merge',
      sourceNodeIds: ['video-one'],
    },
  });
  assert.equal(called, false);
  assert.equal(result.isError, true);
});
