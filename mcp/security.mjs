const OMIT = Symbol('omit');

const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'])(?:[a-zA-Z]:[\\/]|\\\\)[^\s"'<>]*/g;
const POSIX_ABSOLUTE_PATH = /\/(?:Users|home|var|private|tmp|opt|etc|mnt|srv|root)(?:\/[^\s"'<>]*)?/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const DATA_URL_PATTERN = /^data:[^;,]+(?:;base64)?,/i;

function shouldOmitKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('cookie') ||
    normalized.endsWith('path') ||
    normalized.endsWith('directory') ||
    ['command', 'args', 'endpoint', 'baseurl', 'providerurl', 'outputdir', 'saveroot'].includes(normalized)
  );
}

function sanitizeUrl(raw, baseOrigin) {
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== baseOrigin || parsed.username || parsed.password) return '[redacted-external-url]';
    for (const key of [...parsed.searchParams.keys()]) {
      if (shouldOmitKey(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.href;
  } catch {
    return '[redacted-external-url]';
  }
}

function sanitizeString(value, baseOrigin, maxStringLength) {
  if (DATA_URL_PATTERN.test(value)) return '[redacted-inline-data]';

  let result = value
    .replace(WINDOWS_ABSOLUTE_PATH, (match) => `${match[0]?.match(/\s|["']/) ? match[0] : ''}[redacted-path]`)
    .replace(POSIX_ABSOLUTE_PATH, '[redacted-path]')
    .replace(URL_PATTERN, (url) => sanitizeUrl(url, baseOrigin));

  if (result.length > maxStringLength) {
    result = `${result.slice(0, maxStringLength)}…[truncated ${result.length - maxStringLength} chars]`;
  }
  return result;
}

/**
 * Removes filesystem locations, credentials, provider endpoints and oversized inline data
 * before a REST response is exposed to an MCP client.
 */
export function sanitizeForMcp(value, options = {}) {
  const baseOrigin = new URL(options.baseUrl || 'http://127.0.0.1:8787').origin;
  const maxStringLength = Math.max(256, Number(options.maxStringLength || 4_000));
  const maxArrayLength = Math.max(1, Number(options.maxArrayLength || 100));
  const seen = new WeakSet();

  function visit(current, depth) {
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') return sanitizeString(current, baseOrigin, maxStringLength);
    if (typeof current !== 'object') return String(current);
    if (depth > 16) return '[truncated-depth]';
    if (seen.has(current)) return '[circular]';
    seen.add(current);

    if (Array.isArray(current)) {
      const limited = current.slice(0, maxArrayLength).map((item) => visit(item, depth + 1));
      if (current.length > maxArrayLength) {
        limited.push({ _mcpTruncatedItems: current.length - maxArrayLength });
      }
      return limited;
    }

    const result = {};
    for (const [key, item] of Object.entries(current)) {
      if (shouldOmitKey(key)) continue;
      const sanitized = visit(item, depth + 1);
      if (sanitized !== OMIT) result[key] = sanitized;
    }
    return result;
  }

  return visit(value, 0);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compact(value, arrayLimit, stringLimit, depth = 0) {
  if (typeof value === 'string') {
    return value.length <= stringLimit ? value : `${value.slice(0, stringLimit)}…[truncated]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > 10) return '[truncated-depth]';
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) => compact(item, arrayLimit, stringLimit, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compact(item, arrayLimit, stringLimit, depth + 1)]),
  );
}

/** Keeps a single tool result bounded even if an upstream endpoint ignores pagination. */
export function fitMcpResponse(value, maxBytes = 256 * 1024) {
  if (byteLength(value) <= maxBytes) return value;
  const preview = compact(value, 10, 1_000);
  if (byteLength(preview) <= maxBytes) {
    return {
      _mcpTruncated: true,
      hint: '结果超过 MCP 响应上限。请缩小 limit、增加搜索条件或使用 nextCursor 继续读取。',
      result: preview,
    };
  }
  return {
    _mcpTruncated: true,
    hint: '结果超过 MCP 响应上限。请缩小 limit 或增加搜索条件。',
    result: compact(value, 3, 256),
  };
}

function localCursor(offset) {
  return `mcp:${Buffer.from(String(offset), 'utf8').toString('base64url')}`;
}

function localOffset(cursor) {
  if (!cursor?.startsWith('mcp:')) return 0;
  try {
    const parsed = Number(Buffer.from(cursor.slice(4), 'base64url').toString('utf8'));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function upstreamCursor(cursor) {
  return cursor?.startsWith('mcp:') ? undefined : cursor;
}

/** Adds opaque local pagination when a v2 endpoint returns an unpaged array. */
export function paginateResponse(payload, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || 20)));
  const offset = localOffset(options.cursor);
  const keys = options.keys || [];

  if (Array.isArray(payload)) {
    return {
      items: payload.slice(offset, offset + limit),
      nextCursor: offset + limit < payload.length ? localCursor(offset + limit) : null,
      total: payload.length,
    };
  }

  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.items) && ('nextCursor' in payload || 'cursor' in payload)) return payload;
  if ('nextCursor' in payload && keys.some((key) => Array.isArray(payload[key]))) return payload;

  for (const key of keys) {
    if (!Array.isArray(payload[key])) continue;
    const values = payload[key];
    return {
      ...payload,
      [key]: values.slice(offset, offset + limit),
      page: {
        key,
        nextCursor: offset + limit < values.length ? localCursor(offset + limit) : null,
        total: values.length,
      },
    };
  }
  return payload;
}

export function safeErrorPayload(error) {
  const status = Number(error?.status || 0) || undefined;
  const code = String(error?.code || (status === 409 ? 'revision_conflict' : 'selfcanvas_error'));
  return {
    error: {
      code,
      message: sanitizeString(String(error?.message || 'SelfCanvas 请求失败'), 'http://127.0.0.1', 1_000),
      ...(status ? { status } : {}),
      ...(error?.details ? { details: error.details } : {}),
    },
  };
}
