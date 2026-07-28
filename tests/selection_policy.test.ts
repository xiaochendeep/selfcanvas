import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasNewerDurablePendingProject,
  projectsHaveSameDurableContent,
} from '../src/services/projectSyncPolicy.ts';
import { generationSyncError, isMissingCanvasNodeError } from '../src/services/generationRunPolicy.ts';
import { persistentEdgeChanges, persistentNodeChanges } from '../src/store/nodeChangePolicy.ts';
import type { StudioProject } from '../src/types.ts';

function projectFixture(): StudioProject {
  return {
    id: 'project-1',
    name: '测试项目',
    activeCanvasId: 'canvas-1',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    canvases: [
      {
        id: 'canvas-1',
        name: '画布 1',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        viewport: { x: 0, y: 0, zoom: 1 },
        edges: [{ id: 'edge-1', source: 'node-1', target: 'node-1', selected: false }],
        groups: [],
        nodes: [
          {
            id: 'node-1',
            type: 'studioNode',
            position: { x: 10, y: 20 },
            selected: false,
            data: {
              kind: 'image',
              title: '图片',
              prompt: '测试提示词',
              status: 'idle',
              progress: 0,
              provider: 'Sub2API',
              model: 'gpt-image-2',
              inputs: [],
              outputs: {},
              references: [],
              providerOptions: {},
              error: '',
            },
          },
        ],
      },
    ],
  };
}

test('React Flow selection changes are excluded from project persistence', () => {
  const changes = [
    { id: 'node-1', type: 'select', selected: true },
    { id: 'node-1', type: 'position', position: { x: 30, y: 40 }, dragging: false },
  ] as Parameters<typeof persistentNodeChanges>[0];

  assert.deepEqual(persistentNodeChanges(changes), [changes[1]]);
  assert.deepEqual(persistentNodeChanges([changes[0]]), []);

  const edgeSelection = [{ id: 'edge-1', type: 'select', selected: true }] as Parameters<typeof persistentEdgeChanges>[0];
  assert.deepEqual(persistentEdgeChanges(edgeSelection), []);
});

test('selection-only legacy divergence is safe to reconcile', () => {
  const remote = projectFixture();
  const local = structuredClone(remote);
  local.updatedAt = '2026-07-13T00:01:00.000Z';
  local.canvases[0].updatedAt = local.updatedAt;
  local.canvases[0].nodes[0].selected = true;
  local.canvases[0].nodes[0].dragging = true;
  local.canvases[0].nodes[0].measured = { width: 300, height: 240 };
  local.canvases[0].edges[0].selected = true;

  assert.equal(projectsHaveSameDurableContent(local, remote), true);
});

test('real canvas or prompt edits remain conflicts', () => {
  const remote = projectFixture();
  const moved = structuredClone(remote);
  moved.canvases[0].nodes[0].position.x += 1;
  assert.equal(projectsHaveSameDurableContent(moved, remote), false);

  const edited = structuredClone(remote);
  edited.canvases[0].nodes[0].data.prompt = '真实修改';
  assert.equal(projectsHaveSameDurableContent(edited, remote), false);
});

test('an edit created while a save is in flight is kept after an equivalent 409', () => {
  const sent = projectFixture();
  const selectionOnlyPending = structuredClone(sent);
  selectionOnlyPending.canvases[0].nodes[0].selected = true;
  assert.equal(hasNewerDurablePendingProject(selectionOnlyPending, sent), false);

  const newerPending = structuredClone(sent);
  newerPending.canvases[0].nodes[0].data.prompt = '请求在途时继续编辑';
  assert.equal(hasNewerDurablePendingProject(newerPending, sent), true);
});

test('generation only proceeds after the node is durably synced', () => {
  assert.equal(generationSyncError('synced'), '');
  assert.match(generationSyncError('offline'), /未同步/);
  assert.match(generationSyncError('conflict'), /同步冲突/);
  assert.equal(isMissingCanvasNodeError(new Error('节点不存在')), true);
  assert.equal(isMissingCanvasNodeError(new Error('供应商暂时不可用')), false);
});
