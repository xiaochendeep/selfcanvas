import verifiedSnapshot from '../../docs/anycap/catalog-2026-09-08.json' with { type: 'json' };
import type { ProviderOptions } from '../types';

export interface AnyCapParameter {
  type?: string;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
  multipleOf?: number;
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  minLength?: number;
  description?: string;
}
export type AnyCapParameters = Record<string, AnyCapParameter>;
export interface AnyCapModeOptions {
  resolutions?: string[];
  aspectRatios?: string[];
  durations?: number[];
  formats?: string[];
  supportsGenerateAudio?: boolean;
  references?: AnyCapVideoCapability['referenceLimits'];
  referenceMinimums?: AnyCapVideoCapability['referenceLimits'];
}

export interface AnyCapModel {
  id: string;
  label: string;
  description?: string;
}

export interface AnyCapVideoCapability {
  id: string;
  defaultMode: string;
  modes: string[];
  supportsMultiShot: boolean;
  supportsGenerateAudio?: boolean;
  resolutions: string[];
  durations: number[];
  aspectRatios: string[];
  defaultDuration: number;
  referenceLimits: Partial<Record<'image' | 'video' | 'audio' | 'text' | 'other', number>>;
  referenceLimitsByMode?: Record<string, AnyCapVideoCapability['referenceLimits']>;
  resolutionsByMode?: Record<string, string[]>;
  durationsByMode?: Record<string, number[]>;
  aspectRatiosByMode?: Record<string, string[]>;
  supportsGenerateAudioByMode?: Record<string, boolean>;
  parametersByMode?: Record<string, AnyCapParameters>;
  modeOptions?: Record<string, AnyCapModeOptions>;
}

export interface AnyCapAudioCapability {
  id?: string;
  modes: string[];
  defaultMode: string;
  formats?: string[];
  sampleRates?: number[];
  durations?: number[];
  defaultDuration?: number;
  durationMin?: number;
  durationMax?: number;
  referenceLimits?: AnyCapVideoCapability['referenceLimits'];
  referenceLimitsByMode?: Record<string, AnyCapVideoCapability['referenceLimits']>;
  supportsStyle?: boolean;
  parametersByMode?: Record<string, AnyCapParameters>;
  modeOptions?: Record<string, AnyCapModeOptions>;
}

export interface AnyCapImageCapability extends AnyCapAudioCapability {}

export interface AnyCapCatalog {
  available?: boolean;
  message?: string;
  source?: string;
  catalogSource?: string;
  verifiedAt?: string;
  fetchedAt?: string;
  capabilities?: Array<{
    id: string;
    label?: string;
    available: boolean;
    models?: AnyCapModel[];
    message?: string;
  }>;
  videoCapabilities?: Record<string, AnyCapVideoCapability>;
  audioCapabilities?: Record<string, AnyCapAudioCapability>;
  imageCapabilities?: Record<string, AnyCapImageCapability>;
}

export function catalogModels(catalog: AnyCapCatalog | null | undefined, kind: string): AnyCapModel[] | null {
  const ids = kind === 'audio' ? ['audio', 'music'] : [kind];
  const groups = catalog?.capabilities?.filter((item) => ids.includes(item.id));
  if (!groups?.length) return null;
  const unique = new Map<string, AnyCapModel>();
  for (const group of groups) {
    if (group.available === false) continue;
    for (const model of group.models ?? []) {
      if (model.id) unique.set(model.id, { ...model, label: model.label || model.id });
    }
  }
  const featured = ['seedance-2.5', 'minimax-h3', 'seedance-2', 'seedance-2-fast', 'seedance-2-mini', 'doubao-seed-audio-1-0'];
  return [...unique.values()].sort((a, b) => {
    const rank = (id: string) => featured.includes(id) ? featured.indexOf(id) : featured.length;
    return rank(a.id) - rank(b.id);
  });
}

export function capabilityForVideoMode(capability: AnyCapVideoCapability, requestedMode?: string): AnyCapVideoCapability {
  const mode = capability.modes.includes(requestedMode || '') ? requestedMode! : capability.defaultMode;
  const options = capability.modeOptions?.[mode];
  return {
    ...capability,
    resolutions: options?.resolutions ?? capability.resolutionsByMode?.[mode] ?? capability.resolutions,
    durations: options?.durations ?? capability.durationsByMode?.[mode] ?? capability.durations,
    aspectRatios: options?.aspectRatios ?? capability.aspectRatiosByMode?.[mode] ?? capability.aspectRatios,
    supportsGenerateAudio: options?.supportsGenerateAudio ?? capability.supportsGenerateAudioByMode?.[mode] ?? capability.supportsGenerateAudio,
    referenceLimits: options?.references ?? capability.referenceLimitsByMode?.[mode] ?? capability.referenceLimits,
  };
}

export function parameterStrings(parameter?: AnyCapParameter): string[] {
  return parameter?.enum?.map(String) ?? [];
}

export function musicTagsFromLegacyOptions(options: { tags?: string; style?: string }): string | undefined {
  return options.tags?.trim() ? options.tags : options.style?.trim() ? options.style : options.tags;
}

/** The music API uses milliseconds; the editor and persisted duration use seconds. */
export function musicDurationSeconds(options: ProviderOptions, parameter: AnyCapParameter): number {
  const legacyMs = Number(options.musicDurationMs);
  const requested = Number.isFinite(legacyMs) && legacyMs > 0 ? legacyMs : Number(options.duration) * 1000;
  const normalized = normalizeParameterNumber(parameter, requested > 0 ? requested : undefined, 30_000);
  return normalized / 1000;
}

export function normalizeParameterNumber(parameter: AnyCapParameter, value: unknown, fallback: number): number {
  const numeric = Number(value);
  let result = value !== '' && value !== null && value !== undefined && Number.isFinite(numeric)
    ? numeric : Number(parameter.default ?? fallback);
  const values = parameter.enum?.map(Number).filter(Number.isFinite);
  if (values?.length) return values.reduce((nearest, item) => Math.abs(item - result) < Math.abs(nearest - result) ? item : nearest);
  if (!Number.isFinite(result)) result = fallback;
  const step = parameter.multipleOf ?? (parameter.type === 'integer' ? 1 : 0);
  if (step > 0) result = Math.round(result / step) * step;
  if (parameter.minimum !== undefined) result = Math.max(parameter.minimum, result);
  if (parameter.maximum !== undefined) result = Math.min(parameter.maximum, result);
  return result;
}

/** Only keep audio fields actually supported by the selected mode's schema. */
export function normalizeDoubaoParameters(options: ProviderOptions, parameters: AnyCapParameters): ProviderOptions {
  const next = { ...options };
  for (const key of ['duration', 'musicDurationMs', 'tags', 'style', 'title', 'lyrics', 'makeInstrumental', 'customMode', 'vocalGender', 'voiceMode', 'voiceReference', 'targetVoice'] as const) delete next[key];
  const formats = parameterStrings(parameters.format);
  const requestedFormat = String(options.format ?? '').toLowerCase();
  if (formats.length) next.format = formats.includes(requestedFormat) ? requestedFormat : formats[0];
  else delete next.format;
  for (const [field, parameter, fallback] of [
    ['sampleRate', 'sample_rate', 24_000], ['speechRate', 'speech_rate', 0],
    ['pitchRate', 'pitch_rate', 0], ['loudnessRate', 'loudness_rate', 0],
  ] as const) {
    if (parameters[parameter]) next[field] = normalizeParameterNumber(parameters[parameter], options[field], fallback);
    else delete next[field];
  }
  if (parameters.enable_subtitle) next.enableSubtitle = options.enableSubtitle === true;
  else delete next.enableSubtitle;
  if (parameters.speaker_ids) next.speakerIds = (Array.isArray(options.speakerIds) ? options.speakerIds : [])
    .map((id) => String(id).trim()).filter(Boolean).slice(0, parameters.speaker_ids.maxItems ?? 1);
  else delete next.speakerIds;
  return next;
}

export function parseAnyCapCatalog(value: unknown): AnyCapCatalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as AnyCapCatalog).capabilities)) {
    throw new Error('AnyCap 模型目录格式无效，请稍后重试');
  }
  const catalog = value as AnyCapCatalog;
  if (catalog.available === false) throw new Error(catalog.message || 'AnyCap 模型服务暂不可用');
  for (const group of catalog.capabilities!) {
    if (!group || typeof group.id !== 'string' || (group.models !== undefined && (!Array.isArray(group.models) || group.models.some((model) => !model || typeof model.id !== 'string' || (model.label !== undefined && typeof model.label !== 'string'))))) {
      throw new Error('AnyCap 模型目录格式无效，请稍后重试');
    }
  }
  return catalog;
}

export function catalogSyncLabel(catalog: AnyCapCatalog, loading: boolean, error: string): string {
  if (loading) return '正在同步 AnyCap…';
  const live = catalog.catalogSource === 'live';
  if (error) return live ? '同步失败 · 保留上次成功目录' : '同步失败 · 使用已验证目录';
  if (live) return '已同步 AnyCap 最新目录';
  return `已验证目录 · ${String(catalog.verifiedAt ?? catalog.fetchedAt ?? '2026-09-08').slice(0, 10)}`;
}

export function catalogModelHint(catalog: AnyCapCatalog | null | undefined, kind: string, modelId: string): string {
  if (kind === 'video') {
    const capability = catalog?.videoCapabilities?.[modelId];
    if (!capability) return '视频模型';
    const durations = capability.durations;
    return [capability.resolutions.join(' / '), durations.length ? `${Math.min(...durations)}–${Math.max(...durations)} 秒` : '', capability.modes.includes('multi-modal-reference') ? '多参考' : capability.modes.includes('motion-control') ? '动作控制' : capability.modes.includes('first-last-frame-to-video') ? '首尾帧' : '视频创作'].filter(Boolean).join(' · ');
  }
  const capability = kind === 'image' ? catalog?.imageCapabilities?.[modelId] : catalog?.audioCapabilities?.[modelId];
  if (kind === 'image') return Object.values(capability?.parametersByMode ?? {}).some((parameters) => referenceLimitsForParameters(parameters).image > 0) ? '文生图 · 参考图编辑' : '图片生成';
  if (kind === 'audio') return capability?.modes.includes('text-to-audio')
    ? ['语音 / 对话 / 音效', capability.modes.includes('image-to-audio') ? '图片参考' : '', capability.modes.includes('audio-to-audio') ? '音频参考' : ''].filter(Boolean).join(' · ')
    : '音乐创作 · 歌词 / 风格 / 纯音乐';
  return '';
}

export function referenceLimitsForParameters(parameters: AnyCapParameters) {
  return {
    image: parameters.images ? parameters.images.maxItems ?? 1 : parameters.first_frame && parameters.last_frame ? 2 : parameters.image ? 1 : 0,
    video: parameters.videos ? parameters.videos.maxItems ?? 1 : parameters.video ? 1 : 0,
    audio: parameters.audios ? parameters.audios.maxItems ?? 1 : parameters.audio ? 1 : 0,
  };
}

function snapshotCatalog(): AnyCapCatalog {
  const catalog: AnyCapCatalog = { source: 'verified-snapshot', fetchedAt: verifiedSnapshot.verifiedAt, capabilities: [], videoCapabilities: {}, audioCapabilities: {}, imageCapabilities: {} };
  for (const kind of ['image', 'video', 'audio', 'music']) {
    catalog.capabilities!.push({ id: kind, available: true, models: verifiedSnapshot.models.filter((model) => model.capability === kind).map(({ id, label, description }) => ({ id, label, description })) });
  }
  for (const model of verifiedSnapshot.models) {
    const schemas = model.schemas as Array<{ mode: string; parameters: AnyCapParameters }>;
    const modes = schemas.map((schema) => schema.mode);
    const defaultMode = modes.includes('multi-modal-reference') ? 'multi-modal-reference' : modes[0];
    const parametersByMode = Object.fromEntries(schemas.map((schema) => [schema.mode, schema.parameters]));
    const modeOptions = Object.fromEntries(schemas.map(({ mode, parameters }) => [mode, {
      resolutions: parameterStrings(parameters.resolution),
      aspectRatios: parameterStrings(parameters.aspect_ratio),
      durations: parameters.duration?.enum?.map(Number) ?? [],
      formats: parameterStrings(parameters.format),
      supportsGenerateAudio: !!parameters.generate_audio,
      references: referenceLimitsForParameters(parameters),
      referenceMinimums: { image: parameters.images?.minItems ?? (parameters.first_frame && parameters.last_frame ? 2 : parameters.image ? 1 : 0), video: parameters.videos?.minItems ?? (parameters.video ? 1 : 0), audio: parameters.audios?.minItems ?? 0 },
    }]));
    if (!defaultMode) continue;
    const common = { id: model.id, modes, defaultMode, parametersByMode, modeOptions };
    if (model.capability === 'video') {
      const options = modeOptions[defaultMode];
      catalog.videoCapabilities![model.id] = { ...common, supportsMultiShot: modes.includes('multi-shot-video'), ...options, defaultDuration: options.durations.includes(6) ? 6 : options.durations[0] ?? 6, referenceLimits: options.references, referenceLimitsByMode: Object.fromEntries(Object.entries(modeOptions).map(([mode, value]) => [mode, value.references])) };
    } else if (model.capability === 'image') catalog.imageCapabilities![model.id] = common;
    else catalog.audioCapabilities![model.id] = common;
  }
  return catalog;
}

// A verified catalog keeps the editor useful while a gateway is offline; the
// explicit source label prevents presenting this fallback as a live response.
export const verifiedAnyCapCatalog = snapshotCatalog();
