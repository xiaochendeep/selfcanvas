import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCreativeCanvasImport, creativeDraftMarkdown } from '../src/services/creativeCanvas.ts';
import type { CreativeRunResult, CreativeShot } from '../src/services/creativeStudioClient.ts';
import type { NodeKind, StudioCanvas, StudioNode } from '../src/types.ts';

const factory = (kind: NodeKind, index: number, position: { x: number; y: number }): StudioNode => ({
  id: `generated-${index}`, type: 'studioNode', position, width: 300, height: 220,
  data: { kind, title: '', prompt: '', status: 'idle', progress: 0, model: '', provider: '', inputs: [], outputs: {} },
});
const original = factory('video', 0, { x: 100, y: 60 });
const canvas: StudioCanvas = { id: 'canvas-test', name: 'test', nodes: [original], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' };
const script: CreativeRunResult = {
  runId: 'run-script', kind: 'script', model: 'test-model', sourceRevision: 3, canvasId: canvas.id, skillSources: ['video'], warnings: [],
  draft: { kind: 'script', version: 1, title: '测试剧本', logline: '寻找遗失的钥匙', script: '她看见钥匙落在门外，停下关门的手。', anchors: { emotion: '期待', motif: '门缝', prop: '钥匙', turn: '发现钥匙', finalImage: '手伸向钥匙' }, characters: [], beats: [] },
};
const shot: CreativeShot = { shotNumber: 1, shotSize: '近景', visualDescription: '她的手停在门把上', cameraMovement: '固定', imagePrompt: 'Create a hand resting on a worn brass handle.', videoPrompt: 'Her hand stops and turns the handle.', durationSeconds: 5, function: 'Reveal', emotion: '迟疑', composition: '门缝在右侧', movementReason: '固定观察', eyeTrace: '手', cutType: '硬切', sound: '钥匙碰响', lighting: '门外自然光', productionNote: '同一把钥匙', environmentPressure: '门将合拢', microAction: '指尖停下', motif: '门缝', continuity: '同一套衣袖', finalFrame: '手握钥匙' };

test('import appends draft text and preserves all original canvas data', () => {
  const before = structuredClone(canvas);
  const result = buildCreativeCanvasImport(script, canvas, factory);
  assert.deepEqual(canvas, before);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].data.outputs.text, creativeDraftMarkdown(script));
  assert.match(result.nodes[0].data.outputs.text!, /候选草稿/);
  assert.equal(result.imageNodeIds.length, 0);
  assert.ok(result.nodes[0].position.x > original.position.x + original.width!);
});

test('storyboard imports one document and idle images in shot order, never pretend media exists', () => {
  const result = buildCreativeCanvasImport({ ...script, runId: 'run-story', kind: 'storyboard', imageModel: 'nano-banana-2', aspectRatio: '9:16', draft: { kind: 'storyboard', version: 1, title: '分镜', shotCount: 2, shots: [shot, { ...shot, shotNumber: 2 }], reviewNotes: [] } }, canvas, factory);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.edges.length, 2);
  assert.equal(result.imageNodeIds.length, 2);
  for (const node of result.nodes.slice(1)) {
    assert.deepEqual(node.data.outputs, {});
    assert.equal(node.data.status, 'idle');
    assert.equal(node.data.providerOptions?.aspectRatio, '9:16');
    assert.equal(node.data.providerOptions?.providerTool, 'anycap');
    assert.deepEqual(node.data.references, []);
  }
  assert.equal(result.nodes[0].data.outputs.storyboard?.shots[0].imagePrompt, shot.imagePrompt);
});

test('same run cannot insert duplicate nodes or overwrite an edited imported node', () => {
  const first = buildCreativeCanvasImport(script, canvas, factory);
  first.nodes[0].data.outputs.text = '用户手动编辑';
  const second = buildCreativeCanvasImport(script, { ...canvas, nodes: [...canvas.nodes, ...first.nodes] }, factory);
  assert.equal(second.nodes.length, 0);
  assert.deepEqual(second.nodeIds, first.nodeIds);
  assert.equal(first.nodes[0].data.outputs.text, '用户手动编辑');
});

test('rejects wrong canvas, malformed IDs, empty prompts and colliding unrelated nodes', () => {
  assert.throws(() => buildCreativeCanvasImport({ ...script, canvasId: 'other' }, canvas, factory), /不匹配/);
  assert.throws(() => buildCreativeCanvasImport({ ...script, runId: '../../a' }, canvas, factory), /ID 无效/);
  assert.throws(() => buildCreativeCanvasImport({ ...script, kind: 'storyboard', draft: { kind: 'storyboard', version: 1, title: '分镜', shotCount: 1, shots: [{ ...shot, imagePrompt: '' }], reviewNotes: [] } }, canvas, factory), /不完整/);
  assert.throws(() => buildCreativeCanvasImport(script, { ...canvas, nodes: [{ ...original, id: 'creative_run-script_document' }] }, factory), /ID 冲突/);
});

test('analysis links the original source and labels inference instead of claiming popularity', () => {
  const analysis: CreativeRunResult = { ...script, kind: 'video-analysis', sourceNodeId: original.id, draft: { kind: 'video-analysis', version: 1, title: '吸引点', summary: '钥匙被发现', openingHook: '门即将关闭', segments: [{ startSeconds: 0, endSeconds: 3, observation: '钥匙闪过', appeal: '可能引起好奇', technique: '信息差', confidence: 0.7 }], adaptationIdeas: ['更换道具'], limitations: ['没有平台数据'] } };
  const result = buildCreativeCanvasImport(analysis, canvas, factory);
  assert.equal(result.edges[0].source, original.id);
  assert.match(result.nodes[0].data.outputs.text!, /吸引力推断/);
  assert.match(result.nodes[0].data.outputs.text!, /不代表已验证/);
  assert.throws(() => buildCreativeCanvasImport({ ...analysis, sourceNodeId: 'gone' }, canvas, factory), /不存在/);
});
