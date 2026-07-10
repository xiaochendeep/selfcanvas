import { useViewport } from '@xyflow/react';
import {
  AtSign,
  Check,
  ChevronRight,
  FileText,
  Image,
  LayoutGrid,
  Mic2,
  Music,
  Send,
  Settings2,
  Sparkles,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { useSettingsStore } from '../store/settingsStore';
import type { NodeKind, NodeReference, ProviderOptions, StudioNode } from '../types';
import {
  nodeToGroupReference,
  nodeToReference,
  referenceKey,
} from '../utils/nodeReferences';

const supportedKinds = new Set<NodeKind>(['text', 'image', 'video', 'audio', 'storyboard']);

const iconByOutput: Record<NodeReference['outputType'], LucideIcon> = {
  text: FileText,
  image: Image,
  video: Video,
  audio: Music,
  other: Sparkles,
};

interface ModelOption {
  id: string;
  label: string;
  hint?: string;
}

interface ProviderTool {
  id: string;
  label: string;
  labelByKind?: Partial<Record<NodeKind, string>>;
  badge: string;
  description: string;
  descriptionByKind?: Partial<Record<NodeKind, string>>;
  models: Partial<Record<NodeKind, ModelOption[]>>;
}

type OptionPanelId = 'image-size' | 'video-size' | null;

interface RatioOption {
  id: string;
  label: string;
  iconWidth: number;
  iconHeight: number;
  featured?: boolean;
}

const providerTools: ProviderTool[] = [
  {
    id: 'xiaomi-audio',
    label: '小米音频',
    badge: 'XM',
    description: '小米音频与音色能力',
    models: {
      audio: [
        { id: 'xiaomi-voice-clone', label: '小米音色转换', hint: '音色参考' },
        { id: 'xiaomi-tts-pro', label: '小米旁白 Pro', hint: '中文旁白' },
      ],
    },
  },
  {
    id: 'anycap',
    label: 'AnyCap',
    labelByKind: {
      audio: 'AnyCap 音乐',
    },
    badge: 'AC',
    description: '本地 AnyCap CLI / 网关媒体任务',
    descriptionByKind: {
      audio: '本地 AnyCap 网关',
    },
    models: {
      video: [
        { id: 'seedance-2-fast', label: 'Seedance 2.0 Fast', hint: '9图/3视频/3音频' },
        { id: 'seedance-2', label: 'Seedance 2.0', hint: '最高 4K 多参考' },
        { id: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', hint: '9 图参考' },
        { id: 'kling-3.0', label: 'Kling 3.0', hint: '9 图 / 多 Shot' },
        { id: 'kling-3.0-omni', label: 'Kling 3.0 Omni', hint: '多 Shot' },
        { id: 'kling-o1', label: 'Kling O1', hint: '图生视频' },
        { id: 'veo-3.1', label: 'Veo 3.1', hint: '6/8 秒' },
        { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', hint: '4/6/8 秒' },
        { id: 'sora-2-pro', label: 'Sora 2 Pro', hint: '4/8/12 秒' },
        { id: 'hailuo-2.3', label: 'Hailuo 2.3', hint: '1080p 10 秒' },
        { id: 'gemini-omni-flash-preview', label: 'Gemini Omni Flash', hint: '视频编辑' },
      ],
      audio: [
        { id: 'anycap-audio', label: 'ElevenLabs Music', hint: '默认音乐' },
        { id: 'mureka-v8', label: 'Mureka V8', hint: '歌曲生成' },
        { id: 'suno-v5', label: 'Suno V5', hint: '音乐创作' },
        { id: 'suno-v5-5', label: 'Suno V5.5', hint: '高质量音乐' },
      ],
    },
  },
  {
    id: 'sub2api',
    label: 'Sub2API',
    badge: 'OA',
    description: '聚合 OpenAI-compatible 文本/图片',
    models: {
      text: [
        { id: 'gpt-5.5', label: 'GPT-5.5', hint: '分镜脚本' },
        { id: 'gpt-4o-mini', label: 'GPT 4o Mini', hint: '默认文本' },
        { id: 'gpt-4.1', label: 'GPT 4.1', hint: '高质量文本' },
        { id: 'o3-mini', label: 'o3 Mini', hint: '推理草稿' },
        { id: 'qwen3-max', label: 'Qwen3 Max', hint: '中文长文' },
      ],
      image: [
        { id: 'gpt-image-2', label: 'GPT Image 2', hint: '默认图片' },
        { id: 'gpt-image-1', label: 'GPT Image 1', hint: '兼容模型' },
        { id: 'dall-e-3', label: 'DALL-E 3', hint: '老接口' },
      ],
      storyboard: [
        { id: 'gpt-5.5', label: 'GPT-5.5', hint: '分镜脚本' },
        { id: 'gpt-4.1', label: 'GPT 4.1', hint: '高质量脚本' },
        { id: 'gpt-4o-mini', label: 'GPT 4o Mini', hint: '轻量草稿' },
      ],
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    badge: 'OC',
    description: '自定义兼容接口文本/图片',
    models: {
      text: [
        { id: 'gpt-5.5', label: 'GPT-5.5', hint: '分镜脚本' },
        { id: 'gpt-4.1', label: 'GPT 4.1', hint: '高质量文本' },
        { id: 'gpt-4o-mini', label: 'GPT 4o Mini', hint: '轻量文本' },
        { id: 'o3-mini', label: 'o3 Mini', hint: '推理草稿' },
      ],
      image: [
        { id: 'gpt-image-2', label: 'GPT Image 2', hint: '默认图片' },
        { id: 'gpt-image-1', label: 'GPT Image 1', hint: '兼容图片' },
      ],
      storyboard: [
        { id: 'gpt-5.5', label: 'GPT-5.5', hint: '分镜脚本' },
        { id: 'gpt-4.1', label: 'GPT 4.1', hint: '兼容脚本' },
        { id: 'gpt-4o-mini', label: 'GPT 4o Mini', hint: '快速草稿' },
      ],
    },
  },
  {
    id: 'runninghub',
    label: 'RunningHUB工作流',
    badge: 'R',
    description: 'ComfyUI / 工作流模板',
    models: {
      audio: [
        { id: 'rh-audio-workflow', label: 'RunningHUB 音频工作流', hint: '工作流入口' },
        { id: 'rh-voice-workflow', label: 'RunningHUB 音色工作流', hint: '音色处理' },
      ],
      storyboard: [
        { id: 'rh-flux-dev', label: 'FLUX Dev 工作流', hint: '可控出图' },
        { id: 'rh-portrait-retouch', label: '人像精修工作流', hint: '后期处理' },
        { id: 'rh-product-shot', label: '商品图工作流', hint: '电商场景' },
      ],
      collage: [
        { id: 'rh-wan-i2v', label: 'Wan I2V 工作流', hint: '图生视频' },
        { id: 'rh-camera-move', label: '运镜工作流', hint: '镜头运动' },
      ],
    },
  },
];

function toolsForKind(kind: NodeKind) {
  const tools = providerTools.filter((tool) => (tool.models[kind] ?? []).length > 0);
  if (kind !== 'audio') return tools;
  const order = ['xiaomi-audio', 'runninghub', 'anycap'];
  return [...tools].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function defaultToolForKind(kind: NodeKind) {
  const tools = toolsForKind(kind);
  return tools.find((tool) => tool.id === (kind === 'video' || kind === 'audio' ? 'anycap' : 'sub2api')) ?? tools[0];
}

function findToolForModel(kind: NodeKind, model: string) {
  return toolsForKind(kind).find((tool) => (tool.models[kind] ?? []).some((item) => item.id === model));
}

function toolLabelForKind(tool: ProviderTool | undefined, kind: NodeKind) {
  if (!tool) return '';
  return tool.labelByKind?.[kind] ?? tool.label;
}

function toolDescriptionForKind(tool: ProviderTool | undefined, kind: NodeKind) {
  if (!tool) return '';
  return tool.descriptionByKind?.[kind] ?? tool.description;
}

function defaultModelForKind(kind: NodeKind, model: string) {
  if (model && !model.startsWith('mock-') && !model.startsWith('local-')) return model;
  if (kind === 'text') return 'gpt-4o-mini';
  if (kind === 'image') return 'gpt-image-2';
  if (kind === 'video') return 'seedance-2-fast';
  if (kind === 'audio') return 'anycap-audio';
  if (kind === 'storyboard') return 'gpt-5.5';
  return model || 'local-preview';
}

function defaultOptions(kind: NodeKind, model: string): ProviderOptions {
  const resolvedModel = defaultModelForKind(kind, model);
  if (kind === 'text') return { providerTool: 'sub2api', model: resolvedModel, temperature: 0.8 };
  if (kind === 'image') {
    return {
      providerTool: 'sub2api',
      model: resolvedModel,
      size: '1024x1024',
      resolutionTier: '1K',
      aspectRatio: 'adaptive',
      count: 1,
      responseFormat: 'url',
      outputFormat: 'png',
      transparentBackground: false,
      quality: 'standard',
      referenceQuality: 'high',
    };
  }
  if (kind === 'video') {
    return {
      providerTool: 'anycap',
      model: resolvedModel,
      mode: 'multi-modal-reference',
      resolution: '720p',
      duration: 6,
      aspectRatio: 'adaptive',
      generateAudio: true,
      format: 'mp4',
    };
  }
  if (kind === 'audio') {
    return {
      providerTool: 'anycap',
      model: resolvedModel,
      mode: 'text-to-music',
      duration: 30,
      style: 'cinematic',
      voiceMode: 'voice-reference',
      voiceReference: '',
      targetVoice: '',
    };
  }
  if (kind === 'storyboard') {
    return {
      providerTool: 'sub2api',
      model: resolvedModel,
      temperature: 0.7,
      shotCount: 5,
      promptMode: 'image',
      viewMode: 'list',
      systemPrompt: '你是专业影视分镜师。把用户剧情拆成清晰镜头列表，每个镜头包含镜号、景别、画面、运镜、图像提示词和视频提示词。',
    };
  }
  return { model: resolvedModel };
}

function videoModelKey(model: string) {
  return String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function closestOption(options: number[], value: unknown, fallback: number) {
  if (!options.length) return fallback;
  const target = Number(value);
  if (!Number.isFinite(target)) return options.includes(fallback) ? fallback : options[0];
  return options.reduce((best, item) => (Math.abs(item - target) < Math.abs(best - target) ? item : best), options[0]);
}

function canonicalVideoModelId(model: string) {
  const original = String(model || '').trim();
  const aliases: Record<string, string> = {
    seedance2: 'seedance-2',
    seedance20: 'seedance-2',
    seedance2pro: 'seedance-2',
    seedance20pro: 'seedance-2',
    seedance20fast: 'seedance-2-fast',
    seedance2fast: 'seedance-2-fast',
    seedancefsat: 'seedance-2-fast',
    seedance15pro: 'seedance-1.5-pro',
    seedance15: 'seedance-1.5-pro',
    kling30: 'kling-3.0',
    kling3: 'kling-3.0',
    kling30omni: 'kling-3.0-omni',
    kling3omni: 'kling-3.0-omni',
    klingo1: 'kling-o1',
    veo31: 'veo-3.1',
    veo31fast: 'veo-3.1-fast',
    veo3: 'veo-3.1',
    sora2: 'sora-2-pro',
    sora2pro: 'sora-2-pro',
    hailuo23: 'hailuo-2.3',
    geminiomniflashpreview: 'gemini-omni-flash-preview',
  };
  return aliases[videoModelKey(original)] ?? original;
}

interface VideoReferenceCapability {
  id: string;
  defaultMode: string;
  modes: string[];
  supportsMultiShot: boolean;
  resolutions: string[];
  durations: number[];
  aspectRatios: string[];
  defaultDuration: number;
  referenceLimits: Partial<Record<NodeReference['outputType'], number>>;
  referenceLimitsByMode?: Record<string, Partial<Record<NodeReference['outputType'], number>>>;
}

const noMediaLimits = { image: 0, video: 0, audio: 0 };
const seedanceRatios = ['16:9', '3:4', '21:9', '9:16', '4:3', '1:1'];

const videoModelCapabilities: Record<string, VideoReferenceCapability> = {
  'seedance-2-fast': {
    id: 'seedance-2-fast',
    defaultMode: 'multi-modal-reference',
    modes: ['multi-modal-reference', 'image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['480p', '720p'],
    durations: range(4, 15),
    defaultDuration: 6,
    aspectRatios: seedanceRatios,
    referenceLimits: { image: 9, video: 3, audio: 3 },
    referenceLimitsByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-modal-reference': { image: 9, video: 3, audio: 3 },
    },
  },
  'seedance-2': {
    id: 'seedance-2',
    defaultMode: 'multi-modal-reference',
    modes: ['multi-modal-reference', 'image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['480p', '720p', '1080p', '4k'],
    durations: range(4, 15),
    defaultDuration: 6,
    aspectRatios: ['3:4', '21:9', '9:16', '16:9', '4:3', '1:1'],
    referenceLimits: { image: 9, video: 3, audio: 3 },
    referenceLimitsByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-modal-reference': { image: 9, video: 3, audio: 3 },
    },
  },
  'seedance-1.5-pro': {
    id: 'seedance-1.5-pro',
    defaultMode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['480p', '720p'],
    durations: range(4, 12),
    defaultDuration: 6,
    aspectRatios: seedanceRatios,
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-3.0': {
    id: 'kling-3.0',
    defaultMode: 'multi-shot-video',
    modes: ['multi-shot-video', 'image-to-video', 'text-to-video'],
    supportsMultiShot: true,
    resolutions: ['720p', '1080p', '4k'],
    durations: range(3, 15),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '4:3', '3:4'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-shot-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-3.0-omni': {
    id: 'kling-3.0-omni',
    defaultMode: 'multi-shot-video',
    modes: ['multi-shot-video', 'image-to-video', 'text-to-video'],
    supportsMultiShot: true,
    resolutions: ['720p', '1080p'],
    durations: range(3, 15),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '1:1'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: {
      'text-to-video': noMediaLimits,
      'image-to-video': { image: 9, video: 3, audio: 0 },
      'multi-shot-video': { image: 9, video: 0, audio: 0 },
    },
  },
  'kling-o1': {
    id: 'kling-o1',
    defaultMode: 'image-to-video',
    modes: ['image-to-video'],
    supportsMultiShot: false,
    resolutions: ['720p'],
    durations: range(5, 10),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16', '1:1'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
  },
  'veo-3.1': {
    id: 'veo-3.1',
    defaultMode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['720p', '1080p'],
    durations: [6, 8],
    defaultDuration: 6,
    aspectRatios: ['9:16', '16:9'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'veo-3.1-fast': {
    id: 'veo-3.1-fast',
    defaultMode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['720p', '1080p'],
    durations: [4, 6, 8],
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'sora-2-pro': {
    id: 'sora-2-pro',
    defaultMode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['720p', '1080p'],
    durations: [4, 8, 12],
    defaultDuration: 8,
    aspectRatios: ['16:9', '9:16'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'hailuo-2.3': {
    id: 'hailuo-2.3',
    defaultMode: 'image-to-video',
    modes: ['image-to-video', 'text-to-video'],
    supportsMultiShot: false,
    resolutions: ['1080p'],
    durations: [10],
    defaultDuration: 10,
    aspectRatios: ['16:9', '9:16'],
    referenceLimits: { image: 9, video: 0, audio: 0 },
    referenceLimitsByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 9, video: 0, audio: 0 } },
  },
  'gemini-omni-flash-preview': {
    id: 'gemini-omni-flash-preview',
    defaultMode: 'edit-video',
    modes: ['edit-video'],
    supportsMultiShot: false,
    resolutions: [],
    durations: range(3, 10),
    defaultDuration: 6,
    aspectRatios: ['16:9', '9:16'],
    referenceLimits: { image: 0, video: 3, audio: 0 },
  },
};

const defaultVideoCapability: VideoReferenceCapability = {
  id: 'custom-video',
  defaultMode: 'text-to-video',
  modes: ['text-to-video', 'image-to-video'],
  supportsMultiShot: false,
  resolutions: ['720p'],
  durations: [6, 8, 10],
  defaultDuration: 6,
  aspectRatios: ['16:9', '9:16'],
  referenceLimits: { image: 1, video: 0, audio: 0 },
  referenceLimitsByMode: { 'text-to-video': noMediaLimits, 'image-to-video': { image: 1, video: 0, audio: 0 } },
};

function videoCapability(model: string): VideoReferenceCapability {
  return videoModelCapabilities[canonicalVideoModelId(model)] ?? defaultVideoCapability;
}

function videoReferenceLimits(model: string, mode?: string) {
  const capability = videoCapability(model);
  const normalizedMode = mode && capability.modes.includes(mode) ? mode : capability.defaultMode;
  return capability.referenceLimitsByMode?.[normalizedMode] ?? capability.referenceLimits;
}

function normalizeOptionsForModel(kind: NodeKind, model: string, options: ProviderOptions): ProviderOptions {
  if (kind === 'storyboard') {
    return {
      ...options,
      shotCount: Math.max(1, Math.min(20, Math.round(Number(options.shotCount) || 5))),
      promptMode: options.promptMode === 'video' ? 'video' : 'image',
      viewMode: options.viewMode === 'card' ? 'card' : 'list',
    };
  }
  if (kind !== 'video') return options;
  const canonicalModel = canonicalVideoModelId(model);
  const capability = videoCapability(canonicalModel);
  const requestedMode = String(options.mode ?? '');
  const mode = capability.modes.includes(requestedMode) ? requestedMode : capability.defaultMode;
  const nextOptions: ProviderOptions = {
    ...options,
    model: canonicalModel,
    mode,
    multiShot: mode === 'multi-shot-video',
    duration: closestOption(capability.durations, options.duration, capability.defaultDuration),
  };
  if (capability.resolutions.length) {
    const resolution = String(options.resolution ?? '');
    nextOptions.resolution = capability.resolutions.includes(resolution) ? resolution : capability.resolutions[0];
  } else {
    delete nextOptions.resolution;
  }
  const aspectRatio = String(options.aspectRatio ?? 'adaptive');
  nextOptions.aspectRatio =
    aspectRatio === 'adaptive' || capability.aspectRatios.includes(aspectRatio)
      ? aspectRatio
      : 'adaptive';
  if (mode === 'multi-shot-video') {
    nextOptions.shotCount = Math.max(1, Math.min(12, Number(options.shotCount ?? 3)));
  } else {
    delete nextOptions.shotCount;
  }
  return nextOptions;
}

function referenceCounts(references: NodeReference[]) {
  return references.reduce(
    (counts, reference) => {
      counts[reference.outputType] = (counts[reference.outputType] ?? 0) + 1;
      return counts;
    },
    {} as Partial<Record<NodeReference['outputType'], number>>,
  );
}

function referenceLimitMessage(kind: NodeKind, model: string, references: NodeReference[], mode?: string) {
  if (kind !== 'video') return '';
  const limits = videoReferenceLimits(model, mode);
  const counts = referenceCounts(references);
  const names: Partial<Record<NodeReference['outputType'], string>> = {
    image: '参考图',
    video: '参考视频',
    audio: '参考音频',
  };
  for (const type of ['image', 'video', 'audio'] as const) {
    const count = counts[type] ?? 0;
    const limit = limits[type] ?? 0;
    if (count > limit) {
      if (limit <= 0) return `${model} 暂不支持${names[type]}`;
      return `${model} 最多支持 ${limit} 个${names[type]}，当前是 ${count} 个`;
    }
  }
  return '';
}

function compatibleOutputs(kind: NodeKind, model = '', mode = ''): Set<NodeReference['outputType']> {
  if (kind === 'image') return new Set<NodeReference['outputType']>(['image', 'text']);
  if (kind === 'video') {
    const limits = videoReferenceLimits(model, mode);
    return new Set<NodeReference['outputType']>([
      'text',
      ...(['image', 'video', 'audio'] as const).filter((type) => (limits[type] ?? 0) > 0),
    ]);
  }
  if (kind === 'audio') return new Set<NodeReference['outputType']>(['audio', 'text']);
  if (kind === 'text' || kind === 'storyboard') return new Set<NodeReference['outputType']>(['text', 'image', 'video', 'audio']);
  return new Set<NodeReference['outputType']>(['text', 'image', 'video', 'audio']);
}

function placeholderFor(kind: NodeKind, compact = false) {
  if (kind === 'video') return compact ? '描述视频内容' : '描述视频内容，@ 引用素材，Enter 生成';
  if (kind === 'image') return compact ? '描述图片内容' : '描述图片内容，@ 引用素材，Enter 生成';
  if (kind === 'audio') return compact ? '描述音乐或旁白' : '描述音乐、旁白或音效，@ 引用脚本';
  if (kind === 'storyboard') return compact ? '输入分镜要求' : '输入剧情、文案或分镜要求';
  return compact ? '输入文本需求' : '输入文本创作需求，@ 引用素材，Enter 生成';
}

function clampIndex(index: number | null | undefined, max: number) {
  if (typeof index !== 'number' || Number.isNaN(index)) return max;
  return Math.max(0, Math.min(index, max));
}

function shouldPadBeforeMention(before: string) {
  return before.length > 0 && !/\s$/.test(before);
}

function shouldPadAfterMention(after: string) {
  return after.length > 0 && !/^[\s,.;:!?，。；：！？）)]/.test(after);
}

function replaceMentionTrigger(prompt: string, mention: string, triggerIndex: number) {
  const before = prompt.slice(0, triggerIndex);
  const after = prompt.slice(triggerIndex + 1);
  const suffix = shouldPadAfterMention(after) ? ' ' : '';
  return {
    prompt: `${before}${mention}${suffix}${after}`,
    caretIndex: before.length + mention.length + suffix.length,
  };
}

function insertReferenceMention(prompt: string, reference: NodeReference, triggerIndex: number | null, caretIndex: number | null) {
  const mention = `@${reference.title}`;
  const clampedTrigger = clampIndex(triggerIndex, prompt.length);
  const clampedCaret = clampIndex(caretIndex, prompt.length);

  if (triggerIndex !== null && prompt[clampedTrigger] === '@') {
    return replaceMentionTrigger(prompt, mention, clampedTrigger);
  }
  if (clampedCaret > 0 && prompt[clampedCaret - 1] === '@') {
    return replaceMentionTrigger(prompt, mention, clampedCaret - 1);
  }

  const before = prompt.slice(0, clampedCaret);
  const after = prompt.slice(clampedCaret);
  const prefix = shouldPadBeforeMention(before) ? ' ' : '';
  const suffix = shouldPadAfterMention(after) ? ' ' : '';
  return {
    prompt: `${before}${prefix}${mention}${suffix}${after}`,
    caretIndex: before.length + prefix.length + mention.length + suffix.length,
  };
}

type PromptPart =
  | { type: 'text'; text: string; start: number; end: number; key: string }
  | { type: 'mention'; text: string; reference: NodeReference; start: number; end: number; key: string };

function referenceMention(reference: NodeReference) {
  return `@${reference.title}`;
}

function tokenizePromptMentions(prompt: string, references: NodeReference[]): PromptPart[] {
  if (!prompt) return [];
  const referencesByMention = new Map<string, NodeReference[]>();
  for (const reference of references) {
    const mention = referenceMention(reference);
    referencesByMention.set(mention, [...(referencesByMention.get(mention) ?? []), reference]);
  }
  const mentionTexts = [...referencesByMention.keys()].sort((a, b) => b.length - a.length);
  if (!mentionTexts.length) return [{ type: 'text', text: prompt, start: 0, end: prompt.length, key: 'text-0' }];

  const parts: PromptPart[] = [];
  const usedByMention = new Map<string, number>();
  let index = 0;
  let textStart = 0;

  while (index < prompt.length) {
    const matched = mentionTexts.find((mention) => prompt.startsWith(mention, index));
    if (!matched) {
      index += 1;
      continue;
    }
    if (textStart < index) {
      parts.push({ type: 'text', text: prompt.slice(textStart, index), start: textStart, end: index, key: `text-${textStart}` });
    }
    const referencesForMention = referencesByMention.get(matched) ?? [];
    const used = usedByMention.get(matched) ?? 0;
    const reference = referencesForMention[used];
    usedByMention.set(matched, used + 1);
    if (reference) {
      parts.push({
        type: 'mention',
        text: matched,
        reference,
        start: index,
        end: index + matched.length,
        key: `${referenceKey(reference)}-${index}`,
      });
    } else {
      parts.push({ type: 'text', text: matched, start: index, end: index + matched.length, key: `text-${index}` });
    }
    index += matched.length;
    textStart = index;
  }

  if (textStart < prompt.length) {
    parts.push({ type: 'text', text: prompt.slice(textStart), start: textStart, end: prompt.length, key: `text-${textStart}` });
  }
  return parts;
}

function removePromptRanges(prompt: string, ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges
    .map((range) => ({ start: clampIndex(range.start, prompt.length), end: clampIndex(range.end, prompt.length) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return { prompt, caretIndex: prompt.length };

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let nextPrompt = '';
  let cursor = 0;
  for (const range of merged) {
    nextPrompt += prompt.slice(cursor, range.start);
    cursor = range.end;
  }
  nextPrompt += prompt.slice(cursor);
  return { prompt: nextPrompt, caretIndex: merged[0].start };
}

function mentionDeletionTarget(parts: PromptPart[], selectionStart: number, selectionEnd: number, key: string) {
  const mentionParts = parts.filter((part): part is Extract<PromptPart, { type: 'mention' }> => part.type === 'mention');
  if (selectionStart !== selectionEnd) {
    const overlappingMentions = mentionParts.filter((part) => part.start < selectionEnd && part.end > selectionStart);
    if (!overlappingMentions.length) return null;
    return {
      ranges: [
        { start: selectionStart, end: selectionEnd },
        ...overlappingMentions.map((part) => ({ start: part.start, end: part.end })),
      ],
      referenceKeys: new Set(overlappingMentions.map((part) => referenceKey(part.reference))),
    };
  }

  const target =
    key === 'Backspace'
      ? mentionParts.find((part) => selectionStart > part.start && selectionStart <= part.end)
      : mentionParts.find((part) => selectionStart >= part.start && selectionStart < part.end);

  if (!target) return null;
  return {
    ranges: [{ start: target.start, end: target.end }],
    referenceKeys: new Set([referenceKey(target.reference)]),
  };
}

const imageResolutionOptions = ['1K', '2K', '4K'];

const imageRatioOptions: RatioOption[] = [
  { id: 'adaptive', label: '自适应', iconWidth: 42, iconHeight: 42, featured: true },
  { id: '1:1', label: '1:1', iconWidth: 24, iconHeight: 24 },
  { id: '3:2', label: '3:2', iconWidth: 30, iconHeight: 20 },
  { id: '2:3', label: '2:3', iconWidth: 20, iconHeight: 30 },
  { id: '4:3', label: '4:3', iconWidth: 30, iconHeight: 23 },
  { id: '3:4', label: '3:4', iconWidth: 23, iconHeight: 30 },
  { id: '5:4', label: '5:4', iconWidth: 32, iconHeight: 25 },
  { id: '4:5', label: '4:5', iconWidth: 25, iconHeight: 32 },
  { id: '16:9', label: '16:9', iconWidth: 36, iconHeight: 20 },
  { id: '9:16', label: '9:16', iconWidth: 20, iconHeight: 36 },
  { id: '2:1', label: '2:1', iconWidth: 36, iconHeight: 18 },
  { id: '1:2', label: '1:2', iconWidth: 18, iconHeight: 36 },
  { id: '21:9', label: '21:9', iconWidth: 40, iconHeight: 17 },
  { id: '9:21', label: '9:21', iconWidth: 17, iconHeight: 40 },
];

const videoRatioOptions: RatioOption[] = [
  { id: 'adaptive', label: '自适应', iconWidth: 42, iconHeight: 42, featured: true },
  { id: '16:9', label: '16:9', iconWidth: 36, iconHeight: 20 },
  { id: '9:16', label: '9:16', iconWidth: 20, iconHeight: 36 },
  { id: '1:1', label: '1:1', iconWidth: 24, iconHeight: 24 },
  { id: '4:3', label: '4:3', iconWidth: 30, iconHeight: 23 },
  { id: '3:4', label: '3:4', iconWidth: 23, iconHeight: 30 },
];

const ratioOptionById = new Map([...imageRatioOptions, ...videoRatioOptions].map((option) => [option.id, option]));

function ratioOptionsForVideo(model: string) {
  const capability = videoCapability(model);
  const ids = ['adaptive', ...capability.aspectRatios];
  return ids
    .filter((id, index, list) => list.indexOf(id) === index)
    .map((id) => ratioOptionById.get(id) ?? { id, label: id, iconWidth: 30, iconHeight: 22 });
}

function imageResolutionTier(options: ProviderOptions) {
  const explicit = String(options.resolutionTier || '');
  if (imageResolutionOptions.includes(explicit)) return explicit;
  const size = String(options.size || '');
  if (size.includes('4096') || size.includes('4K')) return '4K';
  if (size.includes('2048') || size.includes('2K')) return '2K';
  return '1K';
}

function aspectRatioOf(options: ProviderOptions) {
  return String(options.aspectRatio || 'adaptive');
}

function aspectRatioLabel(ratio: string) {
  return ratio === 'adaptive' ? '自适应' : ratio;
}

function imageSizeForPreset(resolutionTier: string, aspectRatio: string) {
  const baseByTier: Record<string, number> = {
    '1K': 1024,
    '2K': 2048,
    '4K': 4096,
  };
  const base = baseByTier[resolutionTier] ?? 1024;
  if (aspectRatio === 'adaptive') return `${base}x${base}`;
  const [widthRatio, heightRatio] = aspectRatio.split(':').map((item) => Number(item));
  if (!widthRatio || !heightRatio) return `${base}x${base}`;
  if (widthRatio >= heightRatio) return `${Math.round((base * widthRatio) / heightRatio)}x${base}`;
  return `${base}x${Math.round((base * heightRatio) / widthRatio)}`;
}

function optionModel(options: ProviderOptions, node: StudioNode) {
  const model = defaultModelForKind(node.data.kind, String(options.model || node.data.model || ''));
  return node.data.kind === 'video' ? canonicalVideoModelId(model) : model;
}

function nodeScreenRect(nodeId: string) {
  if (typeof document === 'undefined') return null;
  const nodeElement = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).find(
    (element) => element.dataset.id === nodeId,
  );
  return nodeElement?.getBoundingClientRect() ?? null;
}

function composerBounds(
  node: StudioNode,
  zoom: number,
  viewportX: number,
  viewportY: number,
  expanded: boolean,
  viewportWidth: number,
  viewportHeight: number,
): CSSProperties {
  const rect = nodeScreenRect(node.id);
  const nodeWidth = node.measured?.width ?? node.width ?? 340;
  const nodeHeight = node.measured?.height ?? node.height ?? 260;
  const nodeScreenWidth = rect?.width ?? nodeWidth * zoom;
  const nodeTop = rect?.top ?? viewportY + node.position.y * zoom;
  const nodeBottom = rect?.bottom ?? viewportY + (node.position.y + nodeHeight) * zoom;
  const nodeCenter = rect ? rect.left + rect.width / 2 : viewportX + (node.position.x + nodeWidth / 2) * zoom;
  const expandedWidth =
    node.data.kind === 'image'
      ? 700
      : node.data.kind === 'video'
        ? 680
        : node.data.kind === 'audio'
          ? 600
          : node.data.kind === 'storyboard'
            ? 660
            : 600;
  const minExpandedWidth =
    node.data.kind === 'image' || node.data.kind === 'video'
      ? 500
      : node.data.kind === 'storyboard'
        ? 520
        : 480;
  const preferredExpandedWidth = Math.max(minExpandedWidth, Math.min(expandedWidth, nodeScreenWidth + 220));
  const targetWidth = expanded
    ? Math.min(preferredExpandedWidth, viewportWidth - 120)
    : Math.min(520, Math.max(320, nodeScreenWidth + 36));
  const expectedHeight = expanded ? (node.data.kind === 'image' ? 238 : node.data.kind === 'storyboard' ? 224 : 220) : 58;
  const minTop = 74;
  const maxTop = viewportHeight - expectedHeight - 92;
  const belowTop = nodeBottom + 10;
  const aboveTop = nodeTop - expectedHeight - 10;
  const left = Math.max(92, Math.min(nodeCenter - targetWidth / 2, viewportWidth - targetWidth - 24));
  const top =
    belowTop <= maxTop
      ? Math.max(minTop, belowTop)
      : aboveTop >= minTop
        ? aboveTop
        : Math.max(minTop, Math.min(belowTop, maxTop));
  return {
    left,
    top,
    width: targetWidth,
  };
}

export function GenerationComposer() {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const referenceSelectionIds = useCanvasStore((state) => state.referenceSelectionIds);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runNode = useCanvasStore((state) => state.runNode);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuToolId, setModelMenuToolId] = useState('');
  const [optionPanelOpen, setOptionPanelOpen] = useState<OptionPanelId>(null);
  const [expandedGroupId, setExpandedGroupId] = useState('');
  const [referenceWarning, setReferenceWarning] = useState('');
  const [visualCaretIndex, setVisualCaretIndex] = useState(0);
  const [promptFocused, setPromptFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptRenderRef = useRef<HTMLDivElement | null>(null);
  const caretIndexRef = useRef(0);
  const mentionTriggerIndexRef = useRef<number | null>(null);
  const enterBehavior = useSettingsStore((state) => state.settings.enterBehavior);
  const inputFontSize = useSettingsStore((state) => state.settings.inputFontSize);
  const inputSurface = useSettingsStore((state) => state.settings.inputSurface);
  const imageReferenceQuality = useSettingsStore((state) => state.settings.imageReferenceQuality);
  const composerResizable = useSettingsStore((state) => state.settings.composerResizable);
  const viewport = useViewport();
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  useEffect(() => {
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const rememberCaret = (textarea: HTMLTextAreaElement) => {
    const caretIndex = textarea.selectionStart ?? textarea.value.length;
    caretIndexRef.current = caretIndex;
    setVisualCaretIndex(caretIndex);
  };

  const syncPromptScroll = (textarea: HTMLTextAreaElement) => {
    if (!promptRenderRef.current) return;
    promptRenderRef.current.scrollTop = textarea.scrollTop;
    promptRenderRef.current.scrollLeft = textarea.scrollLeft;
  };

  const restoreCaret = (caretIndex: number) => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caretIndex, caretIndex);
      caretIndexRef.current = caretIndex;
      setVisualCaretIndex(caretIndex);
      syncPromptScroll(textarea);
    });
  };

  const selectedNode = useMemo(
    () => activeCanvas.nodes.find((node) => node.id === selectedNodeId),
    [activeCanvas.nodes, selectedNodeId],
  );

  useEffect(() => {
    setModelMenuOpen(false);
    setModelMenuToolId('');
    setOptionPanelOpen(null);
    setMentionOpen(false);
    setExpandedGroupId('');
    setReferenceWarning('');
    setVisualCaretIndex(0);
    setPromptFocused(false);
    mentionTriggerIndexRef.current = null;
    caretIndexRef.current = 0;
  }, [selectedNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setModelMenuOpen(false);
      setOptionPanelOpen(null);
      setMentionOpen(false);
      setExpandedGroupId('');
      mentionTriggerIndexRef.current = null;
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const collapseOnOutsideComposer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.generation-composer')) return;
      setModelMenuOpen(false);
      setOptionPanelOpen(null);
      setMentionOpen(false);
      setExpandedGroupId('');
      mentionTriggerIndexRef.current = null;
    };
    window.addEventListener('pointerdown', collapseOnOutsideComposer, true);
    return () => window.removeEventListener('pointerdown', collapseOnOutsideComposer, true);
  }, []);

  const candidates = useMemo(() => {
    if (!selectedNode) return [];
    const nodeOptions = { ...defaultOptions(selectedNode.data.kind, selectedNode.data.model), ...(selectedNode.data.providerOptions ?? {}) };
    const nodeModel = optionModel(nodeOptions, selectedNode);
    const compatible = compatibleOutputs(selectedNode.data.kind, nodeModel, String(nodeOptions.mode ?? ''));
    const upstream = new Set(
      activeCanvas.edges
        .filter((edge) => edge.target === selectedNode.id && typeof edge.data?.sourceGroupId !== 'string')
        .map((edge) => edge.source),
    );
    const canvasRefs = activeCanvas.nodes
      .filter((node) => upstream.has(node.id))
      .map(nodeToReference)
      .filter((ref) => compatible.has(ref.outputType));
    return canvasRefs
      .filter((ref, index, list) => {
        const key = `${ref.source}:${ref.nodeId}`;
        return list.findIndex((item) => `${item.source}:${item.nodeId}` === key) === index;
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }, [activeCanvas.edges, activeCanvas.nodes, selectedNode]);

  const groupCandidates = useMemo(() => {
    if (!selectedNode) return [];
    const nodeOptions = { ...defaultOptions(selectedNode.data.kind, selectedNode.data.model), ...(selectedNode.data.providerOptions ?? {}) };
    const nodeModel = optionModel(nodeOptions, selectedNode);
    const compatible = compatibleOutputs(selectedNode.data.kind, nodeModel, String(nodeOptions.mode ?? ''));
    const upstream = new Set(activeCanvas.edges.filter((edge) => edge.target === selectedNode.id).map((edge) => edge.source));
    const upstreamGroups = new Set(
      activeCanvas.edges
        .filter((edge) => edge.target === selectedNode.id && typeof edge.data?.sourceGroupId === 'string')
        .map((edge) => String(edge.data?.sourceGroupId)),
    );
    return activeCanvas.groups
      .map((group) => {
        const references = group.nodeIds
          .filter((nodeId) => upstream.has(nodeId) || upstreamGroups.has(group.id))
          .map((nodeId) => activeCanvas.nodes.find((node) => node.id === nodeId))
          .filter((node): node is StudioNode => Boolean(node))
          .map((node) => nodeToGroupReference(node, group))
          .filter((reference) => compatible.has(reference.outputType));
        const rank = upstreamGroups.has(group.id) ? 0 : 1;
        return { group, references, rank };
      })
      .filter((item) => item.references.length > 0)
      .sort((a, b) => a.rank - b.rank || a.group.name.localeCompare(b.group.name, 'zh-Hans-CN'));
  }, [activeCanvas.edges, activeCanvas.groups, activeCanvas.nodes, selectedNode]);

  const selectedPrompt = selectedNode?.data.prompt ?? '';
  const selectedReferences = selectedNode?.data.references;
  const promptParts = useMemo(
    () => tokenizePromptMentions(selectedPrompt, selectedReferences ?? []),
    [selectedPrompt, selectedReferences],
  );

  if (!selectedNode || !supportedKinds.has(selectedNode.data.kind)) return null;

  const node = selectedNode;
  const rawOptions = { ...defaultOptions(node.data.kind, node.data.model), ...(node.data.providerOptions ?? {}) };
  const rawModel = optionModel(rawOptions, node);
  const options = normalizeOptionsForModel(node.data.kind, rawModel, rawOptions);
  const references = selectedReferences ?? [];
  const running = node.data.status === 'running';
  const model = optionModel(options, node);
  const availableTools = toolsForKind(node.data.kind);
  const activeTool =
    availableTools.find((tool) => tool.id === options.providerTool) ||
    availableTools.find((tool) => tool.label === node.data.provider) ||
    findToolForModel(node.data.kind, model) ||
    defaultToolForKind(node.data.kind);
  const activeModels = activeTool?.models[node.data.kind] ?? [];
  const activeModel = activeModels.find((item) => item.id === model) ?? { id: model, label: model };
  const pickerTool = availableTools.find((tool) => tool.id === modelMenuToolId) ?? activeTool;
  const pickerModels = pickerTool?.models[node.data.kind] ?? [];
  const positionStyle = composerBounds(
    node,
    viewport.zoom,
    viewport.x,
    viewport.y,
    true,
    windowSize.width,
    windowSize.height,
  );
  const videoReferenceCapability = node.data.kind === 'video' ? videoCapability(model) : null;
  const activeVideoReferenceLimits: Partial<Record<NodeReference['outputType'], number>> =
    node.data.kind === 'video' ? videoReferenceLimits(model, String(options.mode ?? videoReferenceCapability?.defaultMode ?? '')) : {};
  const videoReferenceCounts = node.data.kind === 'video' ? referenceCounts(references) : {};

  const updateOptions = (patch: ProviderOptions) => {
    const mergedOptions = { ...options, ...patch };
    const nextModel = optionModel(mergedOptions, node);
    const nextOptions = normalizeOptionsForModel(node.data.kind, nextModel, mergedOptions);
    updateNodeData(node.id, {
      provider: toolLabelForKind(activeTool, node.data.kind) || node.data.provider,
      model: optionModel(nextOptions, node),
      providerOptions: nextOptions,
    });
  };

  const toggleOptionPanel = (panel: Exclude<OptionPanelId, null>) => {
    setModelMenuOpen(false);
    setMentionOpen(false);
    setOptionPanelOpen((open) => (open === panel ? null : panel));
  };

  const applyImageMediaPreset = (patch: { resolutionTier?: string; aspectRatio?: string }) => {
    const resolutionTier = patch.resolutionTier ?? imageResolutionTier(options);
    const aspectRatio = patch.aspectRatio ?? aspectRatioOf(options);
    updateOptions({
      resolutionTier,
      aspectRatio,
      size: imageSizeForPreset(resolutionTier, aspectRatio),
    });
  };

  const applyVideoMediaPreset = (patch: { resolution?: string; aspectRatio?: string }) => {
    updateOptions({
      resolution: patch.resolution ?? String(options.resolution ?? '720p'),
      aspectRatio: patch.aspectRatio ?? aspectRatioOf(options),
    });
  };

  const renderRatioButton = (
    option: RatioOption,
    active: boolean,
    onSelect: () => void,
  ) => (
    <button
      aria-pressed={active}
      className={`ratio-button ${option.featured ? 'is-featured' : ''} ${active ? 'is-active' : ''}`}
      key={option.id}
      type="button"
      onClick={onSelect}
    >
      <span className="ratio-icon-box">
        {option.featured ? (
          <LayoutGrid className="ratio-layout-icon" size={42} />
        ) : (
          <span className="ratio-icon" style={{ width: option.iconWidth, height: option.iconHeight }} />
        )}
      </span>
      <span>{option.label}</span>
    </button>
  );

  const renderImageSizePanel = () => {
    const resolutionTier = imageResolutionTier(options);
    const aspectRatio = aspectRatioOf(options);
    return (
      <div className="media-options-popover image-size-popover">
        <div className="media-options-title">画质</div>
        <div className="media-quality-row" role="listbox" aria-label="图片画质">
          {imageResolutionOptions.map((tier) => (
            <button
              className={tier === resolutionTier ? 'is-active' : ''}
              key={tier}
              type="button"
              onClick={() => applyImageMediaPreset({ resolutionTier: tier })}
            >
              {tier}
            </button>
          ))}
        </div>
        <div className="media-options-title">比例</div>
        <div className="media-ratio-grid image-ratio-grid">
          {imageRatioOptions.map((option) => renderRatioButton(option, option.id === aspectRatio, () => applyImageMediaPreset({ aspectRatio: option.id })))}
        </div>
      </div>
    );
  };

  const renderVideoSizePanel = () => {
    const resolution = String(options.resolution ?? '720p');
    const aspectRatio = aspectRatioOf(options);
    const capability = videoCapability(model);
    const ratioOptions = ratioOptionsForVideo(model);
    return (
      <div className="media-options-popover video-size-popover">
        {capability.resolutions.length > 0 && (
          <>
            <div className="media-options-title">视频分辨率</div>
            <div className="media-quality-row media-quality-row-video" role="listbox" aria-label="视频分辨率">
              {capability.resolutions.map((item) => (
                <button
                  className={item === resolution ? 'is-active' : ''}
                  key={item}
                  type="button"
                  onClick={() => applyVideoMediaPreset({ resolution: item })}
                >
                  {item}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="media-options-title">比例</div>
        <div className="media-ratio-grid video-ratio-grid">
          {ratioOptions.map((option) => renderRatioButton(option, option.id === aspectRatio, () => applyVideoMediaPreset({ aspectRatio: option.id })))}
        </div>
        <div className="media-options-note">按 AnyCap model schema 限制可选项</div>
      </div>
    );
  };

  const selectModel = (tool: ProviderTool, nextModel: ModelOption) => {
    const nextOptions = normalizeOptionsForModel(node.data.kind, nextModel.id, {
      ...options,
      providerTool: tool.id,
      model: nextModel.id,
    });
    updateNodeData(node.id, {
      provider: toolLabelForKind(tool, node.data.kind),
      model: nextModel.id,
      providerOptions: nextOptions,
    });
    setModelMenuToolId(tool.id);
    setModelMenuOpen(false);
  };

  const removeReference = (reference: NodeReference) => {
    const targetPart = promptParts.find((part) => part.type === 'mention' && referenceKey(part.reference) === referenceKey(reference));
    const nextPrompt = targetPart ? removePromptRanges(node.data.prompt, [{ start: targetPart.start, end: targetPart.end }]).prompt : node.data.prompt;
    updateNodeData(node.id, {
      prompt: nextPrompt,
      references: references.filter((item) => referenceKey(item) !== referenceKey(reference)),
    });
  };

  const removeMentionPart = (part: Extract<PromptPart, { type: 'mention' }>) => {
    const nextPrompt = removePromptRanges(node.data.prompt, [{ start: part.start, end: part.end }]);
    updateNodeData(node.id, {
      prompt: nextPrompt.prompt,
      references: references.filter((reference) => referenceKey(reference) !== referenceKey(part.reference)),
    });
    mentionTriggerIndexRef.current = null;
    setMentionOpen(false);
    restoreCaret(nextPrompt.caretIndex);
  };

  const handleMentionDelete = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
    const textarea = event.currentTarget;
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const deletion = mentionDeletionTarget(promptParts, selectionStart, selectionEnd, event.key);
    if (!deletion) return false;

    event.preventDefault();
    const nextPrompt = removePromptRanges(node.data.prompt, deletion.ranges);
    updateNodeData(node.id, {
      prompt: nextPrompt.prompt,
      references: references.filter((reference) => !deletion.referenceKeys.has(referenceKey(reference))),
    });
    mentionTriggerIndexRef.current = null;
    setMentionOpen(false);
    restoreCaret(nextPrompt.caretIndex);
    return true;
  };

  const addReference = (reference: NodeReference) => {
    const exists = references.some((item) => referenceKey(item) === referenceKey(reference));
    const nextReferences = exists ? references : [...references, reference];
    const limitMessage = referenceLimitMessage(node.data.kind, model, nextReferences, String(options.mode ?? ''));
    if (limitMessage) {
      setReferenceWarning(limitMessage);
      return;
    }
    const textarea = textareaRef.current;
    const caretIndex = textarea?.selectionStart ?? caretIndexRef.current ?? node.data.prompt.length;
    const nextMention = insertReferenceMention(node.data.prompt, reference, mentionTriggerIndexRef.current, caretIndex);
    updateNodeData(node.id, {
      prompt: nextMention.prompt,
      references: nextReferences,
    });
    setReferenceWarning('');
    setMentionOpen(false);
    mentionTriggerIndexRef.current = null;
    restoreCaret(nextMention.caretIndex);
  };

  const renderVisualCaret = (key: string) => (promptFocused ? <span className="composer-visual-caret" key={key} /> : null);

  const renderPromptPart = (part: PromptPart) => {
    const caretIsInside = promptFocused && visualCaretIndex > part.start && visualCaretIndex <= part.end;
    const caretIsAtStart = promptFocused && visualCaretIndex === part.start;

    if (part.type === 'text') {
      if (!caretIsInside && !caretIsAtStart) return <span key={part.key}>{part.text}</span>;
      const offset = Math.max(0, Math.min(visualCaretIndex - part.start, part.text.length));
      return (
        <span key={part.key}>
          {part.text.slice(0, offset)}
          {renderVisualCaret(`${part.key}-caret`)}
          {part.text.slice(offset)}
        </span>
      );
    }
    const Icon = iconByOutput[part.reference.outputType];
    const badgeLabel: Partial<Record<NodeReference['outputType'], string>> = {
      text: 'TEXT',
      image: 'IMG',
      video: 'VID',
      audio: 'AUD',
      other: 'AI',
    };
    const token = (
      <button
        className={`prompt-mention-token mention-${part.reference.outputType}`}
        key={`${part.key}-token`}
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => removeMentionPart(part)}
        title="删除这个引用"
      >
        {part.reference.thumbnailUrl ? (
          <img src={part.reference.thumbnailUrl} alt="" />
        ) : (
          <span className="prompt-mention-badge">
            {part.reference.outputType === 'other' ? <Icon size={12} /> : badgeLabel[part.reference.outputType]}
          </span>
        )}
        <span>{part.reference.title}</span>
        <X size={13} />
      </button>
    );
    if (caretIsAtStart) return <span key={part.key}>{renderVisualCaret(`${part.key}-caret-before`)}{token}</span>;
    if (caretIsInside) return <span key={part.key}>{token}{renderVisualCaret(`${part.key}-caret-after`)}</span>;
    return token;
  };

  const renderPromptContent = () => {
    if (!node.data.prompt) return <span className="composer-prompt-placeholder">{placeholderFor(node.data.kind)}</span>;
    if (!promptParts.length) return promptFocused && visualCaretIndex === 0 ? renderVisualCaret('empty-caret') : null;
    const content = promptParts.map(renderPromptPart);
    if (promptFocused && visualCaretIndex === 0 && promptParts[0]?.start !== 0) {
      const startCaret = renderVisualCaret('prompt-start-caret');
      if (startCaret) content.unshift(startCaret);
    }
    if (promptFocused && visualCaretIndex >= node.data.prompt.length) {
      const lastPart = promptParts[promptParts.length - 1];
      const endCaret = renderVisualCaret('prompt-end-caret');
      if (endCaret && (!lastPart || visualCaretIndex > lastPart.end)) content.push(endCaret);
    }
    return content;
  };

  const handleRun = () => {
    const normalizedOptions = normalizeOptionsForModel(node.data.kind, model, {
      ...options,
      ...(node.data.kind === 'image' ? { referenceQuality: imageReferenceQuality } : {}),
      providerTool: activeTool?.id,
      model,
    });
    const limitMessage = referenceLimitMessage(node.data.kind, model, references, String(normalizedOptions.mode ?? ''));
    if (limitMessage) {
      setReferenceWarning(limitMessage);
      return;
    }
    updateNodeData(node.id, {
      provider: toolLabelForKind(activeTool, node.data.kind) || node.data.provider,
      model,
      providerOptions: normalizedOptions,
    });
    void runNode(node.id);
  };

  const renderVideoReferenceCounters = () => {
    if (!videoReferenceCapability) return null;
    const labels: Partial<Record<NodeReference['outputType'], string>> = {
      image: '图',
      video: '视',
      audio: '音',
    };
    return (
      <div className="video-reference-counters">
        {(['image', 'video', 'audio'] as const)
          .filter((type) => (activeVideoReferenceLimits[type] ?? 0) > 0)
          .map((type) => (
            <span key={type}>
              {labels[type]} {videoReferenceCounts[type] ?? 0}/{activeVideoReferenceLimits[type]}
            </span>
          ))}
        {String(options.mode ?? '') === 'multi-shot-video' && <span>Shot {Number(options.shotCount ?? 3)}</span>}
      </div>
    );
  };

  const footer = (() => {
    if (node.data.kind === 'text' || node.data.kind === 'storyboard') {
      return (
        <>
          <label>
            <span>温度</span>
            <input
              max="2"
              min="0"
              step="0.1"
              type="number"
              value={String(options.temperature ?? 0.8)}
              onChange={(event) => updateOptions({ temperature: Number(event.currentTarget.value) })}
            />
          </label>
          {node.data.kind === 'storyboard' && (
            <label className="storyboard-shot-count-control">
              <span>镜头数</span>
              <input
                max="20"
                min="1"
                step="1"
                type="number"
                value={String(options.shotCount ?? 5)}
                onChange={(event) => updateOptions({
                  shotCount: Math.max(1, Math.min(20, Math.round(Number(event.currentTarget.value) || 1))),
                })}
              />
            </label>
          )}
        </>
      );
    }
    if (node.data.kind === 'image') {
      const resolutionTier = imageResolutionTier(options);
      const aspectRatio = aspectRatioOf(options);
      return (
        <>
          <div className="composer-option-wrap">
            <button
              className={`composer-option-pill ${optionPanelOpen === 'image-size' ? 'is-active' : ''}`}
              type="button"
              onClick={() => toggleOptionPanel('image-size')}
            >
              <LayoutGrid size={16} />
              <span>{aspectRatioLabel(aspectRatio)} · {resolutionTier}</span>
            </button>
            {optionPanelOpen === 'image-size' && renderImageSizePanel()}
          </div>
          <button
            className="composer-count-pill"
            type="button"
            onClick={() => updateOptions({ count: Number(options.count ?? 1) >= 4 ? 1 : Number(options.count ?? 1) + 1 })}
            aria-label="切换生成数量"
          >
            {Number(options.count ?? 1)}x
          </button>
        </>
      );
    }
    if (node.data.kind === 'video') {
      const capability = videoCapability(model);
      const resolution = String(options.resolution ?? capability.resolutions[0] ?? '');
      const aspectRatio = aspectRatioOf(options);
      const modeLabels: Record<string, string> = {
        'multi-modal-reference': '多参考',
        'multi-shot-video': '多 Shot',
        'text-to-video': '文生视频',
        'image-to-video': '图生视频',
        'edit-video': '视频编辑',
        'video-to-video': '视频参考',
      };
      return (
        <>
          <label>
            <span>模式</span>
            <select
              value={String(options.mode ?? capability.defaultMode)}
              disabled={capability.modes.length <= 1}
              onChange={(event) => updateOptions({ mode: event.currentTarget.value })}
            >
              {capability.modes.map((mode) => (
                <option key={mode} value={mode}>
                  {modeLabels[mode] ?? mode}
                </option>
              ))}
            </select>
          </label>
          {(capability.resolutions.length > 0 || capability.aspectRatios.length > 0) && (
            <div className="composer-option-wrap">
              <button
                className={`composer-option-pill ${optionPanelOpen === 'video-size' ? 'is-active' : ''}`}
                type="button"
                onClick={() => toggleOptionPanel('video-size')}
              >
                <LayoutGrid size={16} />
                <span>{aspectRatioLabel(aspectRatio)}{resolution ? ` · ${resolution}` : ''}</span>
              </button>
              {optionPanelOpen === 'video-size' && renderVideoSizePanel()}
            </div>
          )}
          <label>
            <span>时长</span>
            <select value={String(options.duration ?? capability.defaultDuration)} onChange={(event) => updateOptions({ duration: Number(event.currentTarget.value) })}>
              {capability.durations.map((duration) => (
                <option key={duration} value={duration}>
                  {duration}S
                </option>
              ))}
            </select>
          </label>
          {String(options.mode ?? capability.defaultMode) === 'multi-shot-video' && (
            <label>
              <span>Shot</span>
              <select value={String(options.shotCount ?? 3)} onChange={(event) => updateOptions({ shotCount: Number(event.currentTarget.value) })}>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
              </select>
            </label>
          )}
        </>
      );
    }
    return (
      <>
        <button
          className={`audio-mode-pill ${String(options.voiceMode ?? 'voice-reference') === 'voice-conversion' ? 'is-active' : ''}`}
          type="button"
          onClick={() =>
            updateOptions({
              voiceMode: String(options.voiceMode ?? 'voice-reference') === 'voice-conversion' ? 'voice-reference' : 'voice-conversion',
            })
          }
        >
          <Music size={16} />
          <span>音色转换</span>
        </button>
        <label>
          <span>风格</span>
          <input value={String(options.style ?? 'cinematic')} onChange={(event) => updateOptions({ style: event.currentTarget.value })} />
        </label>
        <label>
          <span>时长</span>
          <input
            min="5"
            step="5"
            type="number"
            value={String(options.duration ?? 30)}
            onChange={(event) => updateOptions({ duration: Number(event.currentTarget.value) })}
          />
        </label>
      </>
    );
  })();

  return (
    <section
      className={`generation-composer is-node-attached is-expanded composer-${node.data.kind} input-font-${inputFontSize} input-surface-${inputSurface} ${composerResizable ? 'is-user-resizable' : ''}`}
      style={positionStyle}
      aria-label="节点生成器"
    >
      <div className="composer-tools">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const textarea = textareaRef.current;
            if (textarea) {
              rememberCaret(textarea);
              textarea.focus();
            }
            mentionTriggerIndexRef.current = null;
            setOptionPanelOpen(null);
            setModelMenuOpen(false);
            setMentionOpen((open) => !open);
          }}
          aria-label="@ 引用素材"
        >
          <AtSign size={18} />
        </button>
        {node.data.kind === 'audio' && (
          <>
            <button
              className={`voice-reference-chip ${references.some((reference) => reference.outputType === 'audio') ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                updateOptions({ voiceMode: 'voice-reference' });
                mentionTriggerIndexRef.current = null;
                setMentionOpen(true);
              }}
            >
              <Mic2 size={15} />
              <span>参考音色</span>
            </button>
            <button
              className={`voice-reference-chip ${String(options.voiceMode ?? '') === 'voice-conversion' ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                updateOptions({ voiceMode: 'voice-conversion' });
                mentionTriggerIndexRef.current = null;
                setMentionOpen(true);
              }}
            >
              <Music size={15} />
              <span>目标音色</span>
            </button>
          </>
        )}
        {renderVideoReferenceCounters()}
        {references.map((reference) => {
          const Icon = iconByOutput[reference.outputType];
          return (
            <button className="reference-chip" key={referenceKey(reference)} type="button">
              {reference.thumbnailUrl ? <img src={reference.thumbnailUrl} alt="" /> : <Icon size={16} />}
              <span>{reference.title}</span>
              <X size={13} onClick={() => removeReference(reference)} />
            </button>
          );
        })}
      </div>

      {mentionOpen && (
        <div className="mention-popover">
          <div className="mention-popover-title">@ 引用当前画布资产</div>
          <div className="mention-list">
            {groupCandidates.length > 0 && (
              <div className="mention-group-list">
                {groupCandidates.map(({ group, references: groupReferences }) => (
                  <div className="mention-group" key={group.id}>
                    <button
                      className="mention-group-trigger"
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExpandedGroupId((current) => (current === group.id ? '' : group.id))}
                    >
                      <LayoutGrid size={18} />
                      <span>{group.name}</span>
                      <small>{groupReferences.length} 个节点</small>
                      <ChevronRight size={15} />
                    </button>
                    {expandedGroupId === group.id && (
                      <div className="mention-group-members">
                        {groupReferences.map((reference) => {
                          const Icon = iconByOutput[reference.outputType];
                          return (
                            <button
                              key={referenceKey(reference)}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => addReference(reference)}
                            >
                              {reference.thumbnailUrl ? <img src={reference.thumbnailUrl} alt="" /> : <Icon size={18} />}
                              <span>{reference.title}</span>
                              <small>{reference.outputType.toUpperCase()}</small>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {candidates.length > 0 ? (
              candidates.map((candidate) => {
                const Icon = iconByOutput[candidate.outputType];
                return (
                  <button
                    key={referenceKey(candidate)}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => addReference(candidate)}
                  >
                    {candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" /> : <Icon size={18} />}
                    <span>{candidate.title}</span>
                    <small>
                      {referenceSelectionIds.includes(candidate.nodeId)
                        ? '圈选组'
                        : candidate.source === 'canvas'
                          ? '画布节点'
                          : '输出文件'}
                    </small>
                  </button>
                );
              })
            ) : (
              groupCandidates.length === 0 && <div className="mention-empty">没有可引用的兼容素材</div>
            )}
          </div>
        </div>
      )}

      {referenceWarning && <div className="composer-reference-warning">{referenceWarning}</div>}

      <div className="composer-prompt-field">
        <div className={`composer-prompt-render ${node.data.prompt ? '' : 'is-empty'}`} ref={promptRenderRef} aria-hidden="true">
          {renderPromptContent()}
        </div>
        <textarea
          ref={textareaRef}
          value={node.data.prompt}
          placeholder={placeholderFor(node.data.kind)}
          onChange={(event) => {
            const nextPrompt = event.currentTarget.value;
            const caretIndex = event.currentTarget.selectionStart ?? nextPrompt.length;
            caretIndexRef.current = caretIndex;
            setVisualCaretIndex(caretIndex);
            updateNodeData(node.id, { prompt: nextPrompt });
            syncPromptScroll(event.currentTarget);
            if (caretIndex > 0 && nextPrompt[caretIndex - 1] === '@') {
              mentionTriggerIndexRef.current = caretIndex - 1;
              setMentionOpen(true);
            }
          }}
          onClick={(event) => rememberCaret(event.currentTarget)}
          onKeyUp={(event) => rememberCaret(event.currentTarget)}
          onScroll={(event) => syncPromptScroll(event.currentTarget)}
          onSelect={(event) => rememberCaret(event.currentTarget)}
          onFocus={(event) => {
            setPromptFocused(true);
            rememberCaret(event.currentTarget);
          }}
          onBlur={(event) => {
            rememberCaret(event.currentTarget);
            setPromptFocused(false);
          }}
          onKeyDown={(event) => {
            if (handleMentionDelete(event)) return;
            if (event.key === '@') {
              mentionTriggerIndexRef.current = event.currentTarget.selectionStart ?? node.data.prompt.length;
              setMentionOpen(true);
            }
            if (event.key === 'Escape') {
              mentionTriggerIndexRef.current = null;
              setMentionOpen(false);
            }
            const shouldSubmit =
              event.key === 'Enter' &&
              (enterBehavior === 'send' ? !event.shiftKey : event.metaKey || event.ctrlKey);
            if (shouldSubmit) {
              event.preventDefault();
              if (!running) handleRun();
            }
          }}
        />
      </div>

      <footer className="composer-footer">
        <div className="composer-provider-wrap">
          <button
            className="composer-provider"
            type="button"
            onClick={() => {
              setModelMenuToolId(activeTool?.id ?? '');
              setOptionPanelOpen(null);
              mentionTriggerIndexRef.current = null;
              setMentionOpen(false);
              setModelMenuOpen((open) => !open);
            }}
            aria-expanded={modelMenuOpen}
            aria-label="选择工具和模型"
          >
            <span>{activeTool?.badge ?? 'AI'}</span>
            <strong>{activeModel.label}</strong>
          </button>
          {modelMenuOpen && (
            <div className={`model-picker-popover picker-${node.data.kind}`} aria-label="工具模型选择">
              <div className="model-tool-list">
                {availableTools.map((tool) => (
                  <button
                    className={`${tool.id === pickerTool?.id ? 'is-active' : ''} tool-${tool.id}`}
                    key={tool.id}
                    type="button"
                    onClick={() => setModelMenuToolId(tool.id)}
                  >
                    <span className={`model-badge badge-${tool.id}`}>{tool.badge}</span>
                    <strong>{toolLabelForKind(tool, node.data.kind)}</strong>
                    <small>{toolDescriptionForKind(tool, node.data.kind)}</small>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              <div className="model-choice-list">
                <div className="model-choice-title">{toolLabelForKind(pickerTool, node.data.kind) || '模型'}</div>
                {(pickerModels.length ? pickerModels : [{ id: model, label: model }]).map((item) => (
                  <button
                    className={item.id === model ? 'is-active' : ''}
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (pickerTool) selectModel(pickerTool, item);
                    }}
                  >
                    <span className={`model-badge badge-${pickerTool?.id ?? 'default'}`}>{pickerTool?.badge ?? 'AI'}</span>
                    <strong>{item.label}</strong>
                    {item.hint && <small>{item.hint}</small>}
                    {item.id === model && <Check size={17} />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="composer-options">
        {(node.data.kind === 'text' || node.data.kind === 'storyboard') && <Settings2 size={16} />}
          {footer}
        </div>
        <button className="composer-submit" type="button" disabled={running} onClick={handleRun} aria-label="生成">
          <Send size={22} />
        </button>
      </footer>
    </section>
  );
}
