import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type NodeTypes,
} from '@xyflow/react';
import { Bot, Image, Maximize2, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddNodePanel } from './components/AddNodePanel';
import { LeftRail, type RailPanelId } from './components/LeftRail';
import { RailPanels } from './components/RailPanels';
import { TopBar } from './components/TopBar';
import { StudioNodeCard } from './nodes/StudioNodeCard';
import { useCanvasStore } from './store/canvasStore';
import type { StudioEdge, StudioNode } from './types';

const MIN_ZOOM = 0.18;
const MAX_ZOOM = 2.2;
const SNAP_GRID: [number, number] = [24, 24];

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function normalizedZoomPercent(zoom: number) {
  const percent = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function CanvasWorkspace() {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const addPanelOpen = useCanvasStore((state) => state.addPanelOpen);
  const quickPanelOpen = useCanvasStore((state) => state.quickPanelOpen);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const addNode = useCanvasStore((state) => state.addNode);
  const setQuickPanelOpen = useCanvasStore((state) => state.setQuickPanelOpen);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const [gridAlignEnabled, setGridAlignEnabled] = useState(false);
  const [activeRailPanel, setActiveRailPanel] = useState<RailPanelId | null>(null);
  const { zoom } = useViewport();
  const { fitView, screenToFlowPosition, zoomTo } = useReactFlow<StudioNode, StudioEdge>();

  const nodeTypes = useMemo<NodeTypes>(() => ({ studioNode: StudioNodeCard }), []);
  const zoomPercent = normalizedZoomPercent(zoom);
  const fitOptions = useMemo(() => ({ padding: 0.22, duration: 420 }), []);

  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.detail !== 2) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode('text', position);
    },
    [addNode, screenToFlowPosition],
  );

  const fitCanvas = useCallback(() => {
    void fitView(fitOptions);
  }, [fitOptions, fitView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'm') {
        event.preventDefault();
        setMinimapVisible((current) => !current);
      }
      if (key === 'l') {
        event.preventDefault();
        setGridAlignEnabled((current) => !current);
      }
      if (key === 'f') {
        event.preventDefault();
        fitCanvas();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fitCanvas]);

  const handleZoomSlider = useCallback(
    (value: number) => {
      const nextZoom = MIN_ZOOM + (value / 100) * (MAX_ZOOM - MIN_ZOOM);
      void zoomTo(nextZoom, { duration: 140 });
    },
    [zoomTo],
  );

  return (
    <main className="studio-shell">
      <TopBar />
      <LeftRail activePanel={activeRailPanel} onPanelChange={setActiveRailPanel} />
      {addPanelOpen && (
        <section className="floating-panel add-panel-wrap">
          <AddNodePanel />
        </section>
      )}
      <RailPanels activePanel={activeRailPanel} onPanelChange={setActiveRailPanel} />
      <section className="canvas-stage">
        <ReactFlow<StudioNode, StudioEdge>
          key={activeCanvas.id}
          nodes={activeCanvas.nodes}
          edges={activeCanvas.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={handlePaneClick}
          onMoveEnd={(_, viewport) => setViewport(viewport)}
          defaultViewport={activeCanvas.viewport}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          snapToGrid={gridAlignEnabled}
          snapGrid={SNAP_GRID}
          connectionLineType={ConnectionLineType.SmoothStep}
          proOptions={{ hideAttribution: true }}
          fitViewOptions={{ padding: 0.18 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={34} size={1.15} color="rgba(154, 168, 220, 0.18)" />
          {minimapVisible && (
            <MiniMap
              className="studio-minimap"
              pannable
              zoomable
              nodeBorderRadius={7}
              nodeStrokeWidth={3}
              maskStrokeColor="rgba(255,255,255,0.42)"
              maskStrokeWidth={2}
              nodeColor={(node) => {
                const kind = node.data?.kind;
                if (kind === 'image') return '#5576ff';
                if (kind === 'video') return '#70e1c8';
                if (kind === 'audio') return '#f3bf6a';
                if (kind === 'stage3d' || kind === 'panorama') return '#7a65e8';
                if (kind === 'storyboard' || kind === 'collage') return '#9fa8c8';
                if (kind === 'asset') return '#f3bf6a';
                if (kind === 'upload') return '#70e1c8';
                return '#a98bff';
              }}
            />
          )}
        </ReactFlow>
      </section>

      <div className="canvas-controls">
        <button
          className={`control-circle ${minimapVisible ? 'is-active' : ''}`}
          type="button"
          onClick={() => setMinimapVisible((current) => !current)}
          data-tooltip="开启/关闭小地图 (M)"
          aria-pressed={minimapVisible}
          aria-label="开启/关闭小地图"
        >
          <Image size={24} />
        </button>
        <button
          className={`control-circle ${gridAlignEnabled ? 'is-active' : ''}`}
          type="button"
          onClick={() => setGridAlignEnabled((current) => !current)}
          data-tooltip="开启/关闭网格对齐 (L)"
          aria-pressed={gridAlignEnabled}
          aria-label="开启/关闭网格对齐"
        >
          <span className="dot-grid" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, index) => (
              <i key={index} />
            ))}
          </span>
        </button>
        <button
          className="control-circle"
          type="button"
          onClick={fitCanvas}
          data-tooltip="适应画布 (F)"
          aria-label="适应画布"
        >
          <Maximize2 size={25} />
        </button>
        <div className="control-divider" />
        <div className="zoom-slider-wrap" aria-label="缩放控制">
          <input
            className="zoom-slider"
            type="range"
            min="0"
            max="100"
            value={zoomPercent}
            onChange={(event) => handleZoomSlider(Number(event.currentTarget.value))}
            aria-label="缩放百分比"
          />
          <span>{zoomPercent}%</span>
        </div>
      </div>

      <button
        className="orb-generate"
        type="button"
        onClick={() => setQuickPanelOpen(!quickPanelOpen)}
        title="快捷生成"
      >
        <Sparkles size={27} />
      </button>

      {quickPanelOpen && (
        <section className="floating-panel quick-panel">
          <div>
            <span className="panel-kicker">快捷生成</span>
            <h2>选择一个节点开始</h2>
            <p>生成会提交到本地任务队列，由 Sub2API 或 AnyCap 后台执行。</p>
          </div>
          <AddNodePanel compact />
          <div className="quick-panel-note">
            <Bot size={15} />
            后台不可用时，节点会显示明确错误。
          </div>
        </section>
      )}
    </main>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  );
}
