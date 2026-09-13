import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityForVideoMode, catalogModelHint, catalogModels, catalogSyncLabel, musicDurationSeconds, musicTagsFromLegacyOptions, normalizeDoubaoParameters, parameterStrings, parseAnyCapCatalog, referenceLimitsForParameters, verifiedAnyCapCatalog } from '../src/services/anycapCatalog.ts';

test('verified catalog exposes H3, Seedance 2.5 and native audio plus music without duplicates', () => {
  const videos = catalogModels(verifiedAnyCapCatalog, 'video')!;
  assert.deepEqual(videos.slice(0, 2).map((model) => model.id), ['seedance-2.5', 'minimax-h3']);
  const audio = catalogModels(verifiedAnyCapCatalog, 'audio')!;
  assert.equal(audio.length, 5);
  assert.ok(audio.some((model) => model.id === 'doubao-seed-audio-1-0'));
  assert.ok(audio.some((model) => model.id === 'suno-v5.5'));
  assert.equal(new Set(audio.map((model) => model.id)).size, audio.length);
});

test('H3 only exposes generated audio in image mode and adaptive only in multimodal mode', () => {
  const h3 = verifiedAnyCapCatalog.videoCapabilities!['minimax-h3'];
  const text = capabilityForVideoMode(h3, 'text-to-video');
  const image = capabilityForVideoMode(h3, 'image-to-video');
  const multi = capabilityForVideoMode(h3, 'multi-modal-reference');
  assert.deepEqual(text.resolutions, ['2k']);
  assert.equal(Math.min(...text.durations), 5);
  assert.equal(Math.max(...text.durations), 15);
  assert.equal(text.supportsGenerateAudio, false);
  assert.equal(image.supportsGenerateAudio, true);
  assert.equal(multi.supportsGenerateAudio, false);
  assert.equal(text.aspectRatios.includes('adaptive'), false);
  assert.equal(multi.aspectRatios.includes('adaptive'), true);
  assert.deepEqual(text.referenceLimits, { image: 0, video: 0, audio: 0 });
  assert.deepEqual(multi.referenceLimits, { image: 9, video: 3, audio: 3 });
});

test('Seedance 2.5 uses schema duration enum and named first-last frame constraints', () => {
  const seedance = verifiedAnyCapCatalog.videoCapabilities!['seedance-2.5'];
  assert.equal(Math.min(...seedance.durations), 5);
  assert.equal(Math.max(...seedance.durations), 30);
  const firstLast = seedance.modeOptions!['first-last-frame-to-video'];
  assert.equal(firstLast.references!.image, 2);
  assert.equal(firstLast.referenceMinimums!.image, 2);
  assert.equal(firstLast.supportsGenerateAudio, true);
});

test('Doubao parameters and motion references come from mode-specific schemas', () => {
  const doubao = verifiedAnyCapCatalog.audioCapabilities!['doubao-seed-audio-1-0'];
  const params = doubao.parametersByMode!['audio-to-audio'];
  assert.deepEqual(parameterStrings(params.format), ['mp3', 'wav']);
  assert.equal(params.pitch_rate.minimum, -12);
  assert.equal(params.pitch_rate.maximum, 12);
  assert.deepEqual(referenceLimitsForParameters(params), { image: 0, video: 0, audio: 3 });
  const motion = verifiedAnyCapCatalog.videoCapabilities!['kling-3-motion-control'];
  assert.deepEqual(motion.modeOptions!['motion-control'].referenceMinimums, { image: 1, video: 1, audio: 0 });
  const lite = verifiedAnyCapCatalog.imageCapabilities!['nano-banana-lite'];
  assert.equal(referenceLimitsForParameters(lite.parametersByMode!['image-to-image']).image, 0);
});

test('a successful empty catalog section stays empty rather than restoring old models', () => {
  assert.deepEqual(catalogModels({ capabilities: [{ id: 'video', available: true, models: [] }] }, 'video'), []);
  assert.equal(catalogModels({ capabilities: [] }, 'video'), null);
});

test('legacy music style migrates to tags without replacing an explicit new style', () => {
  assert.equal(musicTagsFromLegacyOptions({ style: 'cinematic piano' }), 'cinematic piano');
  assert.equal(musicTagsFromLegacyOptions({ tags: '', style: 'cinematic piano' }), 'cinematic piano');
  assert.equal(musicTagsFromLegacyOptions({ tags: '  ', style: 'cinematic piano' }), 'cinematic piano');
  assert.equal(musicTagsFromLegacyOptions({ tags: 'jazz', style: 'cinematic piano' }), 'jazz');
  assert.equal(musicTagsFromLegacyOptions({}), undefined);
});

test('unavailable catalog groups do not restore stale listed models', () => {
  const catalog = { capabilities: [
    { id: 'audio', available: false, models: [{ id: 'offline-voice', label: 'Offline' }] },
    { id: 'music', available: true, models: [{ id: 'music-1', label: 'Music' }] },
    { id: 'video', available: false },
  ] };
  assert.deepEqual(catalogModels(catalog, 'audio')?.map((model) => model.id), ['music-1']);
  assert.deepEqual(catalogModels(catalog, 'video'), []);
});

test('catalog responses distinguish unavailable and malformed payloads from an empty success', () => {
  assert.throws(() => parseAnyCapCatalog({ available: false, capabilities: [], message: '维护中' }), /维护中/);
  for (const invalid of [null, [], {}, { capabilities: [{ id: 'video', models: [{}] }] }]) {
    assert.throws(() => parseAnyCapCatalog(invalid), /格式无效/);
  }
  assert.deepEqual(parseAnyCapCatalog({ capabilities: [] }).capabilities, []);
  assert.equal(catalogSyncLabel({ catalogSource: 'live' }, false, 'refresh failed'), '同步失败 · 保留上次成功目录');
  assert.equal(catalogSyncLabel(verifiedAnyCapCatalog, false, 'offline'), '同步失败 · 使用已验证目录');
});

test('legacy per-mode reference limits are used when no modeOptions are supplied', () => {
  const source = verifiedAnyCapCatalog.videoCapabilities!['minimax-h3'];
  const legacy = { ...source, modeOptions: undefined };
  assert.deepEqual(capabilityForVideoMode(legacy, 'text-to-video').referenceLimits, { image: 0, video: 0, audio: 0 });
});

test('Doubao values normalize against the selected schema and remove music-only values', () => {
  const parameters = {
    format: { enum: ['wav'] }, sample_rate: { enum: [16000, 48000] },
    speech_rate: { type: 'integer', minimum: -10, maximum: 10 },
    speaker_ids: { maxItems: 1 }, enable_subtitle: { type: 'boolean' },
  };
  const input = { format: 'mp3', sampleRate: 24000, speechRate: 80, pitchRate: 12, duration: 30, musicDurationMs: 90000, tags: 'old music', speakerIds: [' a ', 'b'], enableSubtitle: true };
  const normalized = normalizeDoubaoParameters(input, parameters);
  assert.equal(normalized.format, 'wav');
  assert.equal(normalized.sampleRate, 16000);
  assert.equal(normalized.speechRate, 10);
  assert.deepEqual(normalized.speakerIds, ['a']);
  for (const field of ['pitchRate', 'duration', 'musicDurationMs', 'tags']) assert.equal(field in normalized, false);
  assert.equal(input.duration, 30, 'loading options must not mutate existing nodes');
  assert.deepEqual(normalizeDoubaoParameters({ speakerIds: ['a'], enableSubtitle: true }, {}), {});
});

test('legacy millisecond music duration becomes the displayed seconds and honors schema bounds', () => {
  assert.equal(musicDurationSeconds({ musicDurationMs: 45000, duration: 30 }, { type: 'integer' }), 45);
  assert.equal(musicDurationSeconds({ duration: 90 }, { type: 'integer', maximum: 60000 }), 60);
  assert.equal(musicDurationSeconds({ duration: 0 }, { type: 'integer' }), 30);
  assert.equal(musicDurationSeconds({ duration: Number.NaN }, { type: 'integer' }), 30);
  assert.equal(musicDurationSeconds({ duration: 18 }, { enum: [10000, 20000, 30000] }), 20);
});

test('model hints do not claim image references when the selected model has no images parameter', () => {
  assert.equal(catalogModelHint(verifiedAnyCapCatalog, 'image', 'nano-banana-lite'), '图片生成');
  assert.match(catalogModelHint(verifiedAnyCapCatalog, 'image', 'nano-banana-2'), /参考图编辑/);
  const voiceOnly = { audioCapabilities: { voice: { modes: ['text-to-audio'], defaultMode: 'text-to-audio' } } };
  assert.equal(catalogModelHint(voiceOnly, 'audio', 'voice').includes('参考'), false);
});
