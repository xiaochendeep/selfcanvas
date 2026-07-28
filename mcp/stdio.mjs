import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSelfCanvasMcpServer, parseScopes } from './createServer.mjs';

export async function startStdioMcpServer(options = {}) {
  const server = createSelfCanvasMcpServer({
    ...options,
    scopes: options.scopes instanceof Set ? options.scopes : parseScopes(options.scopes),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdioMcpServer().catch((error) => {
    // stdout belongs exclusively to the MCP protocol.
    console.error(`[selfcanvas-mcp] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
