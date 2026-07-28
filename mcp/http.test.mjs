import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpMcpServer } from './http.mjs';

test('Streamable HTTP rejects missing bearer tokens and accepts authenticated Codex clients', async () => {
  const service = await startHttpMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token-123',
    apiClient: {
      async listCanvases() {
        return { items: [{ id: 'canvas_main', name: '主画布' }], nextCursor: null };
      },
    },
  });
  const address = service.address;
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  let client;
  try {
    const unauthenticated = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer/);

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer test-token-123' } },
    });
    client = new Client({ name: 'http-contract-test', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'canvas_list_canvases', arguments: { limit: 10 } });
    assert.equal(result.structuredContent.result.items[0].id, 'canvas_main');
  } finally {
    await client?.close();
    await service.close();
  }
});
