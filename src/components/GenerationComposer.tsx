import { useReactFlow, useViewport } from '@xyflow/react';
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GripVertical,
  Image,
  LayoutGrid,
  Mic2,
  Music,
  Send,
  Settings2,
  Sparkles,
  Video,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { useSettingsStore } from '../store/settingsStore';
import type { NodeKind, NodeReference, PromptMention, ProviderOptions, StudioNode } from '../types';
import {
  nodeToReference,
  referenceKey,
} from '../utils/nodeReferences';

const supportedKinds = new Set<NodeKind>(['text', 'image', 'video', 'audio', 'storyboard']);
const COMPOSER_LAYOUT_STORAGE_KEY = 'selfcanvas.composer-layout.v1';

interface ComposerLayout {
  width: number;
  promptHeight: number;
}

type ComposerLayouts = Partial<Record<NodeKind, ComposerLayout>>;

interface ComposerResizeDrag {
  pointerId: number;
  kind: NodeKind;
  startX: number;
  startY: number;
  startWidth: number;
  startPromptHeight: number;
  minWidth: number;
  maxWidth: number;
  minPromptHeight: number;
  maxPromptHeight: number;
}

interface PromptSelectionDrag {
  pointerId: number;
  anchorIndex: number;
}

type ComposerPositionStyle = CSSProperties & { '--composer-prompt-height'?: string };

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readComposerLayouts(): ComposerLayouts {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPOSER_LAYOUT_STORAGE_KEY) || '{}') as Record<string, unknown>;
    const layouts: ComposerLayouts = {};
    supportedKinds.forEach((kind) => {
      const value = parsed[kind];
      if (!value || typeof value !== 'object') return;
      const width = Number((value as Partial<ComposerLayout>).width);
      const promptHeight = Number((value as Partial<ComposerLayout>).promptHeight);
      if (!Number.isFinite(width) || !Number.isFinite(promptHeight)) return;
      layouts[kind] = { width, promptHeight };
    });
    return layouts;
  } catch {
    return {};
  }
}

function saveComposerLayouts(layouts: ComposerLayouts) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPOSER_LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Resizing must remain usable even when browser storage is unavailable.
  }
}

function composerMinimumWidth(kind: NodeKind) {
  if (kind === 'video') return 720;
  if (kind === 'image') return 500;
  if (kind === 'storyboard') return 520;
  return 480;
}

function composerDefaultPromptHeight(kind: NodeKind) {
  return kind === 'image' ? 142 : 124;
}

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

type OptionPanelId = 'image-size' | 'video-size' | 'audio-settings' | null;

interface RatioOption {
  id: string;
  label: string;
  iconWidth: number;
  iconHeight: number;
  featured?: boolean;
}

interface ComposerSelectOption {
  value: string;
  label: string;
}

function ComposerSelect({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: ComposerSelectOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutside, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="composer-select" ref={rootRef}>
      <button
        className={`composer-select-trigger ${open ? 'is-open' : ''}`}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={15} />
      </button>
      {open && !disabled && (
        <div className="composer-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              className={option.value === value ? 'is-selected' : ''}
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
      image: 'AnyCap 图片',
      audio: 'AnyCap 音频',
    },
    badge: 'AC',
    description: '本地 AnyCap CLI / 网关媒体任务',
    descriptionByKind: {
      image: 'AnyCap 多模型图片生成',
      audio: '本地 AnyCap 网关',
    },
    models: {
      image: [
        { id: 'gpt-image-2', label: 'GPT Image 2', hint: '高保真生成 / 图片编辑' },
        { id: 'flux-kontext-max', label: 'FLUX.1 Kontext Max', hint: '高细节生成 / 迭代编辑' },
        { id: 'nano-banana-pro', label: 'Nano Banana Pro', hint: '高质量参考图生成' },
        { id: 'nano-banana-2', label: 'Nano Banana 2', hint: '文生图 / 参考图' },
        { id: 'qwen-image', label: 'Qwen Image', hint: '中英文文字理解 / 图片编辑' },
        { id: 'seedream-5', label: 'Seedream 5', hint: '高质量图片生成' },
        { id: 'seedream-4.5', label: 'Seedream 4.5', hint: '稳定图片编辑 / 风格转换' },
      ],
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
        { id: 'doubao-seed-audio-1-0', label: 'Doubao Seed Audio 1.0', hint: '文本 / 音频 / 图片生成音频' },
        { id: 'elevanlabs-music', label: 'ElevenLabs Music', hint: '文本生成音乐' },
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
  if (kind === 'audio' && model === 'anycap-audio') return 'elevanlabs-music';
  if (model && !model.startsWith('mock-') && !model.startsWith('local-')) return model;
  if (kind === 'text') return 'gpt-4o-mini';
  if (kind === 'image') return 'gpt-image-2';
  if (kind === 'video') return 'seedance-2-fast';
  if (kind === 'audio') return 'doubao-seed-audio-1-0';
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
      operation: 'generate',
      transition: 'cut',
      transitionDuration: 0.5,
      audioPolicy: 'keep',
    };
  }
  if (kind === 'audio') {
    if (resolvedModel === 'doubao-seed-audio-1-0') {
      return {
        providerTool: 'anycap',
        model: resolvedModel,
        mode: 'text-to-audio',
        format: 'mp3',
        sampleRate: 24000,
        speechRate: 0,
        pitchRate: 0,
        loudnessRate: 0,
        enableSubtitle: false,
        speakerIds: [],
      };
    }
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

const DOUBAO_AUDIO_MODEL = 'doubao-seed-audio-1-0';
const doubaoAudioModes = ['text-to-audio', 'audio-to-audio', 'image-to-audio'] as const;
const doubaoAudioSampleRates = [8000, 16000, 24000, 32000, 44100, 48000];
const doubaoAudioModeLabels: Record<(typeof doubaoAudioModes)[number], string> = {
  'text-to-audio': '文本生成音频',
  'audio-to-audio': '音频参考',
  'image-to-audio': '图片参考',
};

function isDoubaoAudioModel(model: string) {
  return String(model || '').trim() === DOUBAO_AUDIO_MODEL;
}

function doubaoAudioReferenceLimits(mode: string) {
  if (mode === 'audio-to-audio') return { image: 0, video: 0, audio: 3 };
  if (mode === 'image-to-audio') return { image: 1, video: 0, audio: 0 };
  return { image: 0, video: 0, audio: 0 };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback = 0) {
  const parsed = Math.round(Number(value));
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
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
  supportsGenerateAudio?: boolean;
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
    supportsGenerateAudio: true,
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
    supportsGenerateAudio: true,
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
    supportsGenerateAudio: true,
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
    supportsGenerateAudio: true,
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
    supportsGenerateAudio: true,
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

function videoReferenceLimits(model: string, mode?: string, operation?: string) {
  if (operation === 'ai-edit' || operation === 'concat') return { image: 0, video: 20, audio: 0 };
  if (operation === 'creative-edit') return { image: 0, video: 3, audio: 0 };
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
  if (kind === 'audio') {
    if (!isDoubaoAudioModel(model)) return { ...options, model };
    const requestedMode = String(options.mode ?? '');
    const mode = doubaoAudioModes.includes(requestedMode as (typeof doubaoAudioModes)[number])
      ? requestedMode
      : 'text-to-audio';
    const requestedFormat = String(options.format ?? 'mp3').toLowerCase();
    const requestedSampleRate = Number(options.sampleRate ?? 24000);
    const sampleRate = doubaoAudioSampleRates.includes(requestedSampleRate)
      ? requestedSampleRate
      : 24000;
    const speakerIds = Array.isArray(options.speakerIds)
      ? options.speakerIds.map((item) => String(item).trim()).filter(Boolean).slice(0, 1)
      : [];
    return {
      ...options,
      providerTool: 'anycap',
      model: DOUBAO_AUDIO_MODEL,
      mode,
      format: requestedFormat === 'wav' ? 'wav' : 'mp3',
      sampleRate,
      speechRate: clampInteger(options.speechRate, -50, 100),
      pitchRate: clampInteger(options.pitchRate, -12, 12),
      loudnessRate: clampInteger(options.loudnessRate, -50, 100),
      enableSubtitle: options.enableSubtitle === true,
      speakerIds: mode === 'text-to-audio' ? speakerIds : [],
    };
  }
  if (kind !== 'video') return options;
  const operation = String(options.operation ?? 'generate');
  if (operation === 'ai-edit' || operation === 'concat') {
    return {
      ...options,
      providerTool: 'local-edit',
      model: 'selfcanvas-smart-edit',
      mode: operation,
      operation,
      resolution: String(options.resolution ?? '720p'),
      aspectRatio: String(options.aspectRatio ?? 'adaptive'),
      fps: Math.max(12, Math.min(60, Number(options.fps ?? 30))),
      format: 'mp4',
      transition: options.transition === 'crossfade' ? 'crossfade' : 'cut',
      transitionDuration: Math.max(0.1, Math.min(2, Number(options.transitionDuration ?? 0.5))),
      audioPolicy: options.audioPolicy === 'mute' || options.audioPolicy === 'normalize' ? options.audioPolicy : 'keep',
      planOnly: options.planOnly === true,
    };
  }
  if (operation === 'creative-edit') {
    model = 'gemini-omni-flash-preview';
    options = { ...options, providerTool: 'anycap', model, mode: 'edit-video', operation };
  }
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
  if (capability.supportsGenerateAudio) {
    nextOptions.generateAudio = typeof options.generateAudio === 'boolean' ? options.generateAudio : true;
  } else {
    delete nextOptions.generateAudio;
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

function referenceLimitMessage(kind: NodeKind, model: string, references: NodeReference[], mode?: string, operation?: string) {
  const limits = kind === 'video'
    ? videoReferenceLimits(model, mode, operation)
    : kind === 'audio' && isDoubaoAudioModel(model)
      ? doubaoAudioReferenceLimits(String(mode ?? 'text-to-audio'))
      : null;
  if (!limits) return '';
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
      const displayModel = isDoubaoAudioModel(model) ? 'Doubao Seed Audio 1.0' : model;
      if (limit <= 0) return `${displayModel} 当前模式暂不支持${names[type]}`;
      return `${displayModel} 最多支持 ${limit} 个${names[type]}，当前是 ${count} 个`;
    }
  }
  return '';
}

function compatibleOutputs(kind: NodeKind, model = '', mode = '', operation = ''): Set<NodeReference['outputType']> {
  if (kind === 'image') return new Set<NodeReference['outputType']>(['image', 'text']);
  if (kind === 'video') {
    const limits = videoReferenceLimits(model, mode, operation);
    if (operation === 'ai-edit' || operation === 'concat' || operation === 'creative-edit') {
      return new Set<NodeReference['outputType']>(['video']);
    }
    return new Set<NodeReference['outputType']>([
      'text',
      ...(['image', 'video', 'audio'] as const).filter((type) => (limits[type] ?? 0) > 0),
    ]);
  }
  if (kind === 'audio') {
    if (!isDoubaoAudioModel(model)) return new Set<NodeReference['outputType']>(['audio', 'text']);
    const limits = doubaoAudioReferenceLimits(mode);
    return new Set<NodeReference['outputType']>([
      'text',
      ...(['image', 'audio'] as const).filter((type) => (limits[type] ?? 0) > 0),
    ]);
  }
  if (kind === 'text' || kind === 'storyboard') return new Set<NodeReference['outputType']>(['text', 'image', 'video', 'audio']);
  return new Set<NodeReference['outputType']>(['text', 'image', 'video', 'audio']);
}

function placeholderFor(kind: NodeKind, compact = false) {
  if (kind === 'video') return compact ? '描述视频内容' : '描述视频内容，@ 引用素材，Enter 生成';
  if (kind === 'image') return compact ? '描述图片内容' : '描述图片内容，@ 引用素材，Enter 生成';
  if (kind === 'audio') return compact ? '描述声音内容' : '描述旁白、音效或环境声，按模式 @ 引用素材';
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
    editStart: triggerIndex,
    editEnd: triggerIndex + 1,
    insertedLength: mention.length + suffix.length,
    mentionStart: before.length,
    mentionEnd: before.length + mention.length,
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
    editStart: clampedCaret,
    editEnd: clampedCaret,
    insertedLength: prefix.length + mention.length + suffix.length,
    mentionStart: before.length + prefix.length,
    mentionEnd: before.length + prefix.length + mention.length,
  };
}

type PromptPart =
  | { type: 'text'; text: string; start: number; end: number; key: string }
  | {
      type: 'mention';
      text: string;
      reference: NodeReference;
      mention: PromptMention;
      start: number;
      end: number;
      key: string;
    };

function referenceMention(reference: NodeReference) {
  return `@${reference.title}`;
}

function newPromptMentionId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `mention_${crypto.randomUUID()}`
    : `mention_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function tokenizeBoundPromptMentions(
  prompt: string,
  references: NodeReference[],
  mentions: PromptMention[],
): PromptPart[] {
  const referencesByKey = new Map(references.map((reference) => [referenceKey(reference), reference]));
  const validMentions = mentions
    .map((mention) => ({
      ...mention,
      start: clampIndex(mention.start, prompt.length),
      end: clampIndex(mention.end, prompt.length),
    }))
    .filter((mention) => {
      const reference = referencesByKey.get(mention.referenceKey);
      return Boolean(reference && mention.end > mention.start && prompt.slice(mention.start, mention.end) === mention.text);
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((mention, index, sorted) => index === 0 || mention.start >= sorted[index - 1].end);

  if (!validMentions.length) {
    return prompt ? [{ type: 'text', text: prompt, start: 0, end: prompt.length, key: 'text-0' }] : [];
  }

  const parts: PromptPart[] = [];
  let cursor = 0;
  for (const mention of validMentions) {
    if (cursor < mention.start) {
      parts.push({ type: 'text', text: prompt.slice(cursor, mention.start), start: cursor, end: mention.start, key: `text-${cursor}` });
    }
    const reference = referencesByKey.get(mention.referenceKey);
    if (!reference) continue;
    parts.push({
      type: 'mention',
      text: mention.text,
      reference,
      mention,
      start: mention.start,
      end: mention.end,
      key: mention.id,
    });
    cursor = mention.end;
  }
  if (cursor < prompt.length) {
    parts.push({ type: 'text', text: prompt.slice(cursor), start: cursor, end: prompt.length, key: `text-${cursor}` });
  }
  return parts;
}

function tokenizeLegacyPromptMentions(prompt: string, references: NodeReference[]): PromptPart[] {
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
    const reference = referencesForMention.length ? referencesForMention[used % referencesForMention.length] : undefined;
    usedByMention.set(matched, used + 1);
    if (reference) {
      const mention: PromptMention = {
        id: `legacy_${referenceKey(reference)}_${index}`,
        referenceKey: referenceKey(reference),
        text: matched,
        start: index,
        end: index + matched.length,
      };
      parts.push({
        type: 'mention',
        text: matched,
        reference,
        mention,
        start: index,
        end: index + matched.length,
        key: mention.id,
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

function tokenizePromptMentions(
  prompt: string,
  references: NodeReference[],
  mentions?: PromptMention[],
): PromptPart[] {
  return mentions === undefined
    ? tokenizeLegacyPromptMentions(prompt, references)
    : tokenizeBoundPromptMentions(prompt, references, mentions);
}

function mentionsFromPromptParts(parts: PromptPart[]) {
  return parts
    .filter((part): part is Extract<PromptPart, { type: 'mention' }> => part.type === 'mention')
    .map((part) => ({ ...part.mention }));
}

function shiftMentionsAfterEdit(
  mentions: PromptMention[],
  editStart: number,
  editEnd: number,
  insertedLength: number,
) {
  const delta = insertedLength - (editEnd - editStart);
  return mentions.flatMap((mention) => {
    if (mention.end <= editStart) return [mention];
    if (mention.start >= editEnd) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    }
    return [];
  });
}

function reconcileMentionsAfterTextEdit(
  previousPrompt: string,
  nextPrompt: string,
  mentions: PromptMention[],
) {
  if (previousPrompt === nextPrompt) return mentions;
  let prefixLength = 0;
  while (
    prefixLength < previousPrompt.length &&
    prefixLength < nextPrompt.length &&
    previousPrompt[prefixLength] === nextPrompt[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < previousPrompt.length - prefixLength &&
    suffixLength < nextPrompt.length - prefixLength &&
    previousPrompt[previousPrompt.length - 1 - suffixLength] === nextPrompt[nextPrompt.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  const editEnd = previousPrompt.length - suffixLength;
  const insertedLength = nextPrompt.length - prefixLength - suffixLength;
  return shiftMentionsAfterEdit(mentions, prefixLength, editEnd, insertedLength)
    .filter((mention) => nextPrompt.slice(mention.start, mention.end) === mention.text);
}

function normalizedPromptRanges(promptLength: number, ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges
    .map((range) => ({ start: clampIndex(range.start, promptLength), end: clampIndex(range.end, promptLength) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function removePromptRanges(prompt: string, ranges: Array<{ start: number; end: number }>) {
  const merged = normalizedPromptRanges(prompt.length, ranges);
  if (!merged.length) return { prompt, caretIndex: prompt.length, ranges: merged };

  let nextPrompt = '';
  let cursor = 0;
  for (const range of merged) {
    nextPrompt += prompt.slice(cursor, range.start);
    cursor = range.end;
  }
  nextPrompt += prompt.slice(cursor);
  return { prompt: nextPrompt, caretIndex: merged[0].start, ranges: merged };
}

function shiftMentionsAfterRemovedRanges(
  mentions: PromptMention[],
  ranges: Array<{ start: number; end: number }>,
  promptLength: number,
) {
  const merged = normalizedPromptRanges(promptLength, ranges);
  return mentions.flatMap((mention) => {
    if (merged.some((range) => mention.start < range.end && mention.end > range.start)) return [];
    const removedBefore = merged
      .filter((range) => range.end <= mention.start)
      .reduce((total, range) => total + range.end - range.start, 0);
    return [{ ...mention, start: mention.start - removedBefore, end: mention.end - removedBefore }];
  });
}

function referencesAfterMentionChange(
  references: NodeReference[],
  previousMentions: PromptMention[],
  nextMentions: PromptMention[],
) {
  const previousKeys = new Set(previousMentions.map((mention) => mention.referenceKey));
  const nextKeys = new Set(nextMentions.map((mention) => mention.referenceKey));
  return references.filter((reference) => {
    const key = referenceKey(reference);
    return !previousKeys.has(key) || nextKeys.has(key);
  });
}

function promptIndexFromVisualPoint(root: HTMLElement, clientX: number, clientY: number, promptLength: number) {
  const segmentFromElement = (element: Element | null) => {
    const segment = element?.closest<HTMLElement>('[data-prompt-start]') ?? null;
    return segment && root.contains(segment) ? segment : null;
  };
  const segmentBounds = (segment: HTMLElement) => ({
    start: clampIndex(Number(segment.dataset.promptStart), promptLength),
    end: clampIndex(Number(segment.dataset.promptEnd), promptLength),
  });
  const hitSegment = segmentFromElement(document.elementFromPoint(clientX, clientY));
  if (hitSegment?.dataset.promptMention === 'true') {
    const { start, end } = segmentBounds(hitSegment);
    const rect = hitSegment.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2 ? start : end;
  }

  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caretPosition = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  const caretRange = caretPosition ? null : caretDocument.caretRangeFromPoint?.(clientX, clientY);
  const offsetNode = caretPosition?.offsetNode ?? caretRange?.startContainer;
  const offset = caretPosition?.offset ?? caretRange?.startOffset;
  const offsetElement = offsetNode instanceof Element ? offsetNode : offsetNode?.parentElement;
  const textSegment = segmentFromElement(offsetElement ?? null);
  if (textSegment && textSegment.dataset.promptMention !== 'true' && offsetNode && typeof offset === 'number') {
    const { start, end } = segmentBounds(textSegment);
    try {
      const range = document.createRange();
      range.setStart(textSegment, 0);
      const maxOffset = offsetNode.nodeType === Node.TEXT_NODE
        ? offsetNode.textContent?.length ?? 0
        : offsetNode.childNodes.length;
      range.setEnd(offsetNode, Math.max(0, Math.min(offset, maxOffset)));
      return Math.max(start, Math.min(end, start + range.toString().length));
    } catch {
      return clientX < textSegment.getBoundingClientRect().left ? start : end;
    }
  }

  const segments = Array.from(root.querySelectorAll<HTMLElement>('[data-prompt-start]'));
  if (!segments.length) return 0;
  const nearest = segments.reduce((best, segment) => {
    const rect = segment.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const distance = dx * dx + dy * dy;
    return !best || distance < best.distance ? { segment, distance } : best;
  }, null as { segment: HTMLElement; distance: number } | null)?.segment;
  if (!nearest) return promptLength;
  const { start, end } = segmentBounds(nearest);
  const rect = nearest.getBoundingClientRect();
  return clientX < rect.left + rect.width / 2 ? start : end;
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
      mentionIds: new Set(overlappingMentions.map((part) => part.mention.id)),
    };
  }

  const target =
    key === 'Backspace'
      ? mentionParts.find((part) => selectionStart > part.start && selectionStart <= part.end)
      : mentionParts.find((part) => selectionStart >= part.start && selectionStart < part.end);

  if (!target) return null;
  return {
    ranges: [{ start: target.start, end: target.end }],
    mentionIds: new Set([target.mention.id]),
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
  if (!nodeElement) return null;

  const visibleElements = [
    nodeElement,
    ...Array.from(
      nodeElement.querySelectorAll<HTMLElement>('.studio-node, .node-glass-surface, .node-video-info, .node-error'),
    ),
  ];
  const rects = visibleElements.map((element) => element.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function composerBounds(
  node: StudioNode,
  zoom: number,
  viewportX: number,
  viewportY: number,
  expanded: boolean,
  viewportWidth: number,
  viewportHeight: number,
  userLayout?: ComposerLayout,
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
        ? 880
        : node.data.kind === 'audio'
          ? 600
          : node.data.kind === 'storyboard'
            ? 660
            : 600;
  const minExpandedWidth =
    node.data.kind === 'video'
      ? 720
      : node.data.kind === 'image'
        ? 500
        : node.data.kind === 'storyboard'
          ? 520
          : 480;
  const preferredExpandedWidth = Math.max(minExpandedWidth, Math.min(expandedWidth, nodeScreenWidth + 220));
  const viewportWidthLimit = Math.max(320, viewportWidth - 120);
  const minimumWidth = Math.min(composerMinimumWidth(node.data.kind), viewportWidthLimit);
  const targetWidth = userLayout
    ? clampNumber(userLayout.width, minimumWidth, viewportWidthLimit)
    : expanded
      ? Math.min(preferredExpandedWidth, viewportWidthLimit)
      : Math.min(520, Math.max(320, nodeScreenWidth + 36));
  const promptHeightDelta = userLayout
    ? Math.max(0, userLayout.promptHeight - composerDefaultPromptHeight(node.data.kind))
    : 0;
  const expectedHeight = expanded ? (node.data.kind === 'video' ? 260 : 280) + promptHeightDelta : 58;
  const minTop = 74;
  const maxTop = viewportHeight - expectedHeight - 92;
  const belowTop = nodeBottom + 10;
  const aboveTop = nodeTop - expectedHeight - 10;
  // Keep the bottom-right quick action clear of the attached composer so the
  // generate button remains fully clickable on narrower Windows viewports.
  const left = Math.max(92, Math.min(nodeCenter - targetWidth / 2, viewportWidth - targetWidth - 92));
  const top = node.data.kind === 'video'
    ? Math.max(minTop, belowTop)
    : belowTop <= maxTop
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
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runNode = useCanvasStore((state) => state.runNode);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuToolId, setModelMenuToolId] = useState('');
  const [optionPanelOpen, setOptionPanelOpen] = useState<OptionPanelId>(null);
  const [referenceWarning, setReferenceWarning] = useState('');
  const [draggedReferenceKey, setDraggedReferenceKey] = useState('');
  const [visualCaretIndex, setVisualCaretIndex] = useState(0);
  const [promptSelection, setPromptSelection] = useState({ start: 0, end: 0 });
  const [promptFocused, setPromptFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptRenderRef = useRef<HTMLDivElement | null>(null);
  const promptSelectionDragRef = useRef<PromptSelectionDrag | null>(null);
  const caretIndexRef = useRef(0);
  const mentionTriggerIndexRef = useRef<number | null>(null);
  const enterBehavior = useSettingsStore((state) => state.settings.enterBehavior);
  const inputFontSize = useSettingsStore((state) => state.settings.inputFontSize);
  const inputSurface = useSettingsStore((state) => state.settings.inputSurface);
  const imageReferenceQuality = useSettingsStore((state) => state.settings.imageReferenceQuality);
  const composerResizable = useSettingsStore((state) => state.settings.composerResizable);
  const viewport = useViewport();
  const { setViewport: setFlowViewport } = useReactFlow<StudioNode>();
  const composerRef = useRef<HTMLElement | null>(null);
  const resizeDragRef = useRef<ComposerResizeDrag | null>(null);
  const [composerLayouts, setComposerLayouts] = useState<ComposerLayouts>(readComposerLayouts);
  const composerLayoutsRef = useRef(composerLayouts);
  const viewportRef = useRef(viewport);
  const [nodeLayoutVersion, setNodeLayoutVersion] = useState(0);
  const [windowSize, setWindowSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    composerLayoutsRef.current = composerLayouts;
  }, [composerLayouts]);

  useEffect(() => () => {
    resizeDragRef.current = null;
    document.documentElement.classList.remove('is-composer-resizing');
  }, []);

  useEffect(() => {
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const rememberCaret = (textarea: HTMLTextAreaElement) => {
    const selectionStart = textarea.selectionStart ?? textarea.value.length;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const caretIndex = textarea.selectionDirection === 'backward' ? selectionStart : selectionEnd;
    caretIndexRef.current = caretIndex;
    setVisualCaretIndex(caretIndex);
    setPromptSelection((current) =>
      current.start === selectionStart && current.end === selectionEnd
        ? current
        : { start: selectionStart, end: selectionEnd },
    );
  };

  const syncPromptScroll = (textarea: HTMLTextAreaElement) => {
    if (!promptRenderRef.current) return;
    promptRenderRef.current.scrollTop = textarea.scrollTop;
    promptRenderRef.current.scrollLeft = textarea.scrollLeft;
  };

  const syncTextareaScroll = (render: HTMLDivElement) => {
    if (!textareaRef.current) return;
    textareaRef.current.scrollTop = render.scrollTop;
    textareaRef.current.scrollLeft = render.scrollLeft;
  };

  const capturePromptScroll = () => ({
    top: promptRenderRef.current?.scrollTop ?? textareaRef.current?.scrollTop ?? 0,
    left: promptRenderRef.current?.scrollLeft ?? textareaRef.current?.scrollLeft ?? 0,
  });

  const placePromptCaretFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.prompt-mention-remove')) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    event.preventDefault();
    const caretIndex = promptIndexFromVisualPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      textarea.value.length,
    );
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caretIndex, caretIndex);
    caretIndexRef.current = caretIndex;
    setVisualCaretIndex(caretIndex);
    setPromptSelection({ start: caretIndex, end: caretIndex });
    promptSelectionDragRef.current = { pointerId: event.pointerId, anchorIndex: caretIndex };
    event.currentTarget.setPointerCapture(event.pointerId);
    syncPromptScroll(textarea);
  };

  const extendPromptSelectionFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = promptSelectionDragRef.current;
    const textarea = textareaRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !textarea) return;
    event.preventDefault();
    const focusIndex = promptIndexFromVisualPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      textarea.value.length,
    );
    const selectionStart = Math.min(drag.anchorIndex, focusIndex);
    const selectionEnd = Math.max(drag.anchorIndex, focusIndex);
    textarea.setSelectionRange(
      selectionStart,
      selectionEnd,
      focusIndex < drag.anchorIndex ? 'backward' : 'forward',
    );
    caretIndexRef.current = focusIndex;
    setVisualCaretIndex(focusIndex);
    setPromptSelection({ start: selectionStart, end: selectionEnd });
  };

  const finishPromptSelectionFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = promptSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    extendPromptSelectionFromPointer(event);
    promptSelectionDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    textareaRef.current?.focus({ preventScroll: true });
  };

  const restoreCaret = (caretIndex: number, scrollPosition = capturePromptScroll()) => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caretIndex, caretIndex);
      textarea.scrollTop = scrollPosition.top;
      textarea.scrollLeft = scrollPosition.left;
      if (promptRenderRef.current) {
        promptRenderRef.current.scrollTop = scrollPosition.top;
        promptRenderRef.current.scrollLeft = scrollPosition.left;
      }
      caretIndexRef.current = caretIndex;
      setVisualCaretIndex(caretIndex);
      setPromptSelection({ start: caretIndex, end: caretIndex });

      requestAnimationFrame(() => {
        const render = promptRenderRef.current;
        const visualCaret = render?.querySelector<HTMLElement>('.composer-visual-caret');
        if (!render || !visualCaret) return;
        const renderRect = render.getBoundingClientRect();
        const caretRect = visualCaret.getBoundingClientRect();
        const safeInset = 10;
        let nextScrollTop = render.scrollTop;
        if (caretRect.top < renderRect.top + safeInset) {
          nextScrollTop -= renderRect.top + safeInset - caretRect.top;
        } else if (caretRect.bottom > renderRect.bottom - safeInset) {
          nextScrollTop += caretRect.bottom - (renderRect.bottom - safeInset);
        }
        render.scrollTop = Math.max(0, nextScrollTop);
        textarea.scrollTop = render.scrollTop;
        textarea.scrollLeft = render.scrollLeft;
      });
    });
  };

  const selectedNode = useMemo(
    () => activeCanvas.nodes.find((node) => node.id === selectedNodeId),
    [activeCanvas.nodes, selectedNodeId],
  );

  useLayoutEffect(() => {
    if (!selectedNode || selectedNode.data.kind !== 'video' || typeof ResizeObserver === 'undefined') return;

    const nodeElement = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).find(
      (element) => element.dataset.id === selectedNode.id,
    );
    if (!nodeElement) return;

    let frame = 0;
    const refreshLayout = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setNodeLayoutVersion((version) => version + 1));
    };
    const observer = new ResizeObserver(refreshLayout);
    const observedElements = [
      nodeElement,
      composerRef.current,
      ...Array.from(nodeElement.querySelectorAll<HTMLElement>('.studio-node, .node-glass-surface, video')),
    ].filter((element): element is HTMLElement => Boolean(element));
    observedElements.forEach((element) => observer.observe(element));
    const videos = Array.from(nodeElement.querySelectorAll<HTMLVideoElement>('video'));
    videos.forEach((video) => video.addEventListener('loadedmetadata', refreshLayout));

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      videos.forEach((video) => video.removeEventListener('loadedmetadata', refreshLayout));
    };
  }, [selectedNode?.id, selectedNode?.data.kind, selectedNode?.data.outputs.videoUrl]);

  useLayoutEffect(() => {
    if (!selectedNode || selectedNode.data.kind !== 'video') return;

    const frame = window.requestAnimationFrame(() => {
      const nodeRect = nodeScreenRect(selectedNode.id);
      const composerRect = composerRef.current?.getBoundingClientRect();
      if (!nodeRect || !composerRect) return;

      const safeBottom = window.innerHeight - 24;
      const requiredShift = nodeRect.bottom + 14 + composerRect.height - safeBottom;
      if (requiredShift <= 0) return;

      const currentViewport = viewportRef.current;
      void setFlowViewport(
        {
          x: currentViewport.x,
          y: currentViewport.y - requiredShift,
          zoom: currentViewport.zoom,
        },
        { duration: 180 },
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, [nodeLayoutVersion, selectedNode?.id, selectedNode?.data.kind, setFlowViewport]);

  useEffect(() => {
    setModelMenuOpen(false);
    setModelMenuToolId('');
    setOptionPanelOpen(null);
    setMentionOpen(false);
    setReferenceWarning('');
    setDraggedReferenceKey('');
    setVisualCaretIndex(0);
    setPromptSelection({ start: 0, end: 0 });
    setPromptFocused(false);
    promptSelectionDragRef.current = null;
    mentionTriggerIndexRef.current = null;
    caretIndexRef.current = 0;
  }, [selectedNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setModelMenuOpen(false);
      setOptionPanelOpen(null);
      setMentionOpen(false);
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
      mentionTriggerIndexRef.current = null;
    };
    window.addEventListener('pointerdown', collapseOnOutsideComposer, true);
    return () => window.removeEventListener('pointerdown', collapseOnOutsideComposer, true);
  }, []);

  const mentionCandidates = useMemo(() => {
    if (!selectedNode) return [];
    const nodeOptions = { ...defaultOptions(selectedNode.data.kind, selectedNode.data.model), ...(selectedNode.data.providerOptions ?? {}) };
    const nodeModel = optionModel(nodeOptions, selectedNode);
    const compatible = compatibleOutputs(
      selectedNode.data.kind,
      nodeModel,
      String(nodeOptions.mode ?? ''),
      String(nodeOptions.operation ?? 'generate'),
    );
    const candidateIds = new Set<string>();
    const connectedGroupIds = new Set<string>();
    activeCanvas.edges.forEach((edge) => {
      if (edge.target !== selectedNode.id) return;
      const groupId = typeof edge.data?.sourceGroupId === 'string' ? edge.data.sourceGroupId : '';
      if (groupId) connectedGroupIds.add(groupId);
      else candidateIds.add(edge.source);
    });
    activeCanvas.groups.forEach((group) => {
      if (!connectedGroupIds.has(group.id)) return;
      group.nodeIds.forEach((nodeId) => candidateIds.add(nodeId));
    });
    return activeCanvas.nodes
      .filter((node) => node.id !== selectedNode.id && candidateIds.has(node.id))
      .map(nodeToReference)
      .filter((reference) => compatible.has(reference.outputType))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }, [activeCanvas.edges, activeCanvas.groups, activeCanvas.nodes, selectedNode]);

  const selectedPrompt = selectedNode?.data.prompt ?? '';
  const selectedReferences = selectedNode?.data.references;
  const selectedReferenceMentions = selectedNode?.data.referenceMentions;
  const promptParts = useMemo(
    () => tokenizePromptMentions(selectedPrompt, selectedReferences ?? [], selectedReferenceMentions),
    [selectedPrompt, selectedReferenceMentions, selectedReferences],
  );

  if (!selectedNode || !supportedKinds.has(selectedNode.data.kind)) return null;

  const node = selectedNode;
  const rawOptions = { ...defaultOptions(node.data.kind, node.data.model), ...(node.data.providerOptions ?? {}) };
  const rawModel = optionModel(rawOptions, node);
  const options = normalizeOptionsForModel(node.data.kind, rawModel, rawOptions);
  const references = selectedReferences ?? [];
  const referenceMentions = mentionsFromPromptParts(promptParts);
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
    composerResizable ? composerLayouts[node.data.kind] : undefined,
  );
  const userComposerLayout = composerResizable ? composerLayouts[node.data.kind] : undefined;
  const displayedPromptHeight = userComposerLayout
    ? clampNumber(userComposerLayout.promptHeight, 96, Math.max(96, windowSize.height - 260))
    : null;
  const composerStyle: ComposerPositionStyle = {
    ...positionStyle,
    ...(displayedPromptHeight ? { '--composer-prompt-height': `${displayedPromptHeight}px` } : {}),
  };

  const beginComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!composerResizable || event.button !== 0) return;
    const composer = composerRef.current;
    const promptField = composer?.querySelector<HTMLElement>('.composer-prompt-field');
    if (!composer || !promptField) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const composerRect = composer.getBoundingClientRect();
    const promptRect = promptField.getBoundingClientRect();
    const maximumWidth = Math.max(320, window.innerWidth - 120);
    const minimumWidth = Math.min(composerMinimumWidth(node.data.kind), maximumWidth);
    const chromeHeight = Math.max(0, composerRect.height - promptRect.height);
    const maximumPromptHeight = Math.max(96, Math.min(560, window.innerHeight - composerRect.top - chromeHeight - 24));
    resizeDragRef.current = {
      pointerId: event.pointerId,
      kind: node.data.kind,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: composerRect.width,
      startPromptHeight: promptRect.height,
      minWidth: minimumWidth,
      maxWidth: maximumWidth,
      minPromptHeight: 96,
      maxPromptHeight: maximumPromptHeight,
    };
    document.documentElement.classList.add('is-composer-resizing');
  };

  const moveComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const layout = {
      width: Math.round(clampNumber(drag.startWidth + event.clientX - drag.startX, drag.minWidth, drag.maxWidth)),
      promptHeight: Math.round(
        clampNumber(drag.startPromptHeight + event.clientY - drag.startY, drag.minPromptHeight, drag.maxPromptHeight),
      ),
    };
    const nextLayouts = { ...composerLayoutsRef.current, [drag.kind]: layout };
    composerLayoutsRef.current = nextLayouts;
    setComposerLayouts(nextLayouts);
  };

  const endComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeDragRef.current = null;
    document.documentElement.classList.remove('is-composer-resizing');
    saveComposerLayouts(composerLayoutsRef.current);
  };
  const videoReferenceCapability = node.data.kind === 'video' ? videoCapability(model) : null;
  const activeVideoReferenceLimits: Partial<Record<NodeReference['outputType'], number>> =
    node.data.kind === 'video'
      ? videoReferenceLimits(
          model,
          String(options.mode ?? videoReferenceCapability?.defaultMode ?? ''),
          String(options.operation ?? 'generate'),
        )
      : {};
  const videoReferenceCounts = node.data.kind === 'video' ? referenceCounts(references) : {};
  const doubaoAudio = node.data.kind === 'audio' && isDoubaoAudioModel(model);
  const activeAudioReferenceLimits = doubaoAudio
    ? doubaoAudioReferenceLimits(String(options.mode ?? 'text-to-audio'))
    : { image: 0, video: 0, audio: 0 };
  const audioReferenceCounts = node.data.kind === 'audio' ? referenceCounts(references) : {};

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

  const setVideoOperation = (operation: string) => {
    if (node.data.kind !== 'video') return;
    const nextOperation = ['generate', 'ai-edit', 'concat', 'creative-edit'].includes(operation) ? operation : 'generate';
    let nextModel = model;
    let provider = node.data.provider;
    let providerTool = String(options.providerTool ?? 'anycap');
    let mode = String(options.mode ?? 'multi-modal-reference');
    if (nextOperation === 'generate') {
      nextModel = model === 'selfcanvas-smart-edit' || model === 'gemini-omni-flash-preview' ? 'seedance-2-fast' : model;
      provider = 'AnyCap';
      providerTool = 'anycap';
      mode = videoCapability(nextModel).defaultMode;
    } else if (nextOperation === 'creative-edit') {
      nextModel = 'gemini-omni-flash-preview';
      provider = 'AnyCap';
      providerTool = 'anycap';
      mode = 'edit-video';
    } else {
      nextModel = 'selfcanvas-smart-edit';
      provider = 'SelfCanvas AI Edit';
      providerTool = 'local-edit';
      mode = nextOperation;
    }
    const nextOptions = normalizeOptionsForModel('video', nextModel, {
      ...options,
      model: nextModel,
      providerTool,
      mode,
      operation: nextOperation as ProviderOptions['operation'],
      planOnly: false,
      editPlan: undefined,
    });
    const allowed = compatibleOutputs('video', nextModel, mode, nextOperation);
    const nextReferences = references.filter((reference) => allowed.has(reference.outputType));
    updateNodeData(node.id, {
      provider,
      model: nextModel,
      providerOptions: nextOptions,
      references: nextReferences,
      referenceMentions: nextOperation === 'generate' ? referenceMentions : [],
      outputs: nextOperation === 'ai-edit' ? node.data.outputs : {},
    });
    setReferenceWarning('');
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

  const renderVideoSettingsPanel = () => {
    const resolution = String(options.resolution ?? '720p');
    const aspectRatio = aspectRatioOf(options);
    const capability = videoCapability(model);
    const ratioOptions = ratioOptionsForVideo(model);
    const operation = String(options.operation ?? 'generate');
    const duration = String(options.duration ?? capability.defaultDuration);
    const showDuration = operation === 'generate' || operation === 'creative-edit';
    return (
      <div className="media-options-popover video-settings-popover" role="dialog" aria-label="视频参数设置">
        <div className="video-settings-title">设置</div>
        <label className="video-settings-control">
          <span>画面比例</span>
          <ComposerSelect
            ariaLabel="画面比例"
            value={aspectRatio}
            options={ratioOptions.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(nextAspectRatio) => applyVideoMediaPreset({ aspectRatio: nextAspectRatio })}
          />
        </label>
        {capability.resolutions.length > 0 && (
          <label className="video-settings-control">
            <span>分辨率</span>
            <ComposerSelect
              ariaLabel="视频分辨率"
              value={resolution}
              options={capability.resolutions.map((item) => ({ value: item, label: item }))}
              onChange={(nextResolution) => applyVideoMediaPreset({ resolution: nextResolution })}
            />
          </label>
        )}
        {showDuration && capability.durations.length > 0 && (
          <label className="video-settings-control">
            <span>时长</span>
            <ComposerSelect
              ariaLabel="视频时长"
              value={duration}
              options={capability.durations.map((item) => ({ value: String(item), label: `${item}s` }))}
              onChange={(nextDuration) => updateOptions({ duration: Number(nextDuration) })}
            />
          </label>
        )}
        <div className="media-options-note">选项会随当前模型能力自动调整</div>
      </div>
    );
  };

  const renderAudioSettingsPanel = () => (
    <div className="media-options-popover audio-settings-popover" role="dialog" aria-label="豆包音频参数设置">
      <div className="video-settings-title">豆包音频设置</div>
      <label className="video-settings-control">
        <span>输出格式</span>
        <ComposerSelect
          ariaLabel="音频输出格式"
          value={String(options.format ?? 'mp3')}
          options={[
            { value: 'mp3', label: 'MP3' },
            { value: 'wav', label: 'WAV' },
          ]}
          onChange={(format) => updateOptions({ format })}
        />
      </label>
      <label className="video-settings-control">
        <span>采样率</span>
        <ComposerSelect
          ariaLabel="音频采样率"
          value={String(options.sampleRate ?? 24000)}
          options={doubaoAudioSampleRates.map((rate) => ({ value: String(rate), label: `${rate / 1000} kHz` }))}
          onChange={(sampleRate) => updateOptions({ sampleRate: Number(sampleRate) })}
        />
      </label>
      <div className="audio-parameter-grid">
        <label>
          <span>语速 <b>{Number(options.speechRate ?? 0)}</b></span>
          <input
            min="-50"
            max="100"
            step="1"
            type="range"
            value={String(options.speechRate ?? 0)}
            onChange={(event) => updateOptions({ speechRate: Number(event.currentTarget.value) })}
          />
        </label>
        <label>
          <span>音调 <b>{Number(options.pitchRate ?? 0)}</b></span>
          <input
            min="-12"
            max="12"
            step="1"
            type="range"
            value={String(options.pitchRate ?? 0)}
            onChange={(event) => updateOptions({ pitchRate: Number(event.currentTarget.value) })}
          />
        </label>
        <label>
          <span>响度 <b>{Number(options.loudnessRate ?? 0)}</b></span>
          <input
            min="-50"
            max="100"
            step="1"
            type="range"
            value={String(options.loudnessRate ?? 0)}
            onChange={(event) => updateOptions({ loudnessRate: Number(event.currentTarget.value) })}
          />
        </label>
      </div>
      {String(options.mode ?? 'text-to-audio') === 'text-to-audio' && (
        <label className="video-settings-control audio-speaker-field">
          <span>说话人 ID（可选，最多 1 个）</span>
          <input
            type="text"
            value={String(options.speakerIds?.[0] ?? '')}
            placeholder="NexusHub speaker ID"
            onChange={(event) => updateOptions({ speakerIds: event.currentTarget.value.trim() ? [event.currentTarget.value] : [] })}
          />
        </label>
      )}
      <button
        className={`audio-subtitle-toggle ${options.enableSubtitle === true ? 'is-active' : ''}`}
        type="button"
        aria-pressed={options.enableSubtitle === true}
        onClick={() => updateOptions({ enableSubtitle: options.enableSubtitle !== true })}
      >
        <Check size={15} />
        <span>生成字幕</span>
      </button>
      <div className="media-options-note">参数范围来自 AnyCap 当前 Doubao Seed Audio 1.0 schema</div>
    </div>
  );

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
    const targetKey = referenceKey(reference);
    const ranges = promptParts
      .filter((part) => part.type === 'mention' && part.mention.referenceKey === targetKey)
      .map((part) => ({ start: part.start, end: part.end }));
    const nextPrompt = removePromptRanges(node.data.prompt, ranges);
    const nextMentions = shiftMentionsAfterRemovedRanges(referenceMentions, nextPrompt.ranges, node.data.prompt.length);
    updateNodeData(node.id, {
      prompt: nextPrompt.prompt,
      references: references.filter((item) => referenceKey(item) !== targetKey),
      referenceMentions: nextMentions,
    });
  };

  const moveReferenceBefore = (sourceKey: string, targetKey: string) => {
    if (!sourceKey || sourceKey === targetKey) return;
    const sourceIndex = references.findIndex((reference) => referenceKey(reference) === sourceKey);
    const targetIndex = references.findIndex((reference) => referenceKey(reference) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextReferences = [...references];
    const [moved] = nextReferences.splice(sourceIndex, 1);
    nextReferences.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved);
    updateNodeData(node.id, { references: nextReferences });
  };

  const removeMentionPart = (part: Extract<PromptPart, { type: 'mention' }>) => {
    const scrollPosition = capturePromptScroll();
    const nextPrompt = removePromptRanges(node.data.prompt, [{ start: part.start, end: part.end }]);
    const nextMentions = shiftMentionsAfterRemovedRanges(referenceMentions, nextPrompt.ranges, node.data.prompt.length);
    updateNodeData(node.id, {
      prompt: nextPrompt.prompt,
      references: referencesAfterMentionChange(references, referenceMentions, nextMentions),
      referenceMentions: nextMentions,
    });
    mentionTriggerIndexRef.current = null;
    setMentionOpen(false);
    restoreCaret(nextPrompt.caretIndex, scrollPosition);
  };

  const handleMentionDelete = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
    const textarea = event.currentTarget;
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const deletion = mentionDeletionTarget(promptParts, selectionStart, selectionEnd, event.key);
    if (!deletion) return false;

    event.preventDefault();
    const scrollPosition = capturePromptScroll();
    const nextPrompt = removePromptRanges(node.data.prompt, deletion.ranges);
    const nextMentions = shiftMentionsAfterRemovedRanges(referenceMentions, nextPrompt.ranges, node.data.prompt.length)
      .filter((mention) => !deletion.mentionIds.has(mention.id));
    updateNodeData(node.id, {
      prompt: nextPrompt.prompt,
      references: referencesAfterMentionChange(references, referenceMentions, nextMentions),
      referenceMentions: nextMentions,
    });
    mentionTriggerIndexRef.current = null;
    setMentionOpen(false);
    restoreCaret(nextPrompt.caretIndex, scrollPosition);
    return true;
  };

  const addReference = (reference: NodeReference) => {
    const scrollPosition = capturePromptScroll();
    const key = referenceKey(reference);
    const existingReference = references.find((item) => referenceKey(item) === key);
    const resolvedReference = existingReference ?? reference;
    const nextReferences = existingReference ? references : [...references, reference];
    const limitMessage = referenceLimitMessage(
      node.data.kind,
      model,
      nextReferences,
      String(options.mode ?? ''),
      String(options.operation ?? 'generate'),
    );
    if (limitMessage) {
      setReferenceWarning(limitMessage);
      return;
    }
    const textarea = textareaRef.current;
    const caretIndex = textarea?.selectionStart ?? caretIndexRef.current ?? node.data.prompt.length;
    const nextMention = insertReferenceMention(node.data.prompt, resolvedReference, mentionTriggerIndexRef.current, caretIndex);
    const shiftedMentions = shiftMentionsAfterEdit(
      referenceMentions,
      nextMention.editStart,
      nextMention.editEnd,
      nextMention.insertedLength,
    );
    const nextReferenceMentions = [
      ...shiftedMentions,
      {
        id: newPromptMentionId(),
        referenceKey: key,
        text: nextMention.prompt.slice(nextMention.mentionStart, nextMention.mentionEnd),
        start: nextMention.mentionStart,
        end: nextMention.mentionEnd,
      },
    ].sort((a, b) => a.start - b.start || a.end - b.end);
    updateNodeData(node.id, {
      prompt: nextMention.prompt,
      references: nextReferences,
      referenceMentions: nextReferenceMentions,
    });
    setReferenceWarning('');
    setMentionOpen(false);
    mentionTriggerIndexRef.current = null;
    restoreCaret(nextMention.caretIndex, scrollPosition);
  };

  const hasPromptSelection = promptFocused && promptSelection.end > promptSelection.start;
  const renderVisualCaret = (key: string) =>
    promptFocused && !hasPromptSelection ? <span className="composer-visual-caret" key={key} /> : null;

  const renderPromptPart = (part: PromptPart) => {
    const caretIsInside = promptFocused && visualCaretIndex > part.start && visualCaretIndex <= part.end;
    const caretIsAtStart = promptFocused && visualCaretIndex === part.start;

    if (part.type === 'text') {
      const selectionStart = Math.max(part.start, promptSelection.start);
      const selectionEnd = Math.min(part.end, promptSelection.end);
      if (hasPromptSelection && selectionEnd > selectionStart) {
        const relativeStart = selectionStart - part.start;
        const relativeEnd = selectionEnd - part.start;
        return (
          <span data-prompt-start={part.start} data-prompt-end={part.end} key={part.key}>
            {part.text.slice(0, relativeStart)}
            <span className="composer-prompt-selection">{part.text.slice(relativeStart, relativeEnd)}</span>
            {part.text.slice(relativeEnd)}
          </span>
        );
      }
      if (!caretIsInside && !caretIsAtStart) {
        return <span data-prompt-start={part.start} data-prompt-end={part.end} key={part.key}>{part.text}</span>;
      }
      const offset = Math.max(0, Math.min(visualCaretIndex - part.start, part.text.length));
      return (
        <span data-prompt-start={part.start} data-prompt-end={part.end} key={part.key}>
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
      <span
        className={`prompt-mention-token mention-${part.reference.outputType} ${
          hasPromptSelection && part.start < promptSelection.end && part.end > promptSelection.start ? 'is-selected' : ''
        }`}
        data-prompt-start={part.start}
        data-prompt-end={part.end}
        data-prompt-mention="true"
        key={`${part.key}-token`}
      >
        {part.reference.thumbnailUrl ? (
          <img src={part.reference.thumbnailUrl} alt="" />
        ) : (
          <span className="prompt-mention-badge">
            {part.reference.outputType === 'other' ? <Icon size={12} /> : badgeLabel[part.reference.outputType]}
          </span>
        )}
        <span className="prompt-mention-label">{part.reference.title}</span>
        <span
          className="prompt-mention-remove"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            removeMentionPart(part);
          }}
        >
          <X size={13} />
        </span>
      </span>
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
    const operation = String(options.operation ?? 'generate');
    const editOperation = node.data.kind === 'video' && operation !== 'generate';
    const normalizedOptions = normalizeOptionsForModel(node.data.kind, model, {
      ...options,
      ...(node.data.kind === 'image' ? { referenceQuality: imageReferenceQuality } : {}),
      ...(editOperation ? {} : { providerTool: activeTool?.id, model }),
      ...(operation === 'ai-edit' && node.data.outputs.editPlan
        ? { editPlan: node.data.outputs.editPlan, planOnly: false }
        : {}),
    });
    const limitMessage = referenceLimitMessage(
      node.data.kind,
      model,
      references,
      String(normalizedOptions.mode ?? ''),
      String(normalizedOptions.operation ?? 'generate'),
    );
    if (limitMessage) {
      setReferenceWarning(limitMessage);
      return;
    }
    if (node.data.kind === 'audio' && isDoubaoAudioModel(model)) {
      const mode = String(normalizedOptions.mode ?? 'text-to-audio');
      const counts = referenceCounts(references);
      if (mode === 'audio-to-audio' && (counts.audio ?? 0) < 1) {
        setReferenceWarning('音频参考模式至少需要 @ 1 段音频，最多 3 段');
        return;
      }
      if (mode === 'image-to-audio' && (counts.image ?? 0) < 1) {
        setReferenceWarning('图片参考模式需要 @ 1 张图片');
        return;
      }
    }
    if (editOperation) {
      const videoCount = references.filter((reference) => reference.outputType === 'video').length;
      const minimum = operation === 'creative-edit' ? 1 : 2;
      if (videoCount < minimum) {
        setReferenceWarning(operation === 'creative-edit' ? '创意改编至少需要 1 段视频' : 'AI 剪辑和直接合并至少需要 2 段视频');
        return;
      }
    }
    updateNodeData(node.id, {
      provider: editOperation ? 'SelfCanvas AI Edit' : toolLabelForKind(activeTool, node.data.kind) || node.data.provider,
      model: editOperation ? String(normalizedOptions.model ?? model) : model,
      providerOptions: normalizedOptions,
    });
    setReferenceWarning('');
    void runNode(node.id);
  };

  const previewAiEditPlan = () => {
    const videoCount = references.filter((reference) => reference.outputType === 'video').length;
    if (videoCount < 2) {
      setReferenceWarning('预览 AI 剪辑方案至少需要 2 段视频');
      return;
    }
    const normalizedOptions = normalizeOptionsForModel(node.data.kind, model, {
      ...options,
      operation: 'ai-edit',
      planOnly: true,
      editPlan: undefined,
    });
    updateNodeData(node.id, {
      provider: 'SelfCanvas AI Edit',
      model: String(normalizedOptions.model ?? 'selfcanvas-smart-edit'),
      providerOptions: normalizedOptions,
    });
    setReferenceWarning('');
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

  const renderAudioReferenceCounters = () => {
    if (!doubaoAudio) return null;
    return (
      <div className="video-reference-counters audio-reference-counters">
        {(activeAudioReferenceLimits.image ?? 0) > 0 && (
          <span>图 {audioReferenceCounts.image ?? 0}/{activeAudioReferenceLimits.image}</span>
        )}
        {(activeAudioReferenceLimits.audio ?? 0) > 0 && (
          <span>音 {audioReferenceCounts.audio ?? 0}/{activeAudioReferenceLimits.audio}</span>
        )}
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
      const operation = String(options.operation ?? 'generate');
      const resolution = String(options.resolution ?? capability.resolutions[0] ?? '');
      const aspectRatio = aspectRatioOf(options);
      const duration = Number(options.duration ?? capability.defaultDuration);
      const showDuration = operation === 'generate' || operation === 'creative-edit';
      const videoSettingsSummary = [
        aspectRatioLabel(aspectRatio),
        resolution,
        showDuration && capability.durations.length > 0 ? `${duration}s` : '',
      ].filter(Boolean).join(' ');
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
          <div className="composer-select-field video-operation-field">
            <ComposerSelect
              ariaLabel="视频操作"
              value={operation}
              options={[
                { value: 'generate', label: '生成视频' },
                { value: 'ai-edit', label: 'AI 剪辑' },
                { value: 'concat', label: '直接合并' },
                { value: 'creative-edit', label: '创意改编' },
              ]}
              onChange={setVideoOperation}
            />
          </div>
          {(operation !== 'generate' || capability.resolutions.length > 0 || capability.aspectRatios.length > 0) && (
            <div className="composer-option-wrap">
              <button
                className={`composer-option-pill video-settings-trigger ${optionPanelOpen === 'video-size' ? 'is-active' : ''}`}
                type="button"
                onClick={() => toggleOptionPanel('video-size')}
                aria-expanded={optionPanelOpen === 'video-size'}
                aria-label={`视频参数：${videoSettingsSummary}`}
              >
                <Settings2 size={16} />
                <span>{videoSettingsSummary}</span>
                <ChevronDown size={15} />
              </button>
              {optionPanelOpen === 'video-size' && renderVideoSettingsPanel()}
            </div>
          )}
          {operation === 'generate' && (
            <div className="composer-select-field video-mode-field">
              <ComposerSelect
                ariaLabel="视频生成模式"
                value={String(options.mode ?? capability.defaultMode)}
                disabled={capability.modes.length <= 1}
                options={capability.modes.map((mode) => ({ value: mode, label: modeLabels[mode] ?? mode }))}
                onChange={(mode) => updateOptions({ mode })}
              />
            </div>
          )}
          {operation === 'generate' && capability.supportsGenerateAudio && (
            <button
              className={`composer-audio-toggle ${options.generateAudio !== false ? 'is-active' : ''}`}
              type="button"
              aria-label={options.generateAudio !== false ? '关闭生成声音' : '开启生成声音'}
              aria-pressed={options.generateAudio !== false}
              title={options.generateAudio !== false ? '生成声音：开' : '生成声音：关'}
              onClick={() => updateOptions({ generateAudio: options.generateAudio === false })}
            >
              {options.generateAudio !== false ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <span>声音</span>
            </button>
          )}
          {(operation === 'ai-edit' || operation === 'concat') && (
            <>
              <div className="composer-select-field">
                <span>转场</span>
                <ComposerSelect
                  ariaLabel="视频转场"
                  value={String(options.transition ?? 'cut')}
                  options={[
                    { value: 'cut', label: '硬切' },
                    { value: 'crossfade', label: '交叉淡化' },
                  ]}
                  onChange={(transition) => updateOptions({ transition: transition as ProviderOptions['transition'] })}
                />
              </div>
              <div className="composer-select-field">
                <span>音频</span>
                <ComposerSelect
                  ariaLabel="音频处理"
                  value={String(options.audioPolicy ?? 'keep')}
                  options={[
                    { value: 'keep', label: '保留' },
                    { value: 'normalize', label: '标准化' },
                    { value: 'mute', label: '静音' },
                  ]}
                  onChange={(audioPolicy) => updateOptions({ audioPolicy: audioPolicy as ProviderOptions['audioPolicy'] })}
                />
              </div>
            </>
          )}
          {operation === 'generate' && String(options.mode ?? capability.defaultMode) === 'multi-shot-video' && (
            <div className="composer-select-field">
              <span>Shot</span>
              <ComposerSelect
                ariaLabel="Shot 数量"
                value={String(options.shotCount ?? 3)}
                options={[2, 3, 4, 5, 6].map((count) => ({ value: String(count), label: String(count) }))}
                onChange={(shotCount) => updateOptions({ shotCount: Number(shotCount) })}
              />
            </div>
          )}
        </>
      );
    }
    if (doubaoAudio) {
      const mode = String(options.mode ?? 'text-to-audio') as (typeof doubaoAudioModes)[number];
      const format = String(options.format ?? 'mp3').toUpperCase();
      const sampleRate = Number(options.sampleRate ?? 24000);
      return (
        <>
          <div className="composer-select-field audio-mode-field">
            <ComposerSelect
              ariaLabel="豆包音频生成模式"
              value={mode}
              options={doubaoAudioModes.map((item) => ({ value: item, label: doubaoAudioModeLabels[item] }))}
              onChange={(nextMode) => updateOptions({ mode: nextMode })}
            />
          </div>
          <div className="composer-option-wrap audio-option-wrap">
            <button
              className={`composer-option-pill audio-settings-trigger ${optionPanelOpen === 'audio-settings' ? 'is-active' : ''}`}
              type="button"
              onClick={() => toggleOptionPanel('audio-settings')}
              aria-expanded={optionPanelOpen === 'audio-settings'}
              aria-label={`豆包音频参数：${format} ${sampleRate / 1000} kHz`}
            >
              <Settings2 size={16} />
              <span>{format} · {sampleRate / 1000} kHz</span>
              <ChevronDown size={15} />
            </button>
            {optionPanelOpen === 'audio-settings' && renderAudioSettingsPanel()}
          </div>
        </>
      );
    }
    return (
      <>
        <label>
          <span>风格</span>
          <input value={String(options.style ?? 'cinematic')} onChange={(event) => updateOptions({ style: event.currentTarget.value })} />
        </label>
        <label>
          <span>时长</span>
          <input
            min="3"
            max="600"
            step="1"
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
      ref={composerRef}
      className={`generation-composer is-node-attached is-expanded composer-${node.data.kind} input-font-${inputFontSize} input-surface-${inputSurface} ${composerResizable ? 'is-user-resizable' : ''} ${userComposerLayout ? 'has-user-composer-size' : ''}`}
      style={composerStyle}
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
        {node.data.kind === 'audio' && !doubaoAudio && (
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
        {renderAudioReferenceCounters()}
        {renderVideoReferenceCounters()}
        {references.map((reference) => {
          const Icon = iconByOutput[reference.outputType];
          const draggable =
            node.data.kind === 'video' &&
            String(options.operation ?? 'generate') !== 'generate' &&
            reference.outputType === 'video';
          const key = referenceKey(reference);
          return (
            <div
              className={`reference-chip ${draggable ? 'is-reorderable' : ''} ${draggedReferenceKey === key ? 'is-dragging' : ''}`}
              key={key}
              role="listitem"
              draggable={draggable}
              onDragStart={(event) => {
                if (!draggable) return;
                setDraggedReferenceKey(key);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', key);
              }}
              onDragOver={(event) => {
                if (!draggable || !draggedReferenceKey) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                if (!draggable) return;
                event.preventDefault();
                moveReferenceBefore(event.dataTransfer.getData('text/plain') || draggedReferenceKey, key);
                setDraggedReferenceKey('');
              }}
              onDragEnd={() => setDraggedReferenceKey('')}
            >
              {draggable && <GripVertical className="reference-chip-grip" size={13} />}
              {reference.thumbnailUrl ? <img src={reference.thumbnailUrl} alt="" /> : <Icon size={16} />}
              <span>{reference.title}</span>
              <button
                className="reference-chip-remove"
                type="button"
                aria-label={`移除 ${reference.title}`}
                onClick={() => removeReference(reference)}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {mentionOpen && (
        <div className="mention-popover">
          <div className="mention-popover-title">
            <span>@ 引用已连接素材</span>
            <small>{mentionCandidates.length} 个</small>
          </div>
          <div className={`mention-list ${node.data.kind === 'video' || node.data.kind === 'image' ? 'is-media-carousel' : ''}`}>
            {mentionCandidates.length > 0 ? (
              mentionCandidates.map((candidate) => {
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
                    <small>{candidate.outputType.toUpperCase()}</small>
                  </button>
                );
              })
            ) : (
              <div className="mention-empty">没有可引用的兼容素材</div>
            )}
          </div>
        </div>
      )}

      {referenceWarning && <div className="composer-reference-warning">{referenceWarning}</div>}

      <div className="composer-prompt-field">
        <div
          className={`composer-prompt-render ${node.data.prompt ? '' : 'is-empty'}`}
          ref={promptRenderRef}
          aria-hidden="true"
          onPointerDown={placePromptCaretFromPointer}
          onPointerMove={extendPromptSelectionFromPointer}
          onPointerUp={finishPromptSelectionFromPointer}
          onPointerCancel={finishPromptSelectionFromPointer}
          onLostPointerCapture={() => {
            promptSelectionDragRef.current = null;
          }}
          onScroll={(event) => syncTextareaScroll(event.currentTarget)}
        >
          {renderPromptContent()}
        </div>
        <textarea
          className="nodrag nowheel nopan"
          ref={textareaRef}
          value={node.data.prompt}
          placeholder={placeholderFor(node.data.kind)}
          onChange={(event) => {
            const nextPrompt = event.currentTarget.value;
            const caretIndex = event.currentTarget.selectionStart ?? nextPrompt.length;
            const nextMentions = reconcileMentionsAfterTextEdit(node.data.prompt, nextPrompt, referenceMentions);
            caretIndexRef.current = caretIndex;
            setVisualCaretIndex(caretIndex);
            setPromptSelection({ start: caretIndex, end: caretIndex });
            updateNodeData(node.id, {
              prompt: nextPrompt,
              references: referencesAfterMentionChange(references, referenceMentions, nextMentions),
              referenceMentions: nextMentions,
            });
            syncPromptScroll(event.currentTarget);
            if (caretIndex > 0 && nextPrompt[caretIndex - 1] === '@') {
              mentionTriggerIndexRef.current = caretIndex - 1;
              setMentionOpen(true);
            }
          }}
          onClick={(event) => rememberCaret(event.currentTarget)}
          onKeyUp={(event) => {
            event.stopPropagation();
            rememberCaret(event.currentTarget);
          }}
          onCopy={(event) => event.stopPropagation()}
          onCut={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
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
            // Keep React Flow's global Ctrl/Meta shortcuts from stealing
            // native text editing (A/C/V/X) inside the expanded prompt.
            event.stopPropagation();
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
            <div
              className={`model-picker-popover picker-${node.data.kind} ${availableTools.length === 1 ? 'is-single-tool' : ''}`}
              aria-label="工具模型选择"
            >
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
          {node.data.kind === 'video' && String(options.operation ?? 'generate') === 'ai-edit' && (
            <button
              className={`composer-plan-button ${node.data.outputs.editPlan ? 'has-plan' : ''}`}
              type="button"
              disabled={running}
              onClick={previewAiEditPlan}
              title="先分析素材并生成可复用的剪辑方案"
            >
              <Sparkles size={15} />
              <span>{node.data.outputs.editPlan ? '重新规划' : '预览方案'}</span>
            </button>
          )}
          {footer}
        </div>
        <button
          className="composer-submit"
          type="button"
          disabled={running}
          onClick={handleRun}
          aria-label={node.data.kind === 'video' && String(options.operation ?? 'generate') !== 'generate' ? '开始剪辑' : '生成'}
          title={node.data.outputs.editPlan && String(options.operation ?? '') === 'ai-edit' ? '按当前方案渲染' : undefined}
        >
          <Send size={22} />
        </button>
      </footer>
      {composerResizable && (
        <button
          className="composer-resize-handle nodrag nopan"
          type="button"
          aria-label="拖拽调整提示词宽度和高度"
          title="拖拽调整提示词宽度和高度"
          onPointerDown={beginComposerResize}
          onPointerMove={moveComposerResize}
          onPointerUp={endComposerResize}
          onPointerCancel={endComposerResize}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      )}
    </section>
  );
}
