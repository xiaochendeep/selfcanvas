import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  return fs
    .readFile(envPath, 'utf8')
    .then((content) => {
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
    })
    .catch(() => undefined);
}

export function outputDir() {
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

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function fetchSub2Api(apiPath, body) {
  const baseUrl = process.env.SUB2API_BASE_URL || 'http://10.0.0.239:3000';
  const apiKey = process.env.SUB2API_API_KEY || '';
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
    if (response.status === 503 && raw.includes('No available compatible accounts')) {
      throw new Error('Sub2API 已连接，但没有可服务该模型的账号/渠道。请先配置兼容账号。');
    }
    throw new Error(`Sub2API ${response.status}: ${raw}`);
  }
  return data;
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
  const model = process.env.SUB2API_TEXT_MODEL || payload.model || 'gpt-4o-mini';
  const data = await fetchSub2Api('/v1/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content: '你是 selfcanvas 的文本生成节点，输出直接可放进创作画布的中文内容。',
      },
      { role: 'user', content: payload.prompt || '生成一段创作文本。' },
    ],
    temperature: 0.8,
  });
  await job.updateProgress(90);
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!text) throw new Error('Sub2API 返回成功，但没有文本内容。');
  return {
    text: String(text).trim(),
  };
}

export async function runSub2Image(job, payload) {
  await job.updateProgress(18);
  const model = process.env.SUB2API_IMAGE_MODEL || payload.model || 'gpt-image-2';
  const data = await fetchSub2Api('/v1/images/generations', {
    model,
    prompt: payload.prompt || 'cinematic reference image',
    size: process.env.SUB2API_IMAGE_SIZE || '1024x1024',
    response_format: 'url',
  });
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
  const model = process.env.ANYCAP_VIDEO_MODEL || (payload.model && !payload.model.startsWith('mock') ? payload.model : '') || 'seedance-2-fast';
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.mp4`);
  const args = [
    'video',
    'generate',
    '--model',
    model,
    '--mode',
    process.env.ANYCAP_VIDEO_MODE || 'text-to-video',
    '--prompt',
    payload.prompt || 'cinematic short video',
    '-o',
    filePath,
  ];
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
  const model = process.env.ANYCAP_AUDIO_MODEL || '';
  if (!model) {
    throw new Error('AnyCap 音频模型未配置。请在 .env 设置 ANYCAP_AUDIO_MODEL 后再运行音频节点。');
  }
  await ensureOutputDir();
  const bin = process.env.ANYCAP_BIN || 'anycap';
  const filePath = path.join(outputDir(), `${safeId(job.id)}.mp3`);
  const args = ['music', 'text-to-music', '--model', model, '--prompt', payload.prompt || 'soft background score', '-o', filePath];
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
    return {
      text: '本地分镜脚本：1. 建立场景 2. 角色入画 3. 动作推进 4. 情绪特写 5. 收束镜头。',
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

export async function runProviderJob(job) {
  const payload = job.data;
  if (payload.kind === 'text') return runSub2Text(job, payload);
  if (payload.kind === 'image') return runSub2Image(job, payload);
  if (payload.kind === 'video') return runAnyCapVideo(job, payload);
  if (payload.kind === 'audio') return runAnyCapAudio(job, payload);
  return runLocalMock(job, payload);
}
