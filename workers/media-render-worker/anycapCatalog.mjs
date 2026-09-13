import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'docs/anycap/catalog-2026-09-08.json'), 'utf8'));

export function anyCapModel(modelId) {
  const aliases = { 'suno-v5-5': 'suno-v5.5', 'elevenlabs-music': 'elevanlabs-music', h3: 'minimax-h3' };
  const id = aliases[modelId] || modelId;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(root, '.runtime/anycap-catalog.json'), 'utf8'));
    const cached = cache.models?.find((item) => item.id === id && Array.isArray(item.schemas) && item.schemas.length);
    if (cached) return cached;
  } catch { /* Use the audited public catalog when an online refresh is unavailable. */ }
  return snapshot.models.find((item) => item.id === id);
}

export function anyCapModeOptions(parameters, mode) {
  const references = {};
  const referenceMinimums = {};
  for (const [type, param] of Object.entries({ image: 'images', video: 'videos', audio: 'audios' })) {
    references[type] = parameters[param] ? Number(parameters[param].maxItems ?? 1) : 0;
    referenceMinimums[type] = Number(parameters[param]?.minItems ?? 0);
  }
  if (parameters.first_frame && parameters.last_frame) {
    references.image = 2;
    referenceMinimums.image = 2;
  }
  return {
    resolutions: parameters.resolution?.enum || [],
    durations: parameters.duration?.enum || [],
    aspectRatios: parameters.aspect_ratio?.enum || [],
    formats: parameters.format?.enum || [],
    sampleRates: parameters.sample_rate?.enum || [],
    supportsGenerateAudio: !!parameters.generate_audio,
    supportsAdaptive: !!parameters.aspect_ratio?.enum?.includes('adaptive'),
    references,
    referenceMinimums,
    mode,
  };
}

export function anyCapDescriptor(modelId) {
  const model = anyCapModel(modelId);
  if (!model) return undefined;
  const schemas = model.schemas.filter((item) => item.operation === 'generate');
  const modes = schemas.map((item) => item.mode);
  const mode = modes.includes('multi-modal-reference') ? 'multi-modal-reference' : modes[0];
  const parametersByMode = Object.fromEntries(schemas.map((item) => [item.mode, item.parameters]));
  const modeOptions = Object.fromEntries(schemas.map((item) => [item.mode, anyCapModeOptions(item.parameters, item.mode)]));
  const selected = modeOptions[mode] || {};
  const durations = selected.durations || [];
  return {
    capability: model.capability, mode, modes, parametersByMode, modeOptions, ...selected,
    defaultDuration: durations.includes(6) ? 6 : durations[0],
    referencesByMode: Object.fromEntries(modes.map((item) => [item, modeOptions[item].references])),
  };
}

export function anyCapParameters(modelId, mode) {
  return anyCapDescriptor(modelId)?.parametersByMode[mode];
}

export function validateAnyCapReferences(modelId, mode, counts) {
  const descriptor = anyCapDescriptor(modelId);
  const selected = descriptor?.modeOptions[mode];
  if (!selected) throw new Error(`${modelId} 不支持 ${mode} 模式，请刷新模型列表`);
  const labels = { image: '图片', video: '视频', audio: '音频' };
  for (const type of Object.keys(labels)) {
    const count = counts[type] || 0;
    const minimum = selected.referenceMinimums[type];
    const maximum = selected.references[type];
    if (count < minimum || count > maximum) {
      throw new Error(`${modelId} / ${mode} 需要 ${minimum}–${maximum} 个${labels[type]}参考，当前 ${count} 个`);
    }
  }
}

export function normalizeAnyCapParameter(schema, value) {
  if (!schema || value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return schema.default ?? schema.enum[0];
  if (schema.type === 'integer' || schema.type === 'number') {
    let numeric = Number(value);
    if (!Number.isFinite(numeric)) return schema.default;
    if (schema.type === 'integer') numeric = Math.round(numeric);
    if (Number.isFinite(schema.minimum)) numeric = Math.max(schema.minimum, numeric);
    if (Number.isFinite(schema.maximum)) numeric = Math.min(schema.maximum, numeric);
    return numeric;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (schema.type === 'array') return Array.isArray(value) ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}
