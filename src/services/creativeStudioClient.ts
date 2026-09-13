export type CreativeKind = 'script' | 'storyboard' | 'video-analysis';
export interface ScriptDraft {
  kind: 'script'; version: 1; title: string; logline: string; script: string;
  anchors: { emotion: string; motif: string; prop: string; turn: string; finalImage: string };
  characters: Array<{ name: string; description: string }>;
  beats: Array<{ title: string; action: string; consequence: string; durationSeconds: number }>;
}
export interface CreativeShot {
  shotNumber: number; shotSize: string; visualDescription: string; cameraMovement: string;
  imagePrompt: string; videoPrompt: string; durationSeconds: number; function: string;
  emotion: string; composition: string; movementReason: string; eyeTrace: string; cutType: string;
  sound: string; lighting: string; productionNote: string; environmentPressure: string;
  microAction: string; motif: string; continuity: string; finalFrame: string;
}
export interface StoryboardDraft {
  kind: 'storyboard'; version: 1; title: string; shotCount: number;
  shots: CreativeShot[]; reviewNotes: string[];
}
export interface VideoAnalysisDraft {
  kind: 'video-analysis'; version: 1; title: string; summary: string; openingHook: string;
  segments: Array<{ startSeconds: number; endSeconds: number; observation: string; appeal: string; technique: string; confidence: number }>;
  adaptationIdeas: string[]; limitations: string[];
}
export type CreativeDraft = ScriptDraft | StoryboardDraft | VideoAnalysisDraft;
export interface CreativeRunResult {
  runId: string; kind: CreativeKind; model: string; sourceRevision: number; canvasId: string;
  draft: CreativeDraft; skillSources: string[]; warnings: string[];
  imageModel?: string; videoModel?: string; sourceNodeId?: string; aspectRatio?: string;
}
export interface CreativeCapabilities {
  version: 1; available: boolean;
  skills: Array<{ kind: CreativeKind; label: string; available: boolean; model: string; status: 'ready' | 'not-configured' | 'invalid-config'; reason?: string }>;
  limits: { maxVideoBytes: number; maxTextChars: number; maxShots: number };
  requiresConfirmation: boolean;
}
export interface CreativeRunRequest {
  kind: CreativeKind; requestId: string; confirmed: true; canvasId: string; brief: string;
  sourceText?: string; shotCount?: number; durationSeconds?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1'; style?: string; imageModel?: string; videoModel?: string;
  sourceNodeId?: string;
}

interface CreativeRequestRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array<ArrayBuffer>) => Uint8Array;
}
let fallbackRequestSequence = 0;

/** Idempotency identifier only — never use this fallback for tokens or CSRF secrets. */
export function createCreativeRequestId(source: CreativeRequestRandomSource | null | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === 'function') {
    try { return `creative_${source.randomUUID()}`; } catch { /* Some embedded browsers expose but restrict this API. */ }
  }
  if (typeof source?.getRandomValues === 'function') {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      return `creative_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    } catch { /* Continue with a non-security request ID if Web Crypto is unavailable. */ }
  }
  fallbackRequestSequence += 1;
  return `creative_${Date.now().toString(36)}_${fallbackRequestSequence.toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const textFields = (value: Record<string, unknown>, fields: string[]) => fields.every((field) => typeof value[field] === 'string');

export function validateCreativeCapabilities(value: unknown): CreativeCapabilities {
  if (!record(value) || value.version !== 1 || typeof value.available !== 'boolean' || !Array.isArray(value.skills) ||
      !value.skills.every((skill) => record(skill) && ['script', 'storyboard', 'video-analysis'].includes(String(skill.kind)) &&
        textFields(skill, ['label', 'model']) && typeof skill.available === 'boolean' && ['ready', 'not-configured', 'invalid-config'].includes(String(skill.status))) ||
      !record(value.limits) || !['maxVideoBytes', 'maxTextChars', 'maxShots'].every((key) => finite(value.limits && (value.limits as Record<string, unknown>)[key]) && Number((value.limits as Record<string, unknown>)[key]) > 0)) {
    throw new Error('创作能力响应格式不兼容，请检查服务端版本后刷新');
  }
  return value as unknown as CreativeCapabilities;
}

export function validateCreativeRunResult(value: unknown, request: Pick<CreativeRunRequest, 'kind' | 'canvasId'>): CreativeRunResult {
  let valid = record(value) && textFields(value, ['runId', 'model']) && Boolean(value.runId) && value.kind === request.kind && value.canvasId === request.canvasId &&
    finite(value.sourceRevision) && strings(value.skillSources) && strings(value.warnings) && record(value.draft) && value.draft.kind === request.kind && value.draft.version === 1 && typeof value.draft.title === 'string';
  const draft = record(value) && record(value.draft) ? value.draft : {};
  if (valid && request.kind === 'script') {
    valid = textFields(draft, ['logline', 'script']) && record(draft.anchors) && textFields(draft.anchors, ['emotion', 'motif', 'prop', 'turn', 'finalImage']) &&
      Array.isArray(draft.characters) && draft.characters.every((item) => record(item) && textFields(item, ['name', 'description'])) &&
      Array.isArray(draft.beats) && draft.beats.every((item) => record(item) && textFields(item, ['title', 'action', 'consequence']) && finite(item.durationSeconds));
  } else if (valid && request.kind === 'storyboard') {
    valid = strings(draft.reviewNotes) && Array.isArray(draft.shots) && draft.shots.length > 0 && draft.shots.length <= 20 && draft.shotCount === draft.shots.length &&
      draft.shots.every((item) => record(item) && finite(item.shotNumber) && finite(item.durationSeconds) && textFields(item, ['shotSize', 'visualDescription', 'cameraMovement', 'imagePrompt', 'videoPrompt', 'function', 'emotion', 'composition', 'movementReason', 'eyeTrace', 'cutType', 'sound', 'lighting', 'productionNote', 'environmentPressure', 'microAction', 'motif', 'continuity', 'finalFrame']));
  } else if (valid && request.kind === 'video-analysis') {
    valid = textFields(draft, ['summary', 'openingHook']) && strings(draft.adaptationIdeas) && strings(draft.limitations) && Array.isArray(draft.segments) &&
      draft.segments.every((item) => record(item) && textFields(item, ['observation', 'appeal', 'technique']) && finite(item.startSeconds) && finite(item.endSeconds) &&
        item.startSeconds >= 0 && item.endSeconds > item.startSeconds && finite(item.confidence) && item.confidence >= 0 && item.confidence <= 1);
  }
  if (!valid) throw new Error('创作响应不完整、格式不兼容或画布不匹配，未修改画布');
  return value as CreativeRunResult;
}

/** Unlike per-keystroke clamping, allow an empty input while a user is typing. */
export function creativeIntegerInput(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

/** React state updates are asynchronous; this prevents same-tick duplicate paid actions. */
export function createCreativeActionLock() {
  let active = false;
  return {
    acquire() { if (active) return false; active = true; return true; },
    release() { active = false; },
    isActive() { return active; },
  };
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({ error: '服务器返回了无法读取的响应' })) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || `请求失败 (${response.status})`);
  return payload;
}

export async function getCreativeCapabilities(signal?: AbortSignal) {
  const { browserApiFetch } = await import('./browserSession');
  return validateCreativeCapabilities(await jsonResponse<unknown>(await browserApiFetch('/api/v2/creative/capabilities', { signal, cache: 'no-store' })));
}

export async function runCreative(request: CreativeRunRequest) {
  const { browserApiFetch } = await import('./browserSession');
  // No retry here: an uncertain gateway response may already have consumed model credit.
  const result = validateCreativeRunResult(await jsonResponse<unknown>(await browserApiFetch('/api/v2/creative/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })), request);
  return { ...result, imageModel: request.imageModel, videoModel: request.videoModel, sourceNodeId: request.sourceNodeId, aspectRatio: request.aspectRatio };
}

/** Pure edits preserve source revision, provenance and all nonedited draft fields. */
export function editCreativeDraft(result: CreativeRunResult, patch: Partial<CreativeDraft>): CreativeRunResult {
  return { ...result, draft: { ...result.draft, ...patch, kind: result.draft.kind, version: 1 } as CreativeDraft };
}

export function editCreativeShot(result: CreativeRunResult, index: number, patch: Partial<CreativeShot>): CreativeRunResult {
  if (result.draft.kind !== 'storyboard') return result;
  return { ...result, draft: { ...result.draft, shots: result.draft.shots.map((shot, at) => at === index ? { ...shot, ...patch } : shot) } };
}

export function creativeDraftIssue(draft: CreativeDraft): string {
  if (!draft.title.trim()) return '请填写草稿标题';
  if (draft.kind === 'script' && !draft.script.trim()) return '剧本正文不能为空';
  if (draft.kind === 'storyboard') {
    if (!draft.shots.length || draft.shots.length > 20) return '分镜应包含 1–20 个镜头';
    const empty = draft.shots.findIndex((shot) => !shot.imagePrompt.trim() || !shot.videoPrompt.trim());
    if (empty >= 0) return `镜头 ${empty + 1} 的图片或视频提示词不能为空`;
  }
  if (draft.kind === 'video-analysis' && !draft.summary.trim()) return '分析摘要不能为空';
  return '';
}

/** Never silently resubmit a node whose paid job may already exist. */
export function creativeImageBatchAction(node: { status?: string; lastJobId?: string }): 'generate' | 'skip' | 'review' {
  if (node.status === 'success') return 'skip';
  if (node.lastJobId || (node.status && node.status !== 'idle')) return 'review';
  return 'generate';
}
