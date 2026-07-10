import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  'seedance-2-fast': {
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
  return videoCapabilities[canonicalVideoModel(model)] || defaultVideoCapability;
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

async function persistRemoteFile(url, jobId, fallbackExtension) {
  await ensureOutputDir();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载生成文件失败：${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const extension =
    contentType.includes('png') ? 'png' :
    contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' :
    contentType.includes('webp') ? 'webp' :
    fallbackExtension;
  const filePath = path.join(outputDir(), `${safeId(jobId)}.${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return outputUrl(filePath);
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
    } catch {
      return { imageUrl: first.url, text: 'Sub2API 图像已生成，远程 URL 未能落盘。' };
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
    } catch {
      return { imageUrl: first.url, text: 'OpenAI Compatible 图像已生成，远程 URL 未能落盘。' };
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
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with ${code}`));
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

export async function runAnyCapVideo(job, payload) {
  await ensureOutputDir();
  const options = optionsOf(payload);
  const model = canonicalVideoModel(
    stringOption(options.model) ||
    process.env.ANYCAP_VIDEO_MODEL ||
    (payload.model && !payload.model.startsWith('mock') ? payload.model : '') ||
    'seedance-2-fast',
  );
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.mp4`);
  const capability = videoCapability(model);
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
  const duration = closestNumberOption(capability.durations, options.duration, capability.defaultDuration);
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
  addAnyCapParam(args, 'resolution', resolution);
  addAnyCapParam(args, 'duration', duration);
  addAnyCapParam(args, 'aspect_ratio', stringOption(options.aspectRatio) === 'adaptive' ? 'adaptive' : aspectRatio);
  addAnyCapParam(args, 'format', stringOption(options.format, 'mp4'));
  if (typeof options.generateAudio === 'boolean') addAnyCapParam(args, 'generate_audio', String(options.generateAudio));
  if ((limits.image ?? 0) > 0 && mode !== 'text-to-video') {
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
  const model = stringOption(options.model, process.env.ANYCAP_AUDIO_MODEL || '');
  if (!model) {
    throw new Error('AnyCap 音频模型未配置。请在 .env 设置 ANYCAP_AUDIO_MODEL 后再运行音频节点。');
  }
  await ensureOutputDir();
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.mp3`);
  const audioPaths = await existingReferencePaths(payload, 'audio');
  const args = [
    'music',
    stringOption(options.mode, 'text-to-music'),
    '--model',
    model,
    '--prompt',
    withReferenceContext(payload.prompt || 'soft background score', payload),
    '-o',
    filePath,
  ];
  addAnyCapParam(args, 'duration', numberOption(options.duration, undefined));
  addAnyCapParam(args, 'style', stringOption(options.style));
  addAnyCapParam(args, 'voice_reference', stringOption(options.voiceReference, audioPaths[0] || ''));
  addAnyCapParam(args, 'target_voice', stringOption(options.targetVoice, audioPaths[1] || ''));
  addAnyCapParam(args, 'voice_mode', stringOption(options.voiceMode));
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
