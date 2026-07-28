import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, outputDir } from '../media-render-worker/providerRuntime.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VIDEO_OPERATIONS = new Set(['ai-edit', 'concat', 'creative-edit']);
const AUDIO_POLICIES = new Set(['keep', 'mute', 'normalize']);
const TRANSITIONS = new Set(['cut', 'crossfade']);
const MAX_ANALYSIS_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_WIDTH = 3840;
const MAX_OUTPUT_HEIGHT = 3840;
const MAX_OUTPUT_PIXELS = 3840 * 2160;
const progressByJob = new WeakMap();
const progressWrites = new WeakMap();

export class VideoEditAbortError extends Error {
  constructor(message = '视频处理已取消') {
    super(message);
    this.name = 'AbortError';
  }
}

export class VideoEditShutdownError extends Error {
  constructor(message = '视频 worker 正在关闭') {
    super(message);
    this.name = 'VideoEditShutdownError';
  }
}

function safeId(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function parseFrameRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : 30;
}

function outputUrl(filePath) {
  const relative = path.relative(outputDir(), filePath).split(path.sep).map(encodeURIComponent).join('/');
  return `/output/${relative}`;
}

async function writeProgress(job, value) {
  if (!job || typeof job.updateProgress !== 'function') return;
  const next = Math.round(clamp(value, 0, 100));
  if (typeof job === 'object') {
    const previous = progressByJob.get(job) ?? -1;
    if (next <= previous) return;
    progressByJob.set(job, next);
  }
  await job.updateProgress(next);
}

function updateProgress(job, value) {
  if (!job || typeof job.updateProgress !== 'function') return Promise.resolve();
  const previous = typeof job === 'object' ? progressWrites.get(job) || Promise.resolve() : Promise.resolve();
  const next = previous
    .then(() => writeProgress(job, value))
    .catch((error) => {
      console.error(`[video-edit-worker] progress update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  if (typeof job === 'object') progressWrites.set(job, next);
  return next;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new VideoEditAbortError();
  }
}

async function cancellationCheckpoint(signal, checkCanceled) {
  throwIfAborted(signal);
  if (checkCanceled && await checkCanceled()) throw new VideoEditAbortError();
}

function processFailure(command, stderr, stdout, code) {
  const detail = String(stderr || stdout || '').trim();
  const lastLines = detail.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  return new Error(lastLines || `${command} exited with ${code}`);
}

function publicFailureMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  const sensitiveRoots = [rootDir, outputDir(), process.env.HOME, ...(String(process.env.VIDEO_EDIT_ALLOWED_ROOTS || '').split(path.delimiter))]
    .filter(Boolean)
    .sort((left, right) => String(right).length - String(left).length);
  for (const root of sensitiveRoots) message = message.replaceAll(String(root), '[local-media]');
  return message.replace(/https?:\/\/[^\s)]+/gi, '[remote-service]').slice(0, 800);
}

/** Run a child process without a shell and terminate it when the job is cancelled. */
export function runProcess(command, args, { cwd = rootDir, signal, onStdoutLine, onStderrLine } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;
    let stdoutRemainder = '';
    let stderrRemainder = '';

    const emitLines = (text, remainder, listener) => {
      const parts = `${remainder}${text}`.split(/\r?\n/);
      const nextRemainder = parts.pop() || '';
      if (listener) parts.forEach((line) => listener(line));
      return nextRemainder;
    };

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      if (settled) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    };

    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutRemainder = emitLines(text, stdoutRemainder, onStdoutLine);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrRemainder = emitLines(text, stderrRemainder, onStderrLine);
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, childSignal) => {
      if (stdoutRemainder && onStdoutLine) onStdoutLine(stdoutRemainder);
      if (stderrRemainder && onStderrLine) onStderrLine(stderrRemainder);
      if (signal?.aborted) {
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new VideoEditAbortError()));
      } else if (code === 0) {
        finish(() => resolve({ stdout, stderr }));
      } else {
        finish(() => reject(processFailure(command, stderr, stdout, code ?? childSignal ?? 'unknown')));
      }
    });
  });
}

export async function runFfmpeg(args, { duration = 0, signal, onProgress } = {}) {
  const executable = process.env.FFMPEG_BIN || 'ffmpeg';
  let lastProgress = -1;
  return runProcess(executable, ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], {
    signal,
    onStdoutLine(line) {
      const match = /^(out_time_us|out_time_ms)=(\d+)$/.exec(line);
      if (!match || duration <= 0 || !onProgress) return;
      const seconds = Number(match[2]) / 1_000_000;
      const progress = clamp(seconds / duration, 0, 0.995);
      if (progress - lastProgress >= 0.005) {
        lastProgress = progress;
        onProgress(progress);
      }
    },
  }).then((result) => {
    if (onProgress) onProgress(1);
    return result;
  });
}

export async function probeVideo(filePath, { signal } = {}) {
  const executable = process.env.FFPROBE_BIN || 'ffprobe';
  const { stdout } = await runProcess(executable, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=index,codec_type,width,height,r_frame_rate,duration',
    '-of', 'json',
    filePath,
  ], { signal });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('无法解析 ffprobe 返回结果');
  }
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('引用文件不包含视频轨');
  const videoDuration = finiteNumber(video.duration, 0);
  const duration = videoDuration > 0 ? videoDuration : finiteNumber(data.format?.duration, 0);
  if (duration <= 0) throw new Error('无法读取视频时长');
  return {
    path: filePath,
    duration,
    width: even(finiteNumber(video.width, 1280)),
    height: even(finiteNumber(video.height, 720)),
    fps: parseFrameRate(video.r_frame_rate),
    hasAudio: (data.streams || []).some((stream) => stream.codec_type === 'audio'),
    size: finiteNumber(data.format?.size, 0),
  };
}

function referencePath(reference) {
  const locator = reference?.path || reference?.localPath || '';
  if (/^https?:\/\//i.test(String(locator))) {
    throw new Error('远程视频尚未落盘，暂时不能剪辑');
  }
  return locator ? path.resolve(rootDir, String(locator)) : '';
}

export async function resolveVideoSources(payload, { signal } = {}) {
  const references = Array.isArray(payload.references) ? payload.references : [];
  const candidates = references.filter((reference) => {
    const type = String(reference?.outputType || reference?.type || reference?.kind || '').toLowerCase();
    return type === 'video' || (!type && (reference?.path || reference?.localPath));
  });
  const configuredRoots = String(process.env.VIDEO_EDIT_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const allowedRoots = await Promise.all(
    [path.resolve(outputDir()), ...configuredRoots].map((root) => fs.realpath(root).catch(() => root)),
  );
  const paths = [];
  for (const candidate of candidates) {
    throwIfAborted(signal);
    const filePath = referencePath(candidate);
    if (!filePath) throw new Error('视频引用缺少本地文件');
    let stat;
    let realPath;
    try {
      realPath = await fs.realpath(filePath);
      stat = await fs.stat(realPath);
    } catch {
      throw new Error('引用的视频文件不存在');
    }
    if (!stat.isFile()) throw new Error('视频引用不是可读文件');
    const allowed = allowedRoots.some((root) => {
      const relative = path.relative(root, realPath);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (!allowed) throw new Error('视频引用不在允许的媒体目录内');
    paths.push(realPath);
  }
  return paths;
}

function boundedDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('输出分辨率无效');
  }
  const ratio = width / height;
  if (ratio < 0.1 || ratio > 10) throw new Error('输出画面比例超出安全范围');
  const scale = Math.min(
    1,
    MAX_OUTPUT_WIDTH / width,
    MAX_OUTPUT_HEIGHT / height,
    Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)),
  );
  return { width: even(width * scale), height: even(height * scale) };
}

function dimensionsFor(first, options = {}, rawOutput = {}) {
  const rawWidth = finiteNumber(rawOutput.width, 0);
  const rawHeight = finiteNumber(rawOutput.height, 0);
  if (rawWidth > 0 && rawHeight > 0) {
    return boundedDimensions(Math.max(144, rawWidth), Math.max(144, rawHeight));
  }
  const resolution = String(options.resolution || rawOutput.resolution || '').toLowerCase();
  const ratioText = String(options.aspectRatio || rawOutput.aspectRatio || '').trim();
  const ratioParts = ratioText.split(':').map(Number);
  const sourceRatio = first.width / first.height;
  const ratio = ratioParts.length === 2 && ratioParts.every((part) => Number.isFinite(part) && part > 0)
    ? ratioParts[0] / ratioParts[1]
    : sourceRatio;
  const base = resolution === '4k' || resolution === '2160p' ? 2160 : resolution === '1080p' ? 1080 : 720;
  if (!resolution) return boundedDimensions(first.width, first.height);
  if (ratio >= 1) return boundedDimensions(base * ratio, base);
  return boundedDimensions(base, base / ratio);
}

function clipTransition(raw) {
  const value = typeof raw === 'string' ? { type: raw } : (raw && typeof raw === 'object' ? raw : {});
  const type = TRANSITIONS.has(value.type) ? value.type : 'cut';
  return { type, duration: type === 'crossfade' ? clamp(finiteNumber(value.duration, 0.5), 0.1, 2) : 0 };
}

function clipPoint(raw, names, fallback) {
  for (const name of names) {
    if (raw?.[name] !== undefined) return finiteNumber(raw[name], fallback);
  }
  return fallback;
}

export function createSequentialPlan(probes, options = {}) {
  return normalizeEditPlan({
    clips: probes.map((probe, sourceIndex) => ({
      sourceIndex,
      in: 0,
      out: probe.duration,
      transition: sourceIndex < probes.length - 1
        ? { type: options.transition || 'cut', duration: options.transitionDuration }
        : 'cut',
    })),
    audio: { policy: options.audioPolicy || 'keep' },
    output: {},
  }, probes, options);
}

/** Validate untrusted AI/user JSON and return the only plan shape accepted by ffmpeg. */
export function normalizeEditPlan(raw, probes, options = {}) {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > 20) {
    throw new Error('视频素材数量必须在 1–20 之间');
  }
  const rawPlan = raw && typeof raw === 'object' ? raw : {};
  const rawClips = Array.isArray(rawPlan.clips) ? rawPlan.clips : [];
  if (!rawClips.length || rawClips.length > 20) throw new Error('剪辑方案必须包含 1–20 个片段');
  const clips = rawClips.map((clip, index) => {
    if (!clip || typeof clip !== 'object') throw new Error(`第 ${index + 1} 个片段格式无效`);
    const sourceIndex = Math.trunc(finiteNumber(clip.sourceIndex ?? clip.referenceIndex ?? clip.index, -1));
    if (sourceIndex < 0 || sourceIndex >= probes.length) throw new Error(`第 ${index + 1} 个片段的 sourceIndex 越界`);
    const source = probes[sourceIndex];
    const inPoint = clamp(clipPoint(clip, ['in', 'inPoint', 'start', 'startTime'], 0), 0, source.duration);
    const outPoint = clamp(clipPoint(clip, ['out', 'outPoint', 'end', 'endTime'], source.duration), 0, source.duration);
    if (outPoint - inPoint < 0.1) throw new Error(`第 ${index + 1} 个片段时长不足 0.1 秒`);
    return {
      sourceIndex,
      in: Number(inPoint.toFixed(3)),
      out: Number(outPoint.toFixed(3)),
      duration: Number((outPoint - inPoint).toFixed(3)),
      transition: clipTransition(clip.transition ?? clip.transitionToNext),
    };
  });
  clips.forEach((clip, index) => {
    if (index === clips.length - 1) {
      clip.transition = { type: 'cut', duration: 0 };
      return;
    }
    if (clip.transition.type === 'crossfade') {
      clip.transition.duration = Number(Math.min(
        clip.transition.duration,
        clip.duration / 2,
        clips[index + 1].duration / 2,
      ).toFixed(3));
      if (clip.transition.duration < 0.1) clip.transition = { type: 'cut', duration: 0 };
    }
  });
  const rawAudio = typeof rawPlan.audio === 'string' ? { policy: rawPlan.audio } : (rawPlan.audio || {});
  const requestedAudio = String(options.audioPolicy || rawAudio.policy || 'keep');
  const policy = AUDIO_POLICIES.has(requestedAudio) ? requestedAudio : 'keep';
  const first = probes[clips[0].sourceIndex];
  const dimensions = dimensionsFor(first, options, rawPlan.output || {});
  const fps = clamp(finiteNumber(options.fps ?? rawPlan.output?.fps, Math.round(first.fps || 30)), 12, 60);
  return {
    version: 1,
    clips,
    audio: { policy },
    output: {
      width: dimensions.width,
      height: dimensions.height,
      fps: Math.round(fps),
      videoCodec: 'h264',
      audioCodec: 'aac',
      format: 'mp4',
    },
  };
}

export function buildTransitionFilter(plan) {
  const filters = ['[0:v]settb=AVTB,setpts=PTS-STARTPTS[v0]', '[0:a]asetpts=PTS-STARTPTS[a0]'];
  let videoLabel = 'v0';
  let audioLabel = 'a0';
  let composedDuration = plan.clips[0].duration;
  for (let index = 1; index < plan.clips.length; index += 1) {
    const inputVideo = `vin${index}`;
    const inputAudio = `ain${index}`;
    const nextVideo = `v${index}`;
    const nextAudio = `a${index}`;
    filters.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[${inputVideo}]`);
    filters.push(`[${index}:a]asetpts=PTS-STARTPTS[${inputAudio}]`);
    const transition = plan.clips[index - 1].transition;
    if (transition.type === 'crossfade') {
      const duration = transition.duration;
      const offset = Math.max(0, composedDuration - duration);
      filters.push(`[${videoLabel}][${inputVideo}]xfade=transition=fade:duration=${duration}:offset=${offset.toFixed(3)}[${nextVideo}]`);
      filters.push(`[${audioLabel}][${inputAudio}]acrossfade=d=${duration}:c1=tri:c2=tri[${nextAudio}]`);
      composedDuration += plan.clips[index].duration - duration;
    } else {
      filters.push(`[${videoLabel}][${inputVideo}]concat=n=2:v=1:a=0[${nextVideo}]`);
      filters.push(`[${audioLabel}][${inputAudio}]concat=n=2:v=0:a=1[${nextAudio}]`);
      composedDuration += plan.clips[index].duration;
    }
    videoLabel = nextVideo;
    audioLabel = nextAudio;
  }
  return { graph: filters.join(';'), videoLabel, audioLabel, duration: composedDuration };
}

async function normalizeClip(source, clip, plan, targetPath, { signal, onProgress } = {}) {
  const silentAudio = plan.audio.policy === 'mute' || !source.hasAudio;
  const videoFilter = [
    `scale=${plan.output.width}:${plan.output.height}:force_original_aspect_ratio=decrease`,
    `pad=${plan.output.width}:${plan.output.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${plan.output.fps}`,
    'format=yuv420p',
  ].join(',');
  const args = ['-y', '-ss', String(clip.in), '-t', String(clip.duration), '-i', source.path];
  if (silentAudio) args.push('-f', 'lavfi', '-t', String(clip.duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  args.push('-map', '0:v:0', '-map', silentAudio ? '1:a:0' : '0:a:0', '-vf', videoFilter);
  const audioFilters = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
  if (!silentAudio) {
    if (plan.audio.policy === 'normalize') audioFilters.push('loudnorm=I=-16:LRA=11:TP=-1.5');
  }
  audioFilters.push('apad', `atrim=duration=${clip.duration}`, 'asetpts=PTS-STARTPTS');
  args.push('-af', audioFilters.join(','));
  args.push(
    '-c:v', 'libx264',
    '-preset', process.env.VIDEO_EDIT_X264_PRESET || 'medium',
    '-crf', process.env.VIDEO_EDIT_CRF || '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', String(clip.duration), '-movflags', '+faststart', targetPath,
  );
  return runFfmpeg(args, { duration: clip.duration, signal, onProgress });
}

async function joinNormalizedClips(normalizedPaths, plan, targetPath, tempDir, { signal, onProgress } = {}) {
  const hasCrossfade = plan.clips.some((clip) => clip.transition.type === 'crossfade');
  if (!hasCrossfade) {
    const concatPath = path.join(tempDir, 'concat.txt');
    const content = normalizedPaths.map((filePath) => `file '${filePath.replaceAll("'", "'\\''")}'`).join('\n');
    await fs.writeFile(concatPath, content, 'utf8');
    const duration = plan.clips.reduce((sum, clip) => sum + clip.duration, 0);
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', targetPath], {
      duration,
      signal,
      onProgress,
    });
    return duration;
  }
  const transition = buildTransitionFilter(plan);
  const args = ['-y'];
  normalizedPaths.forEach((filePath) => args.push('-i', filePath));
  args.push(
    '-filter_complex', transition.graph,
    '-map', `[${transition.videoLabel}]`, '-map', `[${transition.audioLabel}]`,
    '-c:v', 'libx264', '-preset', process.env.VIDEO_EDIT_X264_PRESET || 'medium',
    '-crf', process.env.VIDEO_EDIT_CRF || '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', targetPath,
  );
  await runFfmpeg(args, { duration: transition.duration, signal, onProgress });
  return transition.duration;
}

export async function renderEditPlan(job, sources, probes, plan, tempDir, { signal, progressStart = 10, progressEnd = 98 } = {}) {
  const normalizedDir = path.join(tempDir, 'normalized');
  await fs.mkdir(normalizedDir, { recursive: true });
  const normalizedPaths = [];
  const renderSpan = progressEnd - progressStart;
  const normalizeSpan = renderSpan * 0.72;
  for (let index = 0; index < plan.clips.length; index += 1) {
    throwIfAborted(signal);
    const clip = plan.clips[index];
    const targetPath = path.join(normalizedDir, `${String(index).padStart(2, '0')}.mp4`);
    const itemStart = progressStart + normalizeSpan * (index / plan.clips.length);
    const itemSpan = normalizeSpan / plan.clips.length;
    await normalizeClip(probes[clip.sourceIndex], clip, plan, targetPath, {
      signal,
      onProgress: (progress) => updateProgress(job, itemStart + itemSpan * progress),
    });
    normalizedPaths.push(targetPath);
  }
  const stagedOutput = path.join(tempDir, 'result.mp4');
  const joinStart = progressStart + normalizeSpan;
  await joinNormalizedClips(normalizedPaths, plan, stagedOutput, tempDir, {
    signal,
    onProgress: (progress) => updateProgress(job, joinStart + (progressEnd - joinStart) * progress),
  });
  return stagedOutput;
}

function extractJsonCandidate(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function extractAnyCapText(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) throw new Error('AnyCap video-read 没有返回内容');
  try {
    const parsed = JSON.parse(raw);
    const candidates = [
      parsed.summary,
      parsed.text,
      parsed.content,
      parsed.description,
      parsed.answer,
      parsed.output,
      parsed.data?.summary,
      parsed.data?.text,
      parsed.data?.content,
      parsed.data?.description,
      parsed.data?.answer,
      parsed.result?.text,
      parsed.result?.content,
    ];
    const match = candidates.find((value) => typeof value === 'string' && value.trim());
    if (match) return match.trim();
    return JSON.stringify(parsed).slice(0, 20_000);
  } catch {
    return raw.slice(0, 20_000);
  }
}

async function createAnalysisProxy(source, targetPath, { signal, onProgress } = {}) {
  const targetBytes = 90 * 1024 * 1024;
  const kilobitsPerSecond = clamp(Math.floor((targetBytes * 8) / Math.max(1, source.duration) / 1000), 32, 700);
  await runFfmpeg([
    '-y', '-i', source.path,
    '-map', '0:v:0', '-an',
    '-vf', 'scale=-2:360,fps=12,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${kilobitsPerSecond}k`, '-maxrate', `${kilobitsPerSecond}k`, '-bufsize', `${kilobitsPerSecond * 2}k`,
    '-fs', String(96 * 1024 * 1024), '-movflags', '+faststart', targetPath,
  ], { duration: source.duration, signal, onProgress });
  return targetPath;
}

async function analyzeVideo(source, index, tempDir, { signal, onProxyProgress } = {}) {
  const threshold = finiteNumber(process.env.VIDEO_EDIT_ANALYSIS_MAX_BYTES, MAX_ANALYSIS_BYTES);
  let analysisPath = source.path;
  if (source.size > threshold || fsSync.statSync(source.path).size > threshold) {
    analysisPath = await createAnalysisProxy(source, path.join(tempDir, `analysis-${index}.mp4`), {
      signal,
      onProgress: onProxyProgress,
    });
  }
  const args = [
    'actions', 'video-read', '--file', analysisPath,
    '--instruction', '请按时间线概括主要画面、人物、动作、镜头转换、对白和可用于剪辑的高光时间段，使用精确秒数。',
  ];
  if (process.env.ANYCAP_VIDEO_READ_MODEL) args.push('--model', process.env.ANYCAP_VIDEO_READ_MODEL);
  const { stdout } = await runProcess(process.env.ANYCAP_BIN || 'anycap', args, { signal });
  return extractAnyCapText(stdout);
}

async function requestSub2Plan(probes, summaries, prompt, options, { signal } = {}) {
  const base = process.env.SUB2API_BASE_URL || 'http://10.0.0.239:3000';
  const cleanBase = base.replace(/\/+$/, '');
  const url = cleanBase.endsWith('/v1/chat/completions')
    ? cleanBase
    : cleanBase.endsWith('/v1')
      ? `${cleanBase}/chat/completions`
      : `${cleanBase}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SUB2API_API_KEY) headers.Authorization = `Bearer ${process.env.SUB2API_API_KEY}`;
  const sourceDescription = probes.map((probe, index) => ({
    sourceIndex: index,
    duration: Number(probe.duration.toFixed(3)),
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
    summary: summaries[index],
  }));
  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: options.planModel || process.env.SUB2API_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是专业视频剪辑师。只返回 JSON，禁止 Markdown。',
            '格式：{"version":1,"clips":[{"sourceIndex":0,"in":0,"out":3.2,"transition":{"type":"cut|crossfade","duration":0.5}}],"audio":{"policy":"keep|mute|normalize"},"output":{"fps":30}}',
            'sourceIndex 必须使用 0 起始的素材编号；in/out 是原视频秒数；至少使用 2 个片段，最多 20 个。',
            '不得输出超出素材时长的时间点，最后一个片段 transition 必须为 cut。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `剪辑要求：${String(prompt || '按内容节奏整理成连贯短片')}\n\n素材分析：\n${JSON.stringify(sourceDescription)}`,
        },
      ],
    }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Sub2API 返回非 JSON 内容（${response.status}）`);
  }
  if (!response.ok) throw new Error(String(data?.error?.message || data?.error || data?.message || `Sub2API ${response.status}`));
  const rawContent = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  const content = Array.isArray(rawContent)
    ? rawContent.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
    : rawContent;
  if (!content) throw new Error('Sub2API 未返回剪辑方案');
  return JSON.parse(extractJsonCandidate(content));
}

async function buildAiEditPlan(job, probes, prompt, options, tempDir, { signal } = {}) {
  const summaries = [];
  for (let index = 0; index < probes.length; index += 1) {
    throwIfAborted(signal);
    const itemStart = 8 + (24 * index) / probes.length;
    const itemSpan = 24 / probes.length;
    await updateProgress(job, itemStart);
    summaries.push(await analyzeVideo(probes[index], index, tempDir, {
      signal,
      onProxyProgress: (progress) => updateProgress(job, itemStart + itemSpan * 0.45 * progress),
    }));
    await updateProgress(job, itemStart + itemSpan);
  }
  await updateProgress(job, 34);
  const rawPlan = await requestSub2Plan(probes, summaries, prompt, options, { signal });
  const plan = normalizeEditPlan(rawPlan, probes, options);
  if (plan.clips.length < 2) throw new Error('AI 剪辑方案至少需要 2 个片段');
  return plan;
}

function parseAnyCapLocalPath(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const data = parsed.data || parsed;
    const candidate = data.local_path || data.path || data.output || data.outputs?.[0]?.local_path || data.files?.[0]?.local_path;
    return candidate ? path.resolve(rootDir, String(candidate)) : '';
  } catch {
    return '';
  }
}

async function runCreativeEdit(job, sources, payload, tempDir, { signal } = {}) {
  if (sources.length < 1 || sources.length > 3) throw new Error('创意改编需要 1–3 段视频');
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const model = String(options.model || process.env.ANYCAP_VIDEO_EDIT_MODEL || 'gemini-omni-flash-preview').trim();
  if (model !== 'gemini-omni-flash-preview') {
    throw new Error(`创意改编暂不支持模型：${model}`);
  }
  const resolution = String(options.resolution || '720p').toLowerCase();
  if (resolution !== '720p') throw new Error(`${model} 创意改编仅支持 720p`);
  const requestedRatio = String(options.aspectRatio || '16:9').trim();
  const aspectRatio = requestedRatio === 'adaptive' ? '16:9' : requestedRatio;
  if (!['16:9', '9:16'].includes(aspectRatio)) throw new Error(`${model} 创意改编仅支持 16:9 或 9:16`);
  const duration = Math.round(clamp(finiteNumber(options.duration, 6), 3, 10));
  const stagedOutput = path.join(tempDir, 'creative-edit.mp4');
  const args = [
    'video', 'generate',
    '--model', model,
    '--mode', 'edit-video',
    '--prompt', String(payload.prompt || '在保留主体和动作的前提下，将素材改编为连贯的电影感片段。'),
    '-o', stagedOutput,
    '--param', `videos=${JSON.stringify(sources)}`,
    '--param', 'format=mp4',
    '--param', `resolution=${resolution}`,
    '--param', `duration=${duration}`,
    '--param', `aspect_ratio=${aspectRatio}`,
  ];
  await updateProgress(job, 15);
  const result = await runProcess(process.env.ANYCAP_BIN || 'anycap', args, { signal });
  await updateProgress(job, 92);
  try {
    await fs.access(stagedOutput);
  } catch {
    const alternate = parseAnyCapLocalPath(result.stdout);
    if (!alternate) throw new Error('AnyCap 创意改编完成，但未找到输出文件');
    await fs.copyFile(alternate, stagedOutput);
  }
  await probeVideo(stagedOutput, { signal });
  return stagedOutput;
}

async function publishOutput(stagedPath, jobId, operation) {
  await fs.mkdir(outputDir(), { recursive: true });
  const fileName = `${safeId(jobId)}-${operation}.mp4`;
  const destination = path.join(outputDir(), fileName);
  await fs.rename(stagedPath, destination).catch(async (error) => {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(stagedPath, destination);
    await fs.rm(stagedPath, { force: true });
  });
  const stat = await fs.stat(destination);
  const url = outputUrl(destination);
  return {
    videoUrl: url,
    fileUrl: url,
    fileName,
    mimeType: 'video/mp4',
    size: stat.size,
  };
}

export async function discardPublishedArtifact(result) {
  const fileName = path.basename(String(result?.fileName || ''));
  if (!fileName || fileName !== result?.fileName) return;
  await fs.rm(path.join(outputDir(), fileName), { force: true }).catch(() => undefined);
}

/** Main BullMQ processor contract for ai-edit, concat and creative-edit. */
export async function runVideoEditJob(job, { signal, checkCanceled } = {}) {
  await loadDotEnv();
  throwIfAborted(signal);
  const payload = job?.data && typeof job.data === 'object' ? job.data : {};
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const operation = String(payload.operation || options.operation || '').toLowerCase();
  if (!VIDEO_OPERATIONS.has(operation)) throw new Error(`不支持的视频操作：${operation || '未指定'}`);
  const sources = await resolveVideoSources(payload, { signal });
  const minimum = operation === 'creative-edit' ? 1 : 2;
  const maximum = operation === 'creative-edit' ? 3 : 20;
  if (sources.length < minimum || sources.length > maximum) {
    throw new Error(`${operation} 需要 ${minimum}–${maximum} 段本地视频`);
  }
  await fs.mkdir(outputDir(), { recursive: true });
  const tempRoot = path.resolve(process.env.VIDEO_EDIT_TEMP_DIR || path.join(outputDir(), '.video-edit-tmp'));
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, `${safeId(job.id)}-`));
  let warnings = [];
  try {
    await updateProgress(job, 3);
    const probes = [];
    for (let index = 0; index < sources.length; index += 1) {
      probes.push(await probeVideo(sources[index], { signal }));
      await updateProgress(job, 3 + (5 * (index + 1)) / sources.length);
    }
    if (operation === 'creative-edit') {
      const staged = await runCreativeEdit(job, sources, payload, tempDir, { signal });
      await cancellationCheckpoint(signal, checkCanceled);
      const artifact = await publishOutput(staged, job.id, operation);
      try {
        await cancellationCheckpoint(signal, checkCanceled);
      } catch (error) {
        await discardPublishedArtifact(artifact);
        throw error;
      }
      await updateProgress(job, 100);
      return { ...artifact, operation, warnings };
    }
    let plan;
    if (options.editPlan) {
      plan = normalizeEditPlan(options.editPlan, probes, options);
    } else if (operation === 'concat') {
      const requestedClips = Array.isArray(options.clips) ? options.clips : null;
      plan = requestedClips
        ? normalizeEditPlan({ clips: requestedClips, audio: { policy: options.audioPolicy || 'keep' }, output: {} }, probes, options)
        : createSequentialPlan(probes, options);
    } else {
      try {
        plan = await buildAiEditPlan(job, probes, payload.prompt, options, tempDir, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        warnings = [`AI 剪辑方案生成失败，已安全回退到顺序合并：${publicFailureMessage(error)}`];
        plan = createSequentialPlan(probes, options);
      }
    }
    if (plan.clips.length < 2) throw new Error(`${operation} 剪辑方案至少需要 2 个片段`);
    if (options.planOnly === true) {
      await cancellationCheckpoint(signal, checkCanceled);
      await updateProgress(job, 100);
      return { operation, editPlan: plan, warnings, planOnly: true };
    }
    const progressStart = operation === 'ai-edit' ? 42 : 10;
    const staged = await renderEditPlan(job, sources, probes, plan, tempDir, { signal, progressStart });
    await cancellationCheckpoint(signal, checkCanceled);
    const artifact = await publishOutput(staged, job.id, operation);
    try {
      await cancellationCheckpoint(signal, checkCanceled);
    } catch (error) {
      await discardPublishedArtifact(artifact);
      throw error;
    }
    await updateProgress(job, 100);
    return { ...artifact, operation, editPlan: plan, warnings };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
