import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { anyCapModel, anyCapDescriptor, anyCapParameters, normalizeAnyCapParameter, validateAnyCapReferences } from './anycapCatalog.mjs';
import {
  buildStoryboardRepairPrompt,
  buildStoryboardSystemPrompt,
  buildStoryboardUserPrompt,
  parseStoryboardResponse,
  storyboardToMarkdown,
} from './storyboardRuntime.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadDotEnv() {
  const envPaths = [
    path.join(rootDir, '.env'),
    path.join(process.env.HOME || '', '.codex', '.env'),
  ].filter(Boolean);
  return Promise.all(
    envPaths.map((envPath) =>
      fs.readFile(envPath, 'utf8').then((content) => {
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
          const index = trimmed.indexOf('=');
          const key = trimmed.slice(0, index).trim();
          let value = trimmed.slice(index + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = value;
        }
      }).catch(() => undefined),
    ),
  ).then(() => undefined);
}

export function outputDir() {
  const forcedRoot = String(process.env.SELF_CANVAS_STORAGE_ROOT || '').trim();
  if (forcedRoot) return path.resolve(forcedRoot, 'output');
  try {
    const config = JSON.parse(fsSync.readFileSync(path.join(rootDir, '.runtime', 'storage.json'), 'utf8'));
    if (typeof config.saveRoot === 'string' && config.saveRoot.trim()) {
      return path.resolve(config.saveRoot, 'output');
    }
  } catch {
    // Fall back to the environment/project output directory.
  }
  return path.resolve(rootDir, process.env.OUTPUT_DIR || 'output');
}

function outputUrl(filePath) {
  const relative = path.relative(outputDir(), filePath).split(path.sep).map(encodeURIComponent).join('/');
  return `/output/${relative}`;
}

function safeId(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function ensureOutputDir() {
  await fs.mkdir(outputDir(), { recursive: true });
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function mockImageUrl(prompt, index = 0) {
  const palettes = [
    ['#101522', '#4f7bff', '#70e1c8', '#f3bf6a'],
    ['#11101a', '#8173ff', '#d1c5ff', '#70e1c8'],
    ['#0c1518', '#70e1c8', '#4f7bff', '#f3bf6a'],
  ];
  const palette = palettes[index % palettes.length];
  const title = escapeXml((prompt.trim() || 'SelfCanvas local result').slice(0, 48));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="1" stop-color="#06070a"/></linearGradient><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[1]}"/><stop offset="1" stop-color="${palette[2]}"/></linearGradient></defs><rect width="640" height="420" fill="url(#bg)"/><rect x="48" y="48" width="544" height="324" rx="28" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)"/><circle cx="180" cy="158" r="72" fill="url(#a)" opacity="0.94"/><rect x="282" y="112" width="216" height="34" rx="17" fill="${palette[3]}" opacity="0.92"/><rect x="282" y="168" width="156" height="22" rx="11" fill="rgba(255,255,255,0.64)"/><path d="M82 332 C178 236 251 346 338 258 C430 164 498 297 578 218" fill="none" stroke="${palette[2]}" stroke-width="8" stroke-linecap="round" opacity="0.76"/><text x="64" y="386" fill="#f6f7fb" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">${title}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function endpoint(baseUrl, apiPath) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(apiPath.replace(/^\//, ''), base).toString();
}

function readErrorMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  if ('message' in data) return String(data.message);
  return fallback;
}

function providerErrorMessage(label, status, raw) {
  const message = String(raw || '').trim() || `HTTP ${status}`;
  if (/API key is required|Missing bearer|basic authentication|Authorization header/i.test(message)) {
    return `${label} 未读取到 API Key。请确认 .env 已配置并重试。`;
  }
  if (status === 503 && message.includes('No available compatible accounts')) {
    return `${label} 已连接，但没有可服务该模型的账号/渠道。请先配置兼容账号。`;
  }
  return `${label} ${status}: ${message}`;
}

function optionsOf(payload) {
  return payload.options && typeof payload.options === 'object' ? payload.options : {};
}

function referencesOf(payload) {
  return Array.isArray(payload.references) ? payload.references : [];
}

function withReferenceContext(prompt, payload) {
  const refs = referencesOf(payload);
  if (!refs.length) return prompt;
  const lines = refs.map((ref, index) => {
    const label = ref.title || ref.nodeId || `reference ${index + 1}`;
    const type = ref.outputType || ref.kind || 'asset';
    const locator = ref.path || ref.url || '';
    const content = type === 'text' ? String(ref.content || '').trim() : '';
    return [
      `- @${label} (${type})${locator ? `: ${locator}` : ''}`,
      content ? `  正文：\n${content}` : '',
    ].filter(Boolean).join('\n');
  });
  return `${prompt}\n\n引用素材：\n${lines.join('\n')}`;
}

function numberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringOption(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function existingReferencePaths(payload, outputType) {
  const paths = referencesOf(payload)
    .filter((ref) => ref.outputType === outputType && ref.path)
    .map((ref) => path.resolve(String(ref.path)));
  const uniquePaths = [...new Set(paths)];
  for (const filePath of uniquePaths) {
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`引用素材文件不存在：${filePath}`);
    }
  }
  return uniquePaths;
}

function addAnyCapParam(args, key, value) {
  if (value === undefined || value === null || value === '' || value === 'adaptive') return;
  args.push('--param', `${key}=${value}`);
}

function addAnyCapJsonParam(args, key, values) {
  if (!Array.isArray(values) || !values.length) return;
  args.push('--param', `${key}=${JSON.stringify(values)}`);
}

function videoModelKey(model) {
  return String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalVideoModel(model) {
  const original = String(model || '').trim();
  const aliases = {
    h3: 'minimax-h3',
    minimaxh3: 'minimax-h3',
    seedance2mini: 'seedance-2-mini',
    seedance25: 'seedance-2.5',
    seedance2: 'seedance-2',
    seedance20: 'seedance-2',
    seedance20fast: 'seedance-2-fast',
    seedance2fast: 'seedance-2-fast',
    seedancefsat: 'seedance-2-fast',
    seedance15pro: 'seedance-1.5-pro',
    seedance15: 'seedance-1.5-pro',
    seedance2pro: 'seedance-2',
    kling30: 'kling-3.0',
    kling3: 'kling-3.0',
    kling30omni: 'kling-3.0-omni',
    kling3omni: 'kling-3.0-omni',
    klingo1: 'kling-o1',
    kling21: 'kling-3.0',
    veo31: 'veo-3.1',
    veo31fast: 'veo-3.1-fast',
    veo3: 'veo-3.1',
    sora2: 'sora-2-pro',
    sora2pro: 'sora-2-pro',
    hailuo23: 'hailuo-2.3',
    geminiomniflashpreview: 'gemini-omni-flash-preview',
  };
  return aliases[videoModelKey(original)] || original;
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

const noMediaLimits = { image: 0, video: 0, audio: 0 };
const seedanceRatios = ['16:9', '3:4', '21:9', '9:16', '4:3', '1:1'];

const videoCapabilities = {
  'seedance-2.5': {
    supportsGenerateAudio: true,
    mode: 'multi-modal-reference',
    modes: ['multi-modal-reference', 'image-to-video', 'text-to-video'],
    resolutions: ['480p', '720p', '1080p'],
    durations: range(4, 15),
    defaultDuration: 6,
    aspectRatios: ['3:4', '21:9', '9:16', '16:9', '4:3', '1:1'],
    references: { image: 9, video: 3, audio: 3 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 0, audio: 0 },
      'multi-modal-reference': { image: 9, video: 3, audio: 3 },
    },
  },
  'seedance-2-fast': {
    supportsGenerateAudio: true,
    mode: 'multi-modal-reference',
    modes: ['multi-modal-reference', 'image-to-video', 'text-to-video'],
    resolutions: ['480p', '720p'],
    durations: range(4, 15),
    defaultDuration: 6,
    aspectRatios: seedanceRatios,
    references: { image: 9, video: 3, audio: 3 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-modal-reference': { image: 9, video: 3, audio: 3 },
    },
  },
  'seedance-2': {
    supportsGenerateAudio: true,
    mode: 'multi-modal-reference',
    modes: ['multi-modal-reference', 'image-to-video', 'text-to-video'],
    resolutions: ['480p', '720p', '1080p', '4k'],
    durations: range(4, 15),
    defaultDuration: 6,
    aspectRatios: ['3:4', '21:9', '9:16', '16:9', '4:3', '1:1'],
    references: { image: 9, video: 3, audio: 3 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-modal-reference': { image: 9, video: 3, audio: 3 },
    },
  },
  'seedance-1.5-pro': {
    supportsGenerateAudio: true,
    mode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    resolutions: ['480p', '720p'],
    durations: range(4, 12),
    defaultDuration: 6,
    aspectRatios: seedanceRatios,
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-3.0': {
    supportsGenerateAudio: true,
    mode: 'multi-shot-video',
    modes: ['multi-shot-video', 'image-to-video', 'text-to-video'],
    resolutions: ['720p', '1080p', '4k'],
    durations: range(3, 15),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '4:3', '3:4'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-shot-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-3.0-omni': {
    supportsGenerateAudio: true,
    mode: 'multi-shot-video',
    modes: ['multi-shot-video', 'image-to-video', 'text-to-video'],
    resolutions: ['720p', '1080p'],
    durations: range(3, 15),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '1:1'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-shot-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-o1': {
    mode: 'image-to-video',
    modes: ['image-to-video'],
    resolutions: ['720p'],
    durations: range(5, 10),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '1:1'],
    references: { image: 9, video: 0, audio: 0 },
  },
  'veo-3.1': {
    mode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    resolutions: ['720p', '1080p'],
    durations: [6, 8],
    defaultDuration: 6,
    aspectRatios: ['9:16', '16:9'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'veo-3.1-fast': {
    mode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    resolutions: ['720p', '1080p'],
    durations: [4, 6, 8],
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'sora-2-pro': {
    mode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    resolutions: ['720p', '1080p'],
    durations: [4, 8, 12],
    defaultDuration: 8,
    aspectRatios: ['16:9', '9:16'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'hailuo-2.3': {
    mode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    resolutions: ['1080p'],
    durations: [10],
    defaultDuration: 10,
    aspectRatios: ['16:9', '9:16'],
    references: { image: 9, video: 0, audio: 0 },
    referencesByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'gemini-omni-flash-preview': {
    mode: 'edit-video',
    modes: ['edit-video'],
    resolutions: [],
    durations: range(3, 10),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16'],
    references: { image: 0, video: 3, audio: 0 },
  },
};

const defaultVideoCapability = {
  mode: 'text-to-video',
  modes: ['text-to-video', 'image-to-video'],
  resolutions: ['720p'],
  durations: [6, 8, 10],
  defaultDuration: 6,
  aspectRatios: ['16:9', '9:16'],
  references: { image: 1, video: 0, audio: 0 },
  referencesByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 1, video: 0, audio: 0 } },
};

function videoCapability(model) {
  return anyCapDescriptor(canonicalVideoModel(model)) || videoCapabilities[canonicalVideoModel(model)] || defaultVideoCapability;
}

function videoReferenceLimits(model, mode) {
  const capability = videoCapability(model);
  const resolvedMode = capability.modes.includes(mode) ? mode : capability.mode;
  return capability.referencesByMode?.[resolvedMode] || capability.references || {};
}

function splitShotPrompts(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return [];
  const blocks = text
    .split(/\n\s*\n|^---+$|^\*\*\*+$/m)
    .map((item) => item.trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;
  const shotLines = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /^(shot|scene|镜头|分镜|第\s*\d+\s*镜|\d+[.、:：])/i.test(item));
  return shotLines.length > 1 ? shotLines : blocks;
}

function buildMultiShotClips(payload, options) {
  const prompts = splitShotPrompts(payload.prompt || 'cinematic short video');
  if (!prompts.length) return [];
  const shotCount = Math.max(1, Math.min(12, Math.round(numberOption(options.shotCount, prompts.length))));
  const selectedPrompts = prompts.slice(0, shotCount);
  const totalDuration = Math.max(selectedPrompts.length, Math.round(numberOption(options.duration, selectedPrompts.length * 2)));
  const baseDuration = Math.max(1, Math.floor(totalDuration / selectedPrompts.length));
  let used = 0;
  return selectedPrompts.map((clipPrompt, index) => {
    const remainingClips = selectedPrompts.length - index;
    const remainingDuration = Math.max(remainingClips, totalDuration - used);
    const duration = index === selectedPrompts.length - 1
      ? remainingDuration
      : Math.min(baseDuration, remainingDuration - (remainingClips - 1));
    used += duration;
    return { index, prompt: clipPrompt, duration };
  });
}

function defaultVideoMode(model, options, mediaCounts, multiShotClips) {
  const capability = videoCapability(model);
  const explicitMode = stringOption(options.mode);
  if (explicitMode && capability.modes.includes(explicitMode)) return explicitMode;
  if (multiShotClips.length && capability.modes.includes('multi-shot-video')) return 'multi-shot-video';
  if ((mediaCounts.images || mediaCounts.videos || mediaCounts.audios) && capability.modes.includes('multi-modal-reference')) {
    return 'multi-modal-reference';
  }
  if ((mediaCounts.images || mediaCounts.videos) && capability.modes.includes('image-to-video')) return 'image-to-video';
  if (mediaCounts.videos && capability.modes.includes('edit-video')) return 'edit-video';
  const envMode = process.env.ANYCAP_VIDEO_MODE || '';
  if (capability.modes.includes(envMode)) return envMode;
  return capability.mode || 'text-to-video';
}

function closestNumberOption(options, value, fallback) {
  if (!Array.isArray(options) || !options.length) return fallback;
  const target = numberOption(value, fallback);
  return options.reduce((best, item) => Math.abs(item - target) < Math.abs(best - target) ? item : best, options[0]);
}

function allowedStringOption(options, value, fallback = '') {
  const text = stringOption(value);
  if (Array.isArray(options) && options.includes(text)) return text;
  return fallback;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function fetchOpenAICompatibleApi({ apiPath, body, baseUrl, apiKey, label }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint(baseUrl, apiPath), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const raw = readErrorMessage(data, response.statusText);
    throw new Error(providerErrorMessage(label, response.status, raw));
  }
  return data;
}

async function fetchSub2Api(apiPath, body) {
  await loadDotEnv();
  return fetchOpenAICompatibleApi({
    apiPath,
    body,
    baseUrl: process.env.SUB2API_BASE_URL || 'http://10.0.0.239:3000',
    apiKey: process.env.SUB2API_API_KEY || '',
    label: 'Sub2API',
  });
}

async function fetchDirectOpenAICompatible(apiPath, body) {
  await loadDotEnv();
  const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || '';
  return fetchOpenAICompatibleApi({
    apiPath,
    body,
    baseUrl,
    apiKey,
    label: 'OpenAI Compatible',
  });
}

function remoteMediaTrustedOrigins() {
  const configured = [
    process.env.SUB2API_BASE_URL,
    process.env.OPENAI_COMPATIBLE_BASE_URL,
    process.env.OPENAI_BASE_URL,
    ...(process.env.SELF_CANVAS_REMOTE_MEDIA_ORIGINS || '').split(','),
  ];
  const origins = new Set();
  for (const value of configured) {
    try {
      if (String(value || '').trim()) origins.add(new URL(String(value).trim()).origin);
    } catch {
      // Ignore malformed optional configuration; the provider request itself reports it separately.
    }
  }
  return origins;
}

function isUnsafeIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isUnsafeIpAddress(address) {
  const normalized = String(address || '').trim().toLowerCase().split('%', 1)[0];
  const version = net.isIP(normalized);
  if (version === 4) return isUnsafeIpv4(normalized);
  if (version !== 6) return true;
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? isUnsafeIpv4(mapped[1]) : false;
}

export async function validateRemoteMediaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('供应商返回了无效媒体 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 4096) {
    throw new Error('供应商媒体 URL 协议或格式不受支持');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const blockedNames = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'instance-data']);
  const trustedOrigin = remoteMediaTrustedOrigins().has(parsed.origin);
  if (blockedNames.has(hostname.toLowerCase()) && !trustedOrigin) {
    throw new Error('拒绝下载指向本机或 metadata 的供应商媒体 URL');
  }
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname }];
  else {
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('供应商媒体域名无法解析');
    }
  }
  if (!addresses.length || (!trustedOrigin && addresses.some((item) => isUnsafeIpAddress(item.address)))) {
    throw new Error('拒绝下载指向私网、回环或保留地址的供应商媒体 URL');
  }
  return {
    url: parsed,
    addresses: addresses.map((item) => ({
      address: item.address,
      family: Number(item.family || net.isIP(item.address)),
    })),
  };
}

function pinnedRemoteMediaAgent(validation) {
  const expectedHostname = validation.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const candidates = validation.addresses.filter((item) => item.family === 4 || item.family === 6);
  if (!candidates.length) throw new Error('供应商媒体域名没有可用地址');
  let cursor = 0;
  return new Agent({
    connect: {
      autoSelectFamily: false,
      lookup(hostname, _options, callback) {
        const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
        if (normalized !== expectedHostname) {
          callback(new Error('供应商媒体连接主机与已校验主机不一致'));
          return;
        }
        const candidate = candidates[cursor % candidates.length];
        cursor += 1;
        callback(null, candidate.address, candidate.family);
      },
    },
  });
}

async function fetchRemoteMedia(rawUrl, signal) {
  let validation = await validateRemoteMediaUrl(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const dispatcher = pinnedRemoteMediaAgent(validation);
    let response;
    try {
      response = await undiciFetch(validation.url, { redirect: 'manual', signal, dispatcher });
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      if (!location || redirects === 4) throw new Error('供应商媒体重定向无效或次数过多');
      validation = await validateRemoteMediaUrl(new URL(location, validation.url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      throw new Error(`下载生成文件失败：${response.status}`);
    }
    return { response, dispatcher };
  }
  throw new Error('供应商媒体重定向次数过多');
}

function detectedImageExtension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(?:avif|avis)$/.test(bytes.subarray(8, 12).toString('ascii'))) return 'avif';
  return '';
}

function remoteMediaMaxBytes() {
  const megabytes = Number(process.env.SELF_CANVAS_REMOTE_MEDIA_MAX_MB || 64);
  return Math.max(1, Math.min(512, Number.isFinite(megabytes) ? megabytes : 64)) * 1024 * 1024;
}

export async function persistRemoteFile(url, jobId, fallbackExtension = 'png') {
  await ensureOutputDir();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('供应商媒体下载超时')), 60_000);
  const temporary = path.join(outputDir(), `.${safeId(jobId)}-${crypto.randomUUID()}.part`);
  let handle;
  let dispatcher;
  let remoteResponse;
  try {
    const remote = await fetchRemoteMedia(url, controller.signal);
    const response = remote.response;
    remoteResponse = response;
    dispatcher = remote.dispatcher;
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType && !['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'application/octet-stream'].includes(contentType)) {
      throw new Error(`供应商返回了不支持的媒体类型：${contentType}`);
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    const maxBytes = remoteMediaMaxBytes();
    if (declaredSize > maxBytes) throw new Error(`供应商媒体超过 ${Math.round(maxBytes / 1024 / 1024)} MB 安全上限`);
    if (!response.body) throw new Error('供应商媒体响应为空');
    handle = await fs.open(temporary, 'wx');
    let size = 0;
    let header = Buffer.alloc(0);
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(`供应商媒体超过 ${Math.round(maxBytes / 1024 / 1024)} MB 安全上限`);
      if (header.length < 32) header = Buffer.concat([header, chunk]).subarray(0, 32);
      await handle.write(chunk);
    }
    await handle.close();
    handle = undefined;
    if (!size) throw new Error('供应商媒体内容为空');
    const detectedExtension = detectedImageExtension(header);
    if (!detectedExtension) throw new Error('供应商媒体内容不是受支持的 PNG/JPEG/WebP/AVIF 图片');
    const requestedFallback = ['png', 'jpg', 'webp', 'avif'].includes(fallbackExtension) ? fallbackExtension : 'png';
    const extension = detectedExtension || requestedFallback;
    const filePath = path.join(outputDir(), `${safeId(jobId)}.${extension}`);
    await fs.rename(temporary, filePath);
    return outputUrl(filePath);
  } catch (error) {
    await remoteResponse?.body?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close().catch(() => undefined);
  }
}

export async function runSub2Text(job, payload) {
  await job.updateProgress(18);
  const options = optionsOf(payload);
  const model = stringOption(options.model, process.env.SUB2API_TEXT_MODEL || payload.model || 'gpt-4o-mini');
  const prompt = withReferenceContext(payload.prompt || '生成一段创作文本。', payload);
  const data = await fetchSub2Api('/v1/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content:
          stringOption(options.systemPrompt) ||
          '你是 selfcanvas 的文本生成节点，输出直接可放进创作画布的中文内容。',
      },
      { role: 'user', content: prompt },
    ],
    temperature: numberOption(options.temperature, 0.8),
  });
  await job.updateProgress(90);
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!text) throw new Error('Sub2API 返回成功，但没有文本内容。');
  return {
    text: String(text).trim(),
  };
}

export async function runOpenAICompatibleText(job, payload) {
  await job.updateProgress(18);
  const options = optionsOf(payload);
  const model = stringOption(options.model, process.env.OPENAI_COMPATIBLE_TEXT_MODEL || payload.model || 'gpt-4o-mini');
  const prompt = withReferenceContext(payload.prompt || '生成一段创作文本。', payload);
  const data = await fetchDirectOpenAICompatible('/v1/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content:
          stringOption(options.systemPrompt) ||
          '你是 selfcanvas 的文本生成节点，输出直接可放进创作画布的中文内容。',
      },
      { role: 'user', content: prompt },
    ],
    temperature: numberOption(options.temperature, 0.8),
  });
  await job.updateProgress(90);
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!text) throw new Error('OpenAI Compatible 返回成功，但没有文本内容。');
  return {
    text: String(text).trim(),
  };
}

export async function runStructuredStoryboard(job, payload, fetcher, label) {
  await job.updateProgress(18);
  const options = optionsOf(payload);
  const expectedCount = Math.max(1, Math.min(20, Math.round(numberOption(options.shotCount, 5))));
  const model = stringOption(
    options.model,
    label === 'Sub2API'
      ? process.env.SUB2API_STORYBOARD_MODEL || payload.model || 'gpt-5.5'
      : process.env.OPENAI_COMPATIBLE_STORYBOARD_MODEL || payload.model || 'gpt-5.5',
  );
  const systemPrompt = buildStoryboardSystemPrompt(expectedCount, stringOption(options.systemPrompt));
  const userPrompt = buildStoryboardUserPrompt(payload);
  const request = async (messages) => {
    const data = await fetcher('/v1/chat/completions', {
      model,
      messages,
      temperature: numberOption(options.temperature, 0.7),
    });
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
    if (!content) throw new Error(`${label} 返回成功，但没有分镜内容。`);
    return String(content).trim();
  };

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const first = await request(messages);
  await job.updateProgress(68);
  let storyboard;
  try {
    storyboard = parseStoryboardResponse(first, expectedCount);
  } catch (firstError) {
    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    const repaired = await request([
      ...messages,
      { role: 'assistant', content: first },
      { role: 'user', content: buildStoryboardRepairPrompt(first, expectedCount, reason) },
    ]);
    try {
      storyboard = parseStoryboardResponse(repaired, expectedCount);
    } catch (repairError) {
      throw new Error(`分镜 JSON 自动修复失败：${repairError instanceof Error ? repairError.message : String(repairError)}`);
    }
  }
  await job.updateProgress(92);
  return { storyboard, text: storyboardToMarkdown(storyboard) };
}

export function runSub2Storyboard(job, payload) {
  return runStructuredStoryboard(job, payload, fetchSub2Api, 'Sub2API');
}

export function runOpenAICompatibleStoryboard(job, payload) {
  return runStructuredStoryboard(job, payload, fetchDirectOpenAICompatible, 'OpenAI Compatible');
}

export async function runSub2Image(job, payload) {
  await job.updateProgress(18);
  const options = optionsOf(payload);
  const model = stringOption(options.model, process.env.SUB2API_IMAGE_MODEL || payload.model || 'gpt-image-2');
  const size = stringOption(options.size, process.env.SUB2API_IMAGE_SIZE || '1024x1024');
  const responseFormat = stringOption(options.responseFormat, 'url');
  const prompt = withReferenceContext(payload.prompt || 'cinematic reference image', payload);
  const body = {
    model,
    prompt,
    size,
    n: Math.max(1, Math.min(4, Math.round(numberOption(options.count, 1)))),
    response_format: responseFormat,
  };
  const outputFormat = stringOption(options.outputFormat);
  const quality = stringOption(options.quality);
  if (outputFormat && outputFormat !== 'png') body.output_format = outputFormat;
  if (quality && quality !== 'standard') body.quality = quality;
  if (options.transparentBackground === true) body.background = 'transparent';
  const data = await fetchSub2Api('/v1/images/generations', body);
  await job.updateProgress(78);
  const first = data?.data?.[0];
  if (!first) throw new Error('Sub2API 返回成功，但没有图像数据。');
  if (first.url) {
    try {
      const localUrl = await persistRemoteFile(first.url, job.id, 'png');
      return { imageUrl: localUrl, fileUrl: localUrl, text: 'Sub2API 图像已生成。' };
    } catch (error) {
      throw new Error(`Sub2API 图像已生成，但无法安全落盘，暂不可预览或下载：${error?.message || error}`);
    }
  }
  if (first.b64_json) {
    await ensureOutputDir();
    const filePath = path.join(outputDir(), `${safeId(job.id)}.png`);
    await fs.writeFile(filePath, Buffer.from(first.b64_json, 'base64'));
    const localUrl = outputUrl(filePath);
    return { imageUrl: localUrl, fileUrl: localUrl, text: 'Sub2API 图像已生成。' };
  }
  throw new Error('Sub2API 返回成功，但图像既没有 url 也没有 b64_json。');
}

export async function runOpenAICompatibleImage(job, payload) {
  await job.updateProgress(18);
  const options = optionsOf(payload);
  const model = stringOption(options.model, process.env.OPENAI_COMPATIBLE_IMAGE_MODEL || payload.model || 'gpt-image-2');
  const size = stringOption(options.size, process.env.OPENAI_COMPATIBLE_IMAGE_SIZE || '1024x1024');
  const responseFormat = stringOption(options.responseFormat, 'url');
  const prompt = withReferenceContext(payload.prompt || 'cinematic reference image', payload);
  const body = {
    model,
    prompt,
    size,
    n: Math.max(1, Math.min(4, Math.round(numberOption(options.count, 1)))),
    response_format: responseFormat,
  };
  const outputFormat = stringOption(options.outputFormat);
  const quality = stringOption(options.quality);
  if (outputFormat && outputFormat !== 'png') body.output_format = outputFormat;
  if (quality && quality !== 'standard') body.quality = quality;
  if (options.transparentBackground === true) body.background = 'transparent';
  const data = await fetchDirectOpenAICompatible('/v1/images/generations', body);
  await job.updateProgress(78);
  const first = data?.data?.[0];
  if (!first) throw new Error('OpenAI Compatible 返回成功，但没有图像数据。');
  if (first.url) {
    try {
      const localUrl = await persistRemoteFile(first.url, job.id, 'png');
      return { imageUrl: localUrl, fileUrl: localUrl, text: 'OpenAI Compatible 图像已生成。' };
    } catch (error) {
      throw new Error(`OpenAI Compatible 图像已生成，但无法安全落盘，暂不可预览或下载：${error?.message || error}`);
    }
  }
  if (first.b64_json) {
    await ensureOutputDir();
    const filePath = path.join(outputDir(), `${safeId(job.id)}.png`);
    await fs.writeFile(filePath, Buffer.from(first.b64_json, 'base64'));
    const localUrl = outputUrl(filePath);
    return { imageUrl: localUrl, fileUrl: localUrl, text: 'OpenAI Compatible 图像已生成。' };
  }
  throw new Error('OpenAI Compatible 返回成功，但图像既没有 url 也没有 b64_json。');
}

export function commandErrorMessage(command, stdout, stderr, code) {
  const raw = String(stderr || stdout || '').trim();
  const candidates = [raw, ...raw.split(/\r?\n/).reverse()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      const message = String(payload.message || payload.error_description || '').trim();
      const errorCode = String(payload.error || payload.code || '').trim();
      const traceId = String(payload.trace_id || payload.request_id || '').trim();
      if (command.toLowerCase().includes('anycap') && (errorCode === 'connection_error' || /\bEOF\b/i.test(message))) {
        return `AnyCap 视频服务连接临时中断（EOF）。本地参数没有问题，请稍后点击“生成”重试。${traceId ? ` 追踪号：${traceId}` : ''}`;
      }
      if (message) return traceId ? `${message}（追踪号：${traceId}）` : message;
    } catch {
      // Continue to the next possible JSON line, then fall back to raw output.
    }
  }
  return raw || `${command} exited with ${code}`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(commandErrorMessage(command, stdout, stderr, code)));
    });
  });
}

async function runWithSyntheticProgress(job, start, cap, task) {
  let progress = start;
  await job.updateProgress(progress);
  const timer = setInterval(() => {
    progress = Math.min(cap, progress + 3);
    void job.updateProgress(progress);
  }, 2500);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

function parseAnyCapLocalPath(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const data = parsed.data || parsed;
    const candidates = [
      data.local_path,
      data.path,
      data.output,
      data.outputs?.[0]?.local_path,
      data.outputs?.[0]?.path,
      data.files?.[0]?.local_path,
    ].filter(Boolean);
    return candidates[0] ? path.resolve(rootDir, String(candidates[0])) : '';
  } catch {
    return '';
  }
}

async function readIncomingBody(request, maximumBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error('AnyCap 本地能力桥接请求过大');
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export async function startAnyCapCapabilityBridge(sourceCapability, targetCapability) {
  const upstream = new URL(process.env.ANYCAP_ENDPOINT || 'https://api.anycap.ai');
  const sourcePrefix = `/v1/${sourceCapability}`;
  const targetPrefix = `/v1/${targetCapability}`;
  const server = http.createServer(async (request, response) => {
    try {
      const incomingUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const mappedPath = incomingUrl.pathname.startsWith(sourcePrefix)
        ? `${targetPrefix}${incomingUrl.pathname.slice(sourcePrefix.length)}`
        : incomingUrl.pathname;
      const targetUrl = new URL(`${mappedPath}${incomingUrl.search}`, upstream);
      const headers = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (!value || ['host', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readIncomingBody(request);
      const upstreamResponse = await undiciFetch(targetUrl, {
        method: request.method || 'GET',
        headers,
        body,
        redirect: 'manual',
      });
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, key) => {
        if (!['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(key.toLowerCase())) {
          response.setHeader(key, value);
        }
      });
      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      response.setHeader('content-length', String(responseBody.byteLength));
      response.end(responseBody);
    } catch (error) {
      const body = Buffer.from(JSON.stringify({
        status: 'error',
        error: { code: 'SELFCANVAS_CAPABILITY_BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) },
      }));
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.setHeader('content-length', String(body.byteLength));
      response.end(body);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('AnyCap 本地能力桥接启动失败');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function runAnyCapImage(job, payload) {
  await ensureOutputDir();
  const options = optionsOf(payload);
  const model = stringOption(
    options.model,
    process.env.ANYCAP_IMAGE_MODEL || (payload.model && !payload.model.startsWith('mock') ? payload.model : '') || 'nano-banana-2',
  );
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const imagePaths = await existingReferencePaths(payload, 'image');
  const requestedMode = stringOption(options.mode);
  const mode = requestedMode || (imagePaths.length ? 'image-to-image' : 'text-to-image');
  const parameters = anyCapParameters(model, mode);
  if (!parameters) throw new Error(`${model} 的图片参数尚未同步，请先刷新 AnyCap 模型列表`);
  validateAnyCapReferences(model, mode, {
    image: imagePaths.length, video: (await existingReferencePaths(payload, 'video')).length,
    audio: (await existingReferencePaths(payload, 'audio')).length,
  });
  const format = normalizeAnyCapParameter(parameters.format, stringOption(options.outputFormat, 'png')) || 'png';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.${format}`);
  const args = [
    'image',
    'generate',
    '--model',
    model,
    '--mode',
    mode,
    '--prompt',
    withReferenceContext(payload.prompt || 'cinematic reference image', payload),
    '-o',
    filePath,
  ];
  addAnyCapParam(args, 'aspect_ratio', normalizeAnyCapParameter(parameters.aspect_ratio, options.aspectRatio));
  addAnyCapParam(args, 'resolution', normalizeAnyCapParameter(parameters.resolution, String(options.resolutionTier || '').toLowerCase()));
  addAnyCapParam(args, 'format', normalizeAnyCapParameter(parameters.format, format));
  if (imagePaths.length) addAnyCapJsonParam(args, 'images', imagePaths);
  const result = await runWithSyntheticProgress(job, 18, 92, () => runCommand(bin, args));
  try {
    await fs.access(filePath);
  } catch {
    const localPath = parseAnyCapLocalPath(result.stdout);
    if (localPath) await fs.copyFile(localPath, filePath);
  }
  await fs.access(filePath);
  const localUrl = outputUrl(filePath);
  return {
    imageUrl: localUrl,
    fileUrl: localUrl,
    text: `AnyCap 图片已生成：${model}`,
  };
}

export async function runAnyCapVideo(job, payload) {
  await ensureOutputDir();
  const options = optionsOf(payload);
  const model = canonicalVideoModel(
    stringOption(options.model) ||
    (payload.model && !payload.model.startsWith('mock') ? payload.model : '') ||
    process.env.ANYCAP_VIDEO_MODEL ||
    'seedance-2-fast',
  );
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.mp4`);
  let capability = videoCapability(model);
  const imagePaths = await existingReferencePaths(payload, 'image');
  const videoPaths = await existingReferencePaths(payload, 'video');
  const audioPaths = await existingReferencePaths(payload, 'audio');
  const multiShotClips = capability.modes.includes('multi-shot-video') ? buildMultiShotClips(payload, options) : [];
  const mode = defaultVideoMode(
    model,
    options,
    { images: imagePaths.length, videos: videoPaths.length, audios: audioPaths.length },
    multiShotClips,
  );
  const parameters = anyCapParameters(model, mode);
  if (!parameters) throw new Error(`${model} 的视频参数尚未同步，请先刷新 AnyCap 模型列表`);
  capability = { ...capability, ...capability.modeOptions?.[mode] };
  validateAnyCapReferences(model, mode, { image: imagePaths.length, video: videoPaths.length, audio: audioPaths.length });
  const limits = videoReferenceLimits(model, mode);
  const labels = { image: '参考图', video: '参考视频', audio: '参考音频' };
  for (const [type, count] of Object.entries({ image: imagePaths.length, video: videoPaths.length, audio: audioPaths.length })) {
    const limit = Number(limits[type] || 0);
    if (count > limit) {
      if (limit <= 0) throw new Error(`${model} 的 ${mode} 模式暂不支持${labels[type]}`);
      throw new Error(`${model} 最多支持 ${limit} 个${labels[type]}`);
    }
  }
  const resolution = allowedStringOption(capability.resolutions, options.resolution, capability.resolutions[0]);
  const duration = closestNumberOption(capability.durations, options.duration, numberOption(options.duration, capability.defaultDuration));
  const aspectRatio = allowedStringOption(capability.aspectRatios, options.aspectRatio, '');
  const args = [
    'video',
    'generate',
    '--model',
    model,
    '--mode',
    mode,
    '--prompt',
    withReferenceContext(payload.prompt || 'cinematic short video', payload),
    '-o',
    filePath,
  ];
  addAnyCapParam(args, 'resolution', normalizeAnyCapParameter(parameters.resolution, resolution || options.resolution));
  addAnyCapParam(args, 'duration', normalizeAnyCapParameter(parameters.duration, duration));
  addAnyCapParam(args, 'aspect_ratio', normalizeAnyCapParameter(parameters.aspect_ratio, stringOption(options.aspectRatio) || aspectRatio));
  addAnyCapParam(args, 'format', normalizeAnyCapParameter(parameters.format, stringOption(options.format, 'mp4')));
  addAnyCapParam(args, 'fps', normalizeAnyCapParameter(parameters.fps, options.fps));
  if (capability.supportsGenerateAudio && typeof options.generateAudio === 'boolean') {
    addAnyCapParam(args, 'generate_audio', String(options.generateAudio));
  }
  if (parameters.first_frame && parameters.last_frame) {
    addAnyCapParam(args, 'first_frame', imagePaths[0]);
    addAnyCapParam(args, 'last_frame', imagePaths[1]);
  } else if ((limits.image ?? 0) > 0 && mode !== 'text-to-video') {
    addAnyCapJsonParam(args, 'images', imagePaths);
  }
  if ((limits.video ?? 0) > 0 && mode !== 'text-to-video') {
    addAnyCapJsonParam(args, 'videos', videoPaths);
  }
  if ((limits.audio ?? 0) > 0 && mode !== 'text-to-video') {
    addAnyCapJsonParam(args, 'audios', audioPaths);
  }
  if (mode === 'multi-shot-video') {
    addAnyCapJsonParam(args, 'multi_shot_clips', multiShotClips);
  }
  const result = await runWithSyntheticProgress(job, 18, 92, () => runCommand(bin, args));
  try {
    await fs.access(filePath);
  } catch {
    const localPath = parseAnyCapLocalPath(result.stdout);
    if (localPath) await fs.copyFile(localPath, filePath);
  }
  await fs.access(filePath);
  const localUrl = outputUrl(filePath);
  return {
    videoUrl: localUrl,
    fileUrl: localUrl,
    text: `AnyCap 视频已生成：${model}`,
  };
}

export async function runAnyCapAudio(job, payload) {
  const options = optionsOf(payload);
  const requestedModel = stringOption(options.model) || stringOption(payload.model) || process.env.ANYCAP_AUDIO_MODEL || 'doubao-seed-audio-1-0';
  const model = anyCapModel(requestedModel === 'anycap-audio' ? 'elevanlabs-music' : requestedModel)?.id;
  if (!model) {
    throw new Error('AnyCap 音频模型未配置。请在 .env 设置 ANYCAP_AUDIO_MODEL 后再运行音频节点。');
  }
  await ensureOutputDir();
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const descriptor = anyCapDescriptor(model);
  const isDoubaoAudio = descriptor.capability === 'audio';
  const format = isDoubaoAudio && ['mp3', 'wav'].includes(stringOption(options.format).toLowerCase())
    ? stringOption(options.format).toLowerCase()
    : 'mp3';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.${format}`);
  const audioPaths = await existingReferencePaths(payload, 'audio');
  const imagePaths = await existingReferencePaths(payload, 'image');
  const mode = descriptor.modes.includes(stringOption(options.mode)) ? stringOption(options.mode) : descriptor.mode;
  const parameters = descriptor.parametersByMode[mode];
  validateAnyCapReferences(model, mode, {
    image: imagePaths.length, audio: audioPaths.length, video: (await existingReferencePaths(payload, 'video')).length,
  });
  if (parameters.prompt?.maxLength && String(payload.prompt || '').length > parameters.prompt.maxLength) {
    throw new Error(`${model} 提示词最多 ${parameters.prompt.maxLength} 个字符`);
  }
  const args = [
    descriptor.capability,
    'generate',
    '--model',
    model,
    '--mode',
    mode,
    '--prompt',
    withReferenceContext(payload.prompt || 'soft background score', payload),
    '-o',
    filePath,
  ];
  if (isDoubaoAudio) {
    for (const [parameter, value] of Object.entries({ format, sample_rate: options.sampleRate ?? 24000,
      speech_rate: options.speechRate ?? 0, pitch_rate: options.pitchRate ?? 0,
      loudness_rate: options.loudnessRate ?? 0, enable_subtitle: options.enableSubtitle === true })) {
      addAnyCapParam(args, parameter, normalizeAnyCapParameter(parameters[parameter], value));
    }
    if (mode === 'text-to-audio') {
      const speakerIds = Array.isArray(options.speakerIds)
        ? options.speakerIds.map((item) => String(item).trim()).filter(Boolean).slice(0, 1)
        : [];
      addAnyCapJsonParam(args, 'speaker_ids', speakerIds);
    }
    if (mode === 'audio-to-audio') addAnyCapJsonParam(args, 'audios', audioPaths);
    if (mode === 'image-to-audio') addAnyCapJsonParam(args, 'images', imagePaths);
  } else {
    const durationMs = options.musicDurationMs ?? (Number.isFinite(Number(options.duration)) ? Number(options.duration) * 1000 : undefined);
    for (const [parameter, value] of Object.entries({ duration: durationMs, tags: options.tags || options.style,
      title: options.title, lyrics: options.lyrics, make_instrumental: options.makeInstrumental,
      custom_mode: options.customMode, vocal_gender: options.vocalGender })) {
      addAnyCapParam(args, parameter, normalizeAnyCapParameter(parameters[parameter], value));
    }
  }
  const result = await runWithSyntheticProgress(job, 18, 92, () => runCommand(bin, args));
  try {
    await fs.access(filePath);
  } catch {
    const localPath = parseAnyCapLocalPath(result.stdout);
    if (localPath) await fs.copyFile(localPath, filePath);
  }
  await fs.access(filePath);
  const localUrl = outputUrl(filePath);
  return {
    audioUrl: localUrl,
    fileUrl: localUrl,
    text: `AnyCap 音频已生成：${model}`,
  };
}

export async function runLocalMock(job, payload) {
  await job.updateProgress(30);
  const kind = payload.kind;
  if (kind === 'storyboard') {
    const shotCount = Math.max(1, Math.min(20, Math.round(numberOption(optionsOf(payload).shotCount, 5))));
    const storyboard = {
      version: 1,
      shotCount,
      shots: Array.from({ length: shotCount }, (_, index) => ({
        shotNumber: index + 1,
        shotSize: index === 0 ? '全景' : '中景',
        visualDescription: `本地分镜画面 ${index + 1}`,
        cameraMovement: index === 0 ? '固定镜头' : '缓慢推进',
        imagePrompt: `电影感分镜图，镜头 ${index + 1}`,
        videoPrompt: `电影感短片，镜头 ${index + 1}，缓慢运动`,
      })),
    };
    return {
      storyboard,
      text: storyboardToMarkdown(storyboard),
    };
  }
  if (kind === 'collage' || kind === 'stage3d' || kind === 'panorama') {
    return {
      imageUrl: mockImageUrl(payload.prompt || payload.title || kind, kind === 'collage' ? 0 : 1),
      text: `${payload.title || kind} 本地预览已生成，后续可接入真实工具。`,
    };
  }
  if (kind === 'asset' || kind === 'upload') {
    return {
      assetName: payload.prompt || 'local-reference.asset',
      text: '素材已进入画布，可连接到生成节点。',
    };
  }
  return {
    text: `${payload.title || kind} 已完成本地占位任务。`,
  };
}

function providerToolOf(payload) {
  const options = optionsOf(payload);
  const explicit = stringOption(options.providerTool).toLowerCase();
  if (explicit) return explicit;
  const provider = stringOption(payload.provider).toLowerCase();
  if (provider.includes('openai')) return 'openai-compatible';
  if (provider.includes('sub2api')) return 'sub2api';
  if (provider.includes('anycap')) return 'anycap';
  if (provider.includes('runninghub')) return 'runninghub';
  return '';
}

export async function runProviderJob(job) {
  const payload = job.data;
  const providerTool = providerToolOf(payload);
  if (payload.kind === 'text') {
    if (providerTool === 'openai-compatible') return runOpenAICompatibleText(job, payload);
    if (!providerTool || providerTool === 'sub2api') return runSub2Text(job, payload);
    throw new Error(`文本节点暂不支持 provider：${providerTool}`);
  }
  if (payload.kind === 'storyboard') {
    if (providerTool === 'openai-compatible') return runOpenAICompatibleStoryboard(job, payload);
    if (!providerTool || providerTool === 'sub2api') return runSub2Storyboard(job, payload);
    if (providerTool === 'runninghub') {
      throw new Error('RunningHUB 分镜工作流入口已预留，但当前 worker 还没有接真实工作流执行。');
    }
    throw new Error(`分镜脚本节点暂不支持 provider：${providerTool}`);
  }
  if (payload.kind === 'image') {
    if (providerTool === 'openai-compatible') return runOpenAICompatibleImage(job, payload);
    if (providerTool === 'anycap') return runAnyCapImage(job, payload);
    if (!providerTool || providerTool === 'sub2api') return runSub2Image(job, payload);
    throw new Error(`图片节点暂不支持 provider：${providerTool}`);
  }
  if (payload.kind === 'video') {
    if (!providerTool || providerTool === 'anycap') return runAnyCapVideo(job, payload);
    throw new Error(`视频节点暂不支持 provider：${providerTool}`);
  }
  if (payload.kind === 'audio') {
    if (!providerTool || providerTool === 'anycap') return runAnyCapAudio(job, payload);
    throw new Error(`音频节点暂不支持 provider：${providerTool}`);
  }
  if (providerTool === 'runninghub') {
    throw new Error('RunningHUB provider 入口已预留，但当前 worker 还没有接真实工作流执行。');
  }
  return runLocalMock(job, payload);
}
