import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocallyDownloadableUrl, mergeCanvasMediaFiles, linkOutputFilesToCanvas } from '../src/services/artifactClient.ts';
import type { GeneratedFile, StudioCanvas } from '../src/types.ts';

Object.defineProperty(globalThis, 'window', { value: { location: { href: 'http://localhost:5190/', origin: 'http://localhost:5190' } }, configurable: true });
const canvas = (url: string): StudioCanvas => ({
  id: 'canvas', name: '画布', updatedAt: '2026-09-08T00:00:00Z', edges: [], groups: [],
  nodes: [{ id: 'node', type: 'studioNode', position: { x: 0, y: 0 }, data: {
    kind: 'image', title: '图片', prompt: '', model: '', provider: '', status: 'success', progress: 100,
    inputs: [], outputs: { imageUrl: url, assetName: '图片.png' },
  } }],
} as StudioCanvas);
const file = (url: string): GeneratedFile => ({ id: 'opaque', title: '图片.png', type: 'image', url, size: 1024, createdAt: '2026-09-08T00:00:00Z', downloadUrl: '/api/files/download/opaque' });

test('same filenames or paths on different origins never bind to unrelated downloads', () => {
  const media = canvas('https://provider-a.example/output/图片.png');
  const files = [file('https://provider-b.example/output/图片.png')];
  assert.equal(mergeCanvasMediaFiles(media, files)[0].artifactId, undefined);
  assert.equal(mergeCanvasMediaFiles(media, files)[0].url, media.nodes[0].data.outputs.imageUrl);
  assert.equal(linkOutputFilesToCanvas(media, files)[0].nodeId, undefined);
});

test('exact local URLs match relative and absolute Unicode paths, not reserved slash aliases', () => {
  assert.equal(mergeCanvasMediaFiles(canvas('/output/图片.png'), [file('http://localhost:5190/output/%E5%9B%BE%E7%89%87.png')])[0].artifactId, 'opaque');
  assert.equal(mergeCanvasMediaFiles(canvas('/output/a%2Fb.png'), [file('/output/a/b.png')])[0].artifactId, undefined);
});

test('protocol-relative, backslash, credential and executable URLs are not local downloads', () => {
  for (const url of ['//foreign.example/file.mp4', '/\\foreign.example/file.mp4', 'http://user:secret@localhost:5190/file', 'javascript:alert(1)', 'data:text/html,unsafe', 'blob:https://foreign.example/id']) {
    assert.equal(isLocallyDownloadableUrl(url), false, url);
  }
  for (const url of ['/api/files/download/opaque', 'http://localhost:5190/output/video.mp4', 'blob:http://localhost:5190/id', 'data:image/png;base64,eA==']) {
    assert.equal(isLocallyDownloadableUrl(url), true, url);
  }
});
