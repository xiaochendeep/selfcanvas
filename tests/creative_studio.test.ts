import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreativeActionLock, createCreativeRequestId, creativeDraftIssue, creativeImageBatchAction, creativeIntegerInput, editCreativeDraft, editCreativeShot, validateCreativeCapabilities, validateCreativeRunResult, type CreativeRunResult, type CreativeShot } from '../src/services/creativeStudioClient.ts';

const script: CreativeRunResult = {
  runId: 'creative-test', canvasId: 'original-canvas', sourceRevision: 9,
  kind: 'script', model: 'gateway-model', skillSources: ['video/1'], warnings: ['尚未审核'],
  draft: { kind: 'script', version: 1, title: '雨夜', logline: '雨夜出现访客', script: '门被敲响。',
    anchors: { emotion: '悬念', motif: '雨', prop: '门', turn: '访客', finalImage: '开门' }, characters: [],
    beats: [{ title: '敲门', action: '敲响木门', consequence: '屋内人回头', durationSeconds: 5 }],
  },
};

test('editing a draft preserves provenance, original canvas and revision without mutating input', () => {
  const before = structuredClone(script);
  const edited = editCreativeDraft(script, { script: '手指轻敲木门，屋内人停下动作。' });
  assert.deepEqual(script, before);
  assert.equal(edited.canvasId, 'original-canvas');
  assert.equal(edited.sourceRevision, 9);
  assert.deepEqual(edited.skillSources, ['video/1']);
  assert.equal(edited.draft.kind, 'script');
  assert.deepEqual(edited.draft.kind === 'script' && edited.draft.anchors, before.draft.kind === 'script' && before.draft.anchors);
});

test('editing cannot silently change draft kind or version', () => {
  const edited = editCreativeDraft(script, { kind: 'video-analysis' });
  assert.equal(edited.draft.kind, 'script');
  assert.equal(edited.draft.version, 1);
});

const shot: CreativeShot = {
  shotNumber: 1, shotSize: '特写', visualDescription: '手指敲门', cameraMovement: '静止',
  imagePrompt: 'Draw a hand beside a wooden door.', videoPrompt: 'A hand taps the door.', durationSeconds: 5,
  function: '引入', emotion: '紧张', composition: '右侧手指', movementReason: '保持动作可读', eyeTrace: '手指',
  cutType: '硬切', sound: '敲门', lighting: '暖灯', productionNote: '候选', environmentPressure: '雨夜',
  microAction: '敲击', motif: '雨', continuity: '同一扇门', finalFrame: '手指停住',
};

test('shot editing preserves direction, continuity and other shots', () => {
  const result: CreativeRunResult = { ...script, kind: 'storyboard', draft: { kind: 'storyboard', version: 1, title: '门', shotCount: 2, shots: [shot, { ...shot, shotNumber: 2 }], reviewNotes: ['检查人物'] } };
  const edited = editCreativeShot(result, 0, { imagePrompt: 'Draw the same door in the rain.' });
  assert.equal(result.draft.kind === 'storyboard' && result.draft.shots[0].imagePrompt, shot.imagePrompt);
  assert.equal(edited.draft.kind === 'storyboard' && edited.draft.shots[0].continuity, '同一扇门');
  assert.deepEqual(edited.draft.kind === 'storyboard' && edited.draft.shots[1], { ...shot, shotNumber: 2 });
  assert.equal(creativeDraftIssue(edited.draft), '');
});

test('empty script and incomplete storyboard are blocked before import', () => {
  assert.equal(creativeDraftIssue({ ...script.draft, title: '' }), '请填写草稿标题');
  assert.equal(creativeDraftIssue({ ...script.draft, kind: 'script', script: ' ', anchors: { emotion: '', motif: '', prop: '', turn: '', finalImage: '' }, logline: '', characters: [], beats: [] }), '剧本正文不能为空');
  assert.equal(creativeDraftIssue({ kind: 'storyboard', version: 1, title: '门', shotCount: 1, shots: [{ ...shot, imagePrompt: '' }], reviewNotes: [] }), '镜头 1 的图片或视频提示词不能为空');
  assert.equal(creativeDraftIssue({ kind: 'storyboard', version: 1, title: '门', shotCount: 21, shots: Array.from({ length: 21 }, () => shot), reviewNotes: [] }), '分镜应包含 1–20 个镜头');
});

test('batch generation skips completed media and never repeats an uncertain paid job', () => {
  assert.equal(creativeImageBatchAction({ status: 'idle' }), 'generate');
  assert.equal(creativeImageBatchAction({ status: 'success', lastJobId: 'job-1' }), 'skip');
  assert.equal(creativeImageBatchAction({ status: 'running', lastJobId: 'job-1' }), 'review');
  assert.equal(creativeImageBatchAction({ status: 'error' }), 'review');
  assert.equal(creativeImageBatchAction({ status: 'idle', lastJobId: 'unknown-job' }), 'review');
});

test('numeric editing accepts complete integers without clamping an empty intermediate value', () => {
  assert.equal(creativeIntegerInput('', 5, 600), null);
  assert.equal(creativeIntegerInput('1', 5, 600), null);
  assert.equal(creativeIntegerInput('15', 5, 600), 15);
  assert.equal(creativeIntegerInput('600', 5, 600), 600);
  assert.equal(creativeIntegerInput('601', 5, 600), null);
  assert.equal(creativeIntegerInput('1.5', 1, 20), null);
  assert.equal(creativeIntegerInput('2e1', 1, 20), null);
  assert.equal(creativeIntegerInput('20', 1, 20), 20);
});

test('synchronous action lock prevents two submissions before React state has rendered', () => {
  const lock = createCreativeActionLock();
  assert.equal(lock.isActive(), false);
  assert.equal(lock.acquire(), true);
  assert.equal(lock.acquire(), false);
  assert.equal(lock.isActive(), true);
  lock.release();
  assert.equal(lock.acquire(), true);
});

test('malformed capability payload fails safely rather than crashing the modal', () => {
  const capabilities = { version: 1, available: false, requiresConfirmation: true, skills: [{ kind: 'script', label: '剧本', model: '', available: false, status: 'not-configured' }], limits: { maxVideoBytes: 1024, maxTextChars: 40000, maxShots: 20 } };
  assert.deepEqual(validateCreativeCapabilities(capabilities), capabilities);
  for (const payload of [null, {}, { ...capabilities, skills: {} }, { ...capabilities, limits: null }, { ...capabilities, limits: { ...capabilities.limits, maxShots: 0 } }]) {
    assert.throws(() => validateCreativeCapabilities(payload), /格式不兼容/);
  }
});

test('gateway results must match the requested kind and canvas before the editor renders them', () => {
  const request = { kind: 'script' as const, canvasId: 'original-canvas' };
  assert.equal(validateCreativeRunResult(script, request), script);
  for (const payload of [null, { ...script, draft: null }, { ...script, draft: { ...script.draft, kind: 'storyboard' } }, { ...script, skillSources: {} }, { ...script, canvasId: 'other-canvas' }, { ...script, draft: { ...script.draft, anchors: null } }]) {
    assert.throws(() => validateCreativeRunResult(payload, request), /未修改画布/);
  }
});

test('analysis editing retains a trailing newline so Enter can start the next idea', () => {
  const original: CreativeRunResult = { ...script, kind: 'video-analysis', draft: { kind: 'video-analysis', version: 1, title: '片段', summary: '视频摘要', openingHook: '开场', segments: [], adaptationIdeas: ['以动作开场'], limitations: [] } };
  const typed = '以动作开场\n';
  const edited = editCreativeDraft(original, { adaptationIdeas: typed.split('\n') });
  assert.equal(edited.draft.kind === 'video-analysis' && edited.draft.adaptationIdeas.join('\n'), typed);
});

test('creative request IDs prefer native UUID without altering security tokens', () => {
  assert.equal(createCreativeRequestId({ randomUUID: () => 'd633ab5a-07a5-4a57-a611-121bf3e644f2' }), 'creative_d633ab5a-07a5-4a57-a611-121bf3e644f2');
});

test('LAN HTTP works when randomUUID is missing or restricted but getRandomValues exists', () => {
  const randomValues = (bytes: Uint8Array) => { bytes.fill(0xab); return bytes; };
  const expected = `creative_${'ab'.repeat(16)}`;
  assert.equal(createCreativeRequestId({ getRandomValues: randomValues }), expected);
  assert.equal(createCreativeRequestId({ randomUUID: () => { throw new Error('restricted'); }, getRandomValues: randomValues }), expected);
});

test('non-security request fallback stays unique and API-compatible even without Web Crypto', () => {
  const ids = Array.from({ length: 1000 }, () => createCreativeRequestId(null));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_.-]{8,128}$/.test(id)));
  const restricted = createCreativeRequestId({ getRandomValues: () => { throw new Error('unavailable'); } });
  assert.match(restricted, /^creative_[a-z0-9]+_[a-z0-9]+_[a-z0-9]*$/);
});
