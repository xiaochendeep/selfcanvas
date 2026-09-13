import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAssetBrowserIndex,
  assetEmptyState,
  formatAssetSize,
  parseAssetFileList,
  safeAssetPreviewUrl,
  scopeAssets,
  searchAssets,
  sortAssets,
} from '../src/services/assetBrowser.ts';

const output = {
  id: 'opaque-1', title: '雨夜茶铺.png', type: 'image' as const, url: '/api/files/opaque-1',
  size: 2048, createdAt: '2026-09-08T04:00:00.000Z',
};
const canvasFile = {
  ...output, artifactId: output.id, canvasId: 'canvas-1', canvasName: '第一集',
  nodeId: 'node-1', nodeTitle: '茶铺场景', source: 'canvas' as const, origin: 'imported' as const,
};

test('one asset card retains all cross-canvas locations and prefers the active canvas', () => {
  const input = [canvasFile, { ...canvasFile, canvasId: 'canvas-2', canvasName: '第二集', nodeId: 'node-2' }];
  const before = structuredClone(input);
  const result = buildAssetBrowserIndex(input, [output], 'canvas-2');
  assert.equal(result.length, 1);
  assert.equal(result[0].locations.length, 2);
  assert.equal(result[0].canvasId, 'canvas-2');
  assert.equal(result[0].nodeId, 'node-2');
  assert.deepEqual(input, before, 'indexing must not mutate live canvas data');
  assert.equal(scopeAssets(result, 'current', 'canvas-1').length, 1);
  assert.equal(scopeAssets(result, 'current', 'canvas-3').length, 0);
});

test('pending canvas media stays visible without claiming an output file exists', () => {
  const pending = { ...canvasFile, id: 'pending', artifactId: undefined, url: 'https://media.example/video.mp4', type: 'video' as const };
  const result = buildAssetBrowserIndex([pending], [], 'canvas-1');
  assert.equal(result.length, 1);
  assert.equal(scopeAssets(result, 'project', 'canvas-1').length, 1);
  assert.equal(scopeAssets(result, 'output', 'canvas-1').length, 0);
  assert.equal(result[0].artifactId, undefined);
});

test('unlinked output files are searchable separately from imported and generated assets', () => {
  const unlinked = { ...output, id: 'opaque-2', title: '旁白配音.mp3', type: 'audio' as const };
  const result = buildAssetBrowserIndex([canvasFile], [output, unlinked], 'canvas-1');
  assert.equal(scopeAssets(result, 'output', 'canvas-1').length, 2);
  assert.equal(scopeAssets(result, 'project', 'canvas-1').length, 1);
  assert.deepEqual(searchAssets(result, '', 'output').map((file) => file.title), ['旁白配音.mp3']);
  assert.deepEqual(searchAssets(result, '茶铺场景', 'imported').map((file) => file.title), ['雨夜茶铺.png']);
  assert.equal(searchAssets(result, '第一集', 'all').length, 1);
});

test('sorting uses real metadata without changing the shared asset index', () => {
  const second = { ...output, id: 'opaque-2', title: 'B', size: 1024, createdAt: '2026-09-07T04:00:00.000Z' };
  const index = buildAssetBrowserIndex([], [second, output], 'canvas-1');
  const originalOrder = index.map((file) => file.id);
  assert.equal(sortAssets(index, 'newest')[0].id, output.id);
  assert.equal(sortAssets(index, 'oldest')[0].id, second.id);
  assert.equal(sortAssets(index, 'size')[0].id, output.id);
  assert.deepEqual(index.map((file) => file.id), originalOrder);
});

test('file sizes distinguish unknown metadata from real zero or small files', () => {
  assert.equal(formatAssetSize(0), '大小未知');
  assert.equal(formatAssetSize(Number.NaN), '大小未知');
  assert.equal(formatAssetSize(42), '42 B');
  assert.equal(formatAssetSize(1024), '1 KB');
  assert.equal(formatAssetSize(2 * 1024 * 1024), '2.0 MB');
});

test('a failed asset request is not represented as an empty library', () => {
  for (const scope of ['current', 'project', 'output'] as const) {
    const state = assetEmptyState(scope, false, false, true);
    assert.equal(state.failed, true);
    assert.equal(/暂无|没有素材/.test(state.title), false);
  }
  assert.equal(assetEmptyState('output', false, true, true).pending, true);
  assert.equal(assetEmptyState('current', false, false, false).title, '这个画布还没有素材');
  assert.equal(assetEmptyState('project', true, false, false).title, '没有找到匹配的素材');
});

test('malformed API file lists fail without replacing the valid index', () => {
  assert.deepEqual(parseAssetFileList([output]), [output]);
  assert.deepEqual(parseAssetFileList([]), []);
  for (const invalid of [{ error: 'offline' }, null, [null], [{ ...output, id: '' }], [{ ...output, type: 'invalid' }]]) {
    assert.throws(() => parseAssetFileList(invalid), /格式异常/);
  }
});

test('preview links support media sources but do not activate scripts or arbitrary schemes', () => {
  for (const valid of ['/api/files/123', 'https://cdn.example/video.mp4', 'blob:https://local.example/id', 'data:image/png;base64,AA==']) assert.equal(safeAssetPreviewUrl(valid), valid);
  for (const invalid of ['', 'javascript:alert(1)', 'file:///private/file', 'data:text/html;base64,AA==', '//other-host/file']) assert.equal(safeAssetPreviewUrl(invalid), '');
});
