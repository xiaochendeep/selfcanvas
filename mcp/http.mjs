import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { createSelfCanvasMcpServer, parseScopes } from './createServer.mjs';
import { SelfCanvasClient } from './selfCanvasClient.mjs';

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

function tokenDigest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function bearerTokenMatches(header, expectedToken) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!match || !expectedToken) return false;
  return timingSafeEqual(tokenDigest(match[1]), tokenDigest(expectedToken));
}

function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    ...headers,
  });
  response.end(body);
}

async function nodeRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_MCP_REQUEST_BYTES) {
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function toWebRequest(request) {
  const body = await nodeRequestBody(request);
  const host = request.headers.host || 'localhost';
  return new Request(`http://${host}${request.url || '/'}`, {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });
}

async function sendWebResponse(webResponse, nodeResponse) {
  const headers = Object.fromEntries(webResponse.headers.entries());
  nodeResponse.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  const reader = webResponse.body.getReader();
  const cancelOnDisconnect = () => {
    if (!nodeResponse.writableEnded) void reader.cancel('MCP client disconnected').catch(() => {});
  };
  nodeResponse.once('close', cancelOnDisconnect);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!nodeResponse.write(Buffer.from(value))) {
        await new Promise((resolve) => nodeResponse.once('drain', resolve));
      }
    }
  } finally {
    nodeResponse.off('close', cancelOnDisconnect);
    if (!nodeResponse.writableEnded && !nodeResponse.destroyed) nodeResponse.end();
  }
}

export async function createHttpMcpService(options = {}) {
  const token = String(options.token ?? process.env.SELF_CANVAS_MCP_TOKEN ?? '').trim();
  if (!token) throw new Error('启动 Streamable HTTP MCP 前必须设置 SELF_CANVAS_MCP_TOKEN');

  const apiClient =
    options.apiClient ||
    new SelfCanvasClient({
      baseUrl: options.baseUrl,
      publicBaseUrl: options.publicBaseUrl,
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  const scopes = options.scopes instanceof Set ? options.scopes : parseScopes(options.scopes);
  const activeServers = new Set();

  const requestHandler = async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok', service: 'selfcanvas-mcp' });
      return;
    }
    if (requestUrl.pathname !== '/mcp') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (!bearerTokenMatches(request.headers.authorization, token)) {
      sendJson(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="selfcanvas-mcp"' });
      return;
    }
    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > MAX_MCP_REQUEST_BYTES) {
      sendJson(response, 413, { error: 'request_too_large' });
      return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(request.method || '')) {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' });
      return;
    }
    let requestMcpServer;
    try {
      // The SDK's stateless transport is intentionally single-request. A fresh MCP
      // server/transport pair also prevents state from leaking between Codex clients.
      requestMcpServer = createSelfCanvasMcpServer({ apiClient, scopes });
      activeServers.add(requestMcpServer);
      const requestTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await requestMcpServer.connect(requestTransport);
      const webRequest = await toWebRequest(request);
      const webResponse = await requestTransport.handleRequest(webRequest);
      await sendWebResponse(webResponse, response);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error?.status === 413 ? 413 : 500, {
          error: error?.status === 413 ? 'request_too_large' : 'mcp_transport_error',
        });
      }
      else response.end();
      console.error('[selfcanvas-mcp] transport error:', error?.message || error);
    } finally {
      if (requestMcpServer) {
        activeServers.delete(requestMcpServer);
        await requestMcpServer.close().catch(() => {});
      }
    }
  };

  return {
    requestHandler,
    async close() {
      await Promise.all([...activeServers].map((server) => server.close().catch(() => {})));
      activeServers.clear();
    },
  };
}

export async function startHttpMcpServer(options = {}) {
  const host = String(options.host || process.env.SELF_CANVAS_MCP_HOST || '127.0.0.1');
  const port = Number(options.port ?? process.env.SELF_CANVAS_MCP_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('SELF_CANVAS_MCP_PORT 无效');
  const service = await createHttpMcpService(options);
  const httpServer = createNodeServer(service.requestHandler);
  httpServer.requestTimeout = 65_000;
  httpServer.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  return {
    ...service,
    httpServer,
    address,
    async close() {
      await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await service.close();
    },
  };
}

async function main() {
  const service = await startHttpMcpServer();
  const address = service.address;
  const host = typeof address === 'object' && address ? address.address : process.env.SELF_CANVAS_MCP_HOST || '127.0.0.1';
  const port = typeof address === 'object' && address ? address.port : process.env.SELF_CANVAS_MCP_PORT || 8790;
  console.error(`[selfcanvas-mcp] Streamable HTTP listening on http://${host}:${port}/mcp`);

  const shutdown = async () => {
    try {
      await service.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[selfcanvas-mcp] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
