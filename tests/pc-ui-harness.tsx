// DEV-only UI fixture: never bootstraps the project or submits generation jobs.
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { GenerationComposer } from '../src/components/GenerationComposer';
import { useCanvasStore } from '../src/store/canvasStore';
import type { NodeKind, StudioNode } from '../src/types';
import '@xyflow/react/dist/style.css';
import '../src/styles.css';

if (!import.meta.env.DEV) throw new Error('This fixture is available in development only.');
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && !url.includes('/api/providers/anycap/capabilities')) {
    return Promise.resolve(new Response(JSON.stringify({ error: 'UI fixture blocks all writes and generation.' }), { status: 403 }));
  }
  return originalFetch(input, init);
};

function selectFixture(kind: NodeKind) {
  const model = kind === 'audio' ? 'doubao-seed-audio-1-0' : kind === 'image' ? 'gpt-image-2' : 'seedance-2.5';
  const node: StudioNode = {
    id: 'ui-fixture', type: 'studioNode', position: { x: 400, y: 72 }, width: 320, height: 160,
    data: { kind, title: 'UI 验证节点', prompt: '清晨的海边，镜头缓缓推进，阳光落在波纹上。', model, provider: 'AnyCap', status: 'idle', progress: 0, inputs: [], outputs: {}, references: [], providerOptions: { model, providerTool: 'anycap' } },
  };
  const base = useCanvasStore.getState();
  const canvas = { ...base.activeCanvas, id: 'ui-fixture-canvas', name: '隔离测试', nodes: [node], edges: [], groups: [] };
  useCanvasStore.setState({
    activeCanvas: canvas, project: { ...base.project, canvases: [canvas], activeCanvasId: canvas.id },
    selectedNodeId: node.id, selectedNodeIds: [node.id],
    updateNodeData: (id, patch) => useCanvasStore.setState((state) => ({ activeCanvas: { ...state.activeCanvas, nodes: state.activeCanvas.nodes.map((item) => item.id === id ? { ...item, data: { ...item.data, ...patch } } : item) } })),
    runNode: async () => { throw new Error('Generation is disabled in this test fixture.'); },
  });
}
selectFixture('video');
function Fixture() {
  return <ReactFlowProvider><main className="studio-shell">
    <nav style={{ position: 'fixed', left: 24, top: 20, zIndex: 999, display: 'flex', gap: 16, alignItems: 'center' }}>
      <strong>隔离 UI 验证 · 不保存、不生成</strong>
      {(['video', 'audio', 'image'] as const).map((kind) => <button key={kind} type="button" onClick={() => selectFixture(kind)} style={{ padding: '8px 16px', border: '1px solid #667', borderRadius: 10 }}>测试{kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}</button>)}
    </nav>
    <div className="react-flow__node" data-id="ui-fixture" style={{ position: 'fixed', left: 440, top: 85, width: 320, height: 160, border: '1px solid #52619c', borderRadius: 20, background: '#171b25', display: 'grid', placeItems: 'center' }}>当前模型参数预览</div>
    <GenerationComposer />
  </main></ReactFlowProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
