import { fitMcpResponse, paginateResponse, sanitizeForMcp, upstreamCursor } from './security.mjs';

const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

function requireIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new TypeError(`${label} 无效`);
  }
  return encodeURIComponent(normalized);
}

function normalizeBaseUrl(raw) {
  const value = String(raw || 'http://127.0.0.1:8787').trim();
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('SELF_CANVAS_BASE_URL 仅支持 http/https');
  if (parsed.username || parsed.password) throw new TypeError('SELF_CANVAS_BASE_URL 不能包含账号或密码');
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function absolutizeControlledUrls(value, baseUrl, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 16) return value;
  if (Array.isArray(value)) return value.map((item) => absolutizeControlledUrls(item, baseUrl, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item === 'string' && /url$/i.test(key) && (item.startsWith('/api/') || item.startsWith('/output/'))) {
        return [key, new URL(item, baseUrl).href];
      }
      return [key, absolutizeControlledUrls(item, baseUrl, depth + 1)];
    }),
  );
}

async function readJsonLimited(response) {
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_UPSTREAM_RESPONSE_BYTES) throw new Error('SelfCanvas 返回内容过大，请使用分页参数');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPSTREAM_RESPONSE_BYTES) throw new Error('SelfCanvas 返回内容过大，请使用分页参数');
  if (!bytes.byteLength) return {};
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('SelfCanvas 返回了无效 JSON');
  }
}

export class SelfCanvasApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SelfCanvasApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export class SelfCanvasClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.SELF_CANVAS_BASE_URL);
    this.publicBaseUrl = normalizeBaseUrl(
      options.publicBaseUrl || process.env.SELF_CANVAS_PUBLIC_BASE_URL || this.baseUrl.href,
    );
    this.apiToken = String(options.apiToken ?? process.env.SELF_CANVAS_API_TOKEN ?? '').trim();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs || process.env.SELF_CANVAS_API_TIMEOUT_MS || 20_000));
    if (typeof this.fetchImpl !== 'function') throw new TypeError('当前 Node.js 环境不支持 fetch');
  }

  async request(method, apiPath, options = {}) {
    if (!apiPath.startsWith('/api/v2/') || apiPath.includes('..')) throw new TypeError('MCP 只能调用 SelfCanvas v2 API');
    const url = new URL(apiPath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new TypeError('拒绝跨主机请求');
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
          ...(options.requestId ? { 'X-Request-Id': String(options.requestId) } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const raw = await readJsonLimited(response);
      const sanitized = absolutizeControlledUrls(
        sanitizeForMcp(raw, { baseUrl: this.baseUrl }),
        this.publicBaseUrl,
      );
      if (!response.ok) {
        const rawError = raw && typeof raw === 'object' ? raw.error : undefined;
        const safeError = sanitized && typeof sanitized === 'object' ? sanitized.error : undefined;
        const message =
          (safeError && typeof safeError === 'object' ? safeError.message : safeError) ||
          sanitized?.message ||
          response.statusText;
        const code =
          (rawError && typeof rawError === 'object' ? rawError.code : undefined) ||
          raw?.code ||
          (response.status === 409 ? 'revision_conflict' : `http_${response.status}`);
        throw new SelfCanvasApiError(String(message || 'SelfCanvas 请求失败'), {
          status: response.status,
          code: String(code),
          details: sanitized,
        });
      }
      return sanitized;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new SelfCanvasApiError('SelfCanvas API 请求超时', { status: 504, code: 'timeout' });
      }
      if (error instanceof SelfCanvasApiError) throw error;
      throw new SelfCanvasApiError(String(error?.message || '无法连接 SelfCanvas API'), {
        status: 503,
        code: 'connection_error',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listCanvases({ cursor, limit }) {
    const payload = await this.request('GET', '/api/v2/canvases', {
      query: { cursor: upstreamCursor(cursor), limit },
    });
    return fitMcpResponse(paginateResponse(payload, { cursor, limit, keys: ['canvases'] }));
  }

  async getCanvas({ canvasId, cursor, limit }) {
    const payload = await this.request('GET', `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}`, {
      query: { cursor: upstreamCursor(cursor), limit },
    });
    return fitMcpResponse(paginateResponse(payload, { cursor, limit, keys: ['nodes'] }));
  }

  async searchNodes({ canvasId, query, kinds, cursor, limit }) {
    const payload = await this.request('GET', `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}/nodes`, {
      query: { q: query, kind: kinds, cursor: upstreamCursor(cursor), limit },
    });
    return fitMcpResponse(paginateResponse(payload, { cursor, limit, keys: ['nodes'] }));
  }

  applyOperations({ canvasId, baseRevision, requestId, operations }) {
    return this.request('POST', `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}/operations`, {
      requestId,
      body: { baseRevision, requestId, operations },
    }).then(fitMcpResponse);
  }

  runNode({ canvasId, nodeId, baseRevision, requestId }) {
    return this.request(
      'POST',
      `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}/nodes/${requireIdentifier(nodeId, 'nodeId')}/run`,
      { requestId, body: { baseRevision, requestId } },
    ).then(fitMcpResponse);
  }

  createVideoEdit(input) {
    const { canvasId, ...body } = input;
    return this.request('POST', `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}/video-edits`, {
      requestId: body.requestId,
      body,
    }).then(fitMcpResponse);
  }

  getJob({ jobId }) {
    return this.request('GET', `/api/v2/jobs/${requireIdentifier(jobId, 'jobId')}`).then(fitMcpResponse);
  }

  async listArtifacts({ canvasId, nodeId, types, cursor, limit }) {
    const payload = await this.request(
      'GET',
      `/api/v2/canvases/${requireIdentifier(canvasId, 'canvasId')}/artifacts`,
      { query: { nodeId, type: types, cursor: upstreamCursor(cursor), limit } },
    );
    return fitMcpResponse(paginateResponse(payload, { cursor, limit, keys: ['artifacts'] }));
  }

  prepareDownload({ canvasId, artifactIds, archiveName, requestId }) {
    return this.request('POST', '/api/v2/downloads', {
      requestId,
      body: { canvasId, artifactIds, archiveName, requestId },
    }).then(fitMcpResponse);
  }
}
