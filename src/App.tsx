import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useViewport,
  type Connection,
  type ConnectionLineComponentProps,
  type OnConnectEnd,
  type OnConnectStart,
  type OnSelectionChangeFunc,
  type NodeTypes,
  type XYPosition,
} from '@xyflow/react';
import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BellRing,
  Boxes,
  Grid2X2,
  Image,
  Maximize2,
  Minus,
  Palette,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { AddNodePanel } from './components/AddNodePanel';
import { ConnectionCreateMenu } from './components/ConnectionCreateMenu';
import { GenerationComposer } from './components/GenerationComposer';
import { LeftRail, type RailPanelId } from './components/LeftRail';
import { QuickChatPanel } from './components/QuickChatPanel';
import { RailPanels } from './components/RailPanels';
import { TopBar } from './components/TopBar';
import { StudioNodeCard } from './nodes/StudioNodeCard';
import { COMPLETION_NOTICE_EVENT, type CompletionNoticeDetail } from './services/completionNotifier';
import { classifyMediaFile, mediaFileAccept, uploadMediaFile } from './services/mediaImportClient';
import { useCanvasStore, type NodeAlignment } from './store/canvasStore';
import { useSettingsStore } from './store/settingsStore';
import type { CanvasGroup, ImportedMedia, ImportedMediaType, NodeKind, NodeOutput, StudioEdge, StudioNode } from './types';

const MIN_ZOOM = 0.18;
const MAX_ZOOM = 2.2;
const SNAP_GRID: [number, number] = [24, 24];
const MEDIA_IMPORT_CONCURRENCY = 3;
const MEDIA_IMPORT_CELL_WIDTH = 364;
const MEDIA_IMPORT_CELL_HEIGHT = 284;

interface ImportNotice {
  message: string;
  tone: 'info' | 'success' | 'error';
}

interface MediaImportJob {
  file: File;
  type: ImportedMediaType;
  nodeId: string;
}

interface AlignmentGuideState {
  nodeId: string;
  x?: number;
  y?: number;
  position: XYPosition;
}

interface ConnectionMenuState {
  mode: 'input' | 'output';
  anchorNodeId?: string;
  sourceGroupId?: string;
  anchorKind: NodeKind;
  referenceNodeIds: string[];
  x: number;
  y: number;
  flowPosition: XYPosition;
}

interface ConnectionStartState {
  nodeId: string;
  mode: 'input' | 'output' | null;
  referenceNodeIds: string[];
}

interface GroupConnectionDragState {
  sourceGroupId?: string;
  anchorKind: NodeKind;
  referenceNodeIds: string[];
  startX: number;
  startY: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  moved: boolean;
}

const GROUP_COLORS = ['#6d63ff', '#ffffff', '#2f80ff', '#19c38d', '#12b8d7', '#8b5cf6', '#ef4444', '#facc15'];

const importedMediaLabels: Record<ImportedMediaType, string> = {
  image: '图片素材',
  video: '视频素材',
  audio: '音频素材',
};

function hasExternalFiles(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function importedMediaOutputs(media: ImportedMedia): NodeOutput {
  const outputs: NodeOutput = {
    assetName: media.name,
    fileUrl: media.url,
    text: `${importedMediaLabels[media.type]} · ${formatFileSize(media.size)}`,
  };
  if (media.type === 'image') outputs.imageUrl = media.url;
  if (media.type === 'video') outputs.videoUrl = media.url;
  if (media.type === 'audio') outputs.audioUrl = media.url;
  return outputs;
}

function importedMediaPositions(anchor: XYPosition, count: number) {
  const columns = Math.max(1, Math.min(3, count));
  const startX = anchor.x - ((columns - 1) * MEDIA_IMPORT_CELL_WIDTH) / 2 - 170;
  const startY = anchor.y - 90;
  return Array.from({ length: count }, (_, index) => ({
    x: startX + (index % columns) * MEDIA_IMPORT_CELL_WIDTH,
    y: startY + Math.floor(index / columns) * MEDIA_IMPORT_CELL_HEIGHT,
  }));
}

function measuredNodeSize(node: StudioNode) {
  return {
    width: node.measured?.width ?? node.width ?? 300,
    height: node.measured?.height ?? node.height ?? 240,
  };
}

function alignmentSnapForNode(node: StudioNode, nodes: StudioNode[], zoom: number): AlignmentGuideState | null {
  const size = measuredNodeSize(node);
  const threshold = 10 / Math.max(zoom, 0.1);
  const movingX = [node.position.x, node.position.x + size.width / 2, node.position.x + size.width];
  const movingY = [node.position.y, node.position.y + size.height / 2, node.position.y + size.height];
  let bestXDelta: number | undefined;
  let bestXLine: number | undefined;
  let bestYDelta: number | undefined;
  let bestYLine: number | undefined;

  nodes.forEach((candidate) => {
    if (candidate.id === node.id) return;
    const candidateSize = measuredNodeSize(candidate);
    const targetX = [candidate.position.x, candidate.position.x + candidateSize.width / 2, candidate.position.x + candidateSize.width];
    const targetY = [candidate.position.y, candidate.position.y + candidateSize.height / 2, candidate.position.y + candidateSize.height];
    movingX.forEach((movingPoint) => {
      targetX.forEach((targetPoint) => {
        const delta = targetPoint - movingPoint;
        if (Math.abs(delta) <= threshold && (bestXDelta === undefined || Math.abs(delta) < Math.abs(bestXDelta))) {
          bestXDelta = delta;
          bestXLine = targetPoint;
        }
      });
    });
    movingY.forEach((movingPoint) => {
      targetY.forEach((targetPoint) => {
        const delta = targetPoint - movingPoint;
        if (Math.abs(delta) <= threshold && (bestYDelta === undefined || Math.abs(delta) < Math.abs(bestYDelta))) {
          bestYDelta = delta;
          bestYLine = targetPoint;
        }
      });
    });
  });

  if (bestXDelta === undefined && bestYDelta === undefined) return null;
  return {
    nodeId: node.id,
    x: bestXLine,
    y: bestYLine,
    position: {
      x: node.position.x + (bestXDelta ?? 0),
      y: node.position.y + (bestYDelta ?? 0),
    },
  };
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

function FloatingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
}: ConnectionLineComponentProps<StudioNode>) {
  const shouldLeaveLeft = fromPosition === Position.Left;
  const curve = Math.max(44, Math.min(160, Math.abs(toX - fromX) * 0.45));
  const controlOffset = shouldLeaveLeft ? -curve : curve;
  const path = `M ${fromX},${fromY} C ${fromX + controlOffset},${fromY} ${toX - controlOffset},${toY} ${toX},${toY}`;
  return (
    <g className={`floating-connection-line ${shouldLeaveLeft ? 'is-input-line' : 'is-output-line'}`}>
      <path d={path} />
      <circle cx={fromX} cy={fromY} r="4.5" />
    </g>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function isComposerProtectedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '.left-rail, .add-panel-wrap, .add-node-menu, .quick-panel, .studio-node, .generation-composer, .mention-popover, .model-picker-popover, .connection-create-menu, .reference-group-overlay, .canvas-group-overlay, .canvas-group-toolbar, .group-color-popover, .react-flow__edge, .group-connection-layer',
    ),
  );
}

function isAddPanelHoverTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('.rail-button-primary, .add-panel-wrap'));
}

function normalizedZoomPercent(zoom: number) {
  const percent = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function pointerFromConnectionEvent(event: MouseEvent | TouchEvent) {
  if ('changedTouches' in event && event.changedTouches.length > 0) {
    return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
  }
  if ('touches' in event && event.touches.length > 0) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

function clampMenuPosition(x: number, y: number) {
  const width = 260;
  const height = 292;
  return {
    x: Math.max(96, Math.min(x + 18, window.innerWidth - width - 20)),
    y: Math.max(76, Math.min(y - 22, window.innerHeight - height - 20)),
  };
}

function connectionModeFromEvent(event: Parameters<OnConnectStart>[0], handleType: 'source' | 'target' | null | undefined) {
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.closest('.node-handle-hotspot-in, .node-handle-in')) return 'input';
    if (target.closest('.node-handle-hotspot-out, .node-handle-out')) return 'output';
  }
  return handleType === 'target' ? 'input' : 'output';
}

function isGroupEdge(edge: StudioEdge) {
  return typeof edge.data?.sourceGroupId === 'string';
}

function SelectionReferenceHint() {
  const count = useCanvasStore((state) => state.referenceSelectionIds.length);
  if (count < 2) return null;
  return (
    <div className="selection-reference-hint">
      <strong>已圈选 {count} 个素材</strong>
      <span>点击目标节点，或从节点拖线创建下一个生成节点</span>
    </div>
  );
}

function MultiAlignToolbar({
  count,
  spacing,
  onAlign,
}: {
  count: number;
  spacing: number;
  onAlign: (alignment: NodeAlignment) => void;
}) {
  const controls: Array<{ alignment: NodeAlignment; label: string; icon: ReactNode }> = [
    { alignment: 'left', label: '左对齐', icon: <AlignHorizontalJustifyStart size={18} /> },
    { alignment: 'center-x', label: '水平居中', icon: <AlignHorizontalJustifyCenter size={18} /> },
    { alignment: 'right', label: '右对齐', icon: <AlignHorizontalJustifyEnd size={18} /> },
    { alignment: 'top', label: '顶对齐', icon: <AlignVerticalJustifyStart size={18} /> },
    { alignment: 'center-y', label: '垂直居中', icon: <AlignVerticalJustifyCenter size={18} /> },
    { alignment: 'bottom', label: '底对齐', icon: <AlignVerticalJustifyEnd size={18} /> },
    { alignment: 'distribute-x', label: `横向分布 · ${spacing}px`, icon: <AlignHorizontalDistributeCenter size={18} /> },
    { alignment: 'distribute-y', label: `纵向分布 · ${spacing}px`, icon: <AlignVerticalDistributeCenter size={18} /> },
  ];

  return (
    <div className="multi-align-toolbar" role="toolbar" aria-label={`对齐 ${count} 个节点`}>
      <span>{count} 个节点</span>
      {controls.map((control) => (
        <button
          key={control.alignment}
          type="button"
          title={control.label}
          aria-label={control.label}
          onClick={() => onAlign(control.alignment)}
        >
          {control.icon}
        </button>
      ))}
    </div>
  );
}

function referenceGroupBounds(nodes: StudioNode[], nodeIds: string[], viewport: { x: number; y: number; zoom: number }) {
  if (nodeIds.length < 2) return null;
  const idSet = new Set(nodeIds);
  const groupNodes = nodes.filter((node) => idSet.has(node.id));
  if (groupNodes.length < 2) return null;
  const minX = Math.min(...groupNodes.map((node) => node.position.x));
  const minY = Math.min(...groupNodes.map((node) => node.position.y));
  const maxX = Math.max(...groupNodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? 300)));
  const maxY = Math.max(...groupNodes.map((node) => node.position.y + (node.measured?.height ?? node.height ?? 240)));
  const padding = 14;
  return {
    anchorKind: groupNodes[0].data.kind,
    left: viewport.x + minX * viewport.zoom - padding,
    top: viewport.y + minY * viewport.zoom - padding,
    width: (maxX - minX) * viewport.zoom + padding * 2,
    height: (maxY - minY) * viewport.zoom + padding * 2,
  };
}

function groupScreenBounds(group: CanvasGroup, viewport: { x: number; y: number; zoom: number }) {
  return {
    left: viewport.x + group.bounds.x * viewport.zoom,
    top: viewport.y + group.bounds.y * viewport.zoom,
    width: group.bounds.width * viewport.zoom,
    height: group.bounds.height * viewport.zoom,
  };
}

function nodeScreenPoint(node: StudioNode, viewport: { x: number; y: number; zoom: number }) {
  const height = node.measured?.height ?? node.height ?? 240;
  return {
    x: viewport.x + node.position.x * viewport.zoom,
    y: viewport.y + (node.position.y + height / 2) * viewport.zoom,
  };
}

function nodeAtScreenPoint(
  nodes: StudioNode[],
  viewport: { x: number; y: number; zoom: number },
  point: { x: number; y: number },
  excludeIds: string[] = [],
) {
  const excluded = new Set(excludeIds);
  const flowPoint = {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (excluded.has(node.id)) continue;
    const width = node.measured?.width ?? node.width ?? 300;
    const height = node.measured?.height ?? node.height ?? 240;
    const insideX = flowPoint.x >= node.position.x && flowPoint.x <= node.position.x + width;
    const insideY = flowPoint.y >= node.position.y && flowPoint.y <= node.position.y + height;
    if (insideX && insideY) return node;
  }
  return null;
}

function GroupConnectionLines({
  edges,
  groups,
  nodes,
  viewport,
  selectedEdgeId,
  onSelectEdge,
  onRemoveEdge,
}: {
  edges: StudioEdge[];
  groups: CanvasGroup[];
  nodes: StudioNode[];
  viewport: { x: number; y: number; zoom: number };
  selectedEdgeId: string;
  onSelectEdge: (edgeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
}) {
  if (!edges.length) return null;
  return (
    <svg className="group-connection-layer" aria-hidden="true">
      {edges.map((edge) => {
        const groupId = String(edge.data?.sourceGroupId ?? '');
        const group = groups.find((item) => item.id === groupId);
        const target = nodes.find((node) => node.id === edge.target);
        if (!group || !target) return null;
        const bounds = groupScreenBounds(group, viewport);
        const from = { x: bounds.left + bounds.width, y: bounds.top + bounds.height / 2 };
        const to = nodeScreenPoint(target, viewport);
        const curve = Math.max(56, Math.min(180, Math.abs(to.x - from.x) * 0.42));
        const path = `M ${from.x},${from.y} C ${from.x + curve},${from.y} ${to.x - curve},${to.y} ${to.x},${to.y}`;
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 18 };
        const selected = selectedEdgeId === edge.id;
        return (
          <g className={`group-edge ${selected ? 'is-selected' : ''}`} key={edge.id}>
            <path
              className={selected ? 'is-selected' : ''}
              d={path}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />
            {selected && (
              <g
                className="group-edge-delete"
                transform={`translate(${mid.x} ${mid.y})`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveEdge(edge.id);
                }}
              >
                <circle r="13" />
                <path d="M -5 -5 L 5 5 M 5 -5 L -5 5" />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function CanvasWorkspace() {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const addPanelOpen = useCanvasStore((state) => state.addPanelOpen);
  const quickPanelOpen = useCanvasStore((state) => state.quickPanelOpen);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const setNodePositions = useCanvasStore((state) => state.setNodePositions);
  const alignSelectedNodes = useCanvasStore((state) => state.alignSelectedNodes);
  const saveNow = useCanvasStore((state) => state.saveNow);
  const addNode = useCanvasStore((state) => state.addNode);
  const createImportedMediaNode = useCanvasStore((state) => state.createImportedMediaNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setAddPanelOpen = useCanvasStore((state) => state.setAddPanelOpen);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const focusNodeAsTarget = useCanvasStore((state) => state.focusNodeAsTarget);
  const setSelectedNodes = useCanvasStore((state) => state.setSelectedNodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const selectedGroupId = useCanvasStore((state) => state.selectedGroupId);
  const selectGroup = useCanvasStore((state) => state.selectGroup);
  const createGroupFromSelection = useCanvasStore((state) => state.createGroupFromSelection);
  const ungroupGroup = useCanvasStore((state) => state.ungroupGroup);
  const updateGroupColor = useCanvasStore((state) => state.updateGroupColor);
  const attachReferencesToNode = useCanvasStore((state) => state.attachReferencesToNode);
  const attachGroupReferencesToNode = useCanvasStore((state) => state.attachGroupReferencesToNode);
  const connectSourceNodesToTarget = useCanvasStore((state) => state.connectSourceNodesToTarget);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const createInputNode = useCanvasStore((state) => state.createInputNode);
  const createReferencedNode = useCanvasStore((state) => state.createReferencedNode);
  const createReferencedNodeFromGroup = useCanvasStore((state) => state.createReferencedNodeFromGroup);
  const referenceSelectionIds = useCanvasStore((state) => state.referenceSelectionIds);
  const setQuickPanelOpen = useCanvasStore((state) => state.setQuickPanelOpen);
  const settings = useSettingsStore((state) => state.settings);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const [gridAlignEnabled, setGridAlignEnabled] = useState(false);
  const [activeRailPanel, setActiveRailPanel] = useState<RailPanelId | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenuState | null>(null);
  const [colorPickerGroupId, setColorPickerGroupId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [fileDragActive, setFileDragActive] = useState(false);
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [alignmentGuide, setAlignmentGuide] = useState<AlignmentGuideState | null>(null);
  const [alignHoldActive, setAlignHoldActive] = useState(false);
  const [completionNotice, setCompletionNotice] = useState<CompletionNoticeDetail | null>(null);
  const connectionStartRef = useRef<ConnectionStartState>({ nodeId: '', mode: null, referenceNodeIds: [] });
  const groupConnectionDragRef = useRef<GroupConnectionDragState | null>(null);
  const addPanelCloseTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileDragDepthRef = useRef(0);
  const importNoticeTimerRef = useRef<number | null>(null);
  const [groupConnectionDrag, setGroupConnectionDrag] = useState<GroupConnectionDragState | null>(null);
  const viewport = useViewport();
  const { zoom } = viewport;
  const { fitView, screenToFlowPosition, zoomIn, zoomOut, zoomTo } = useReactFlow<StudioNode, StudioEdge>();

  const nodeTypes = useMemo<NodeTypes>(() => ({ studioNode: StudioNodeCard }), []);
  const zoomPercent = normalizedZoomPercent(zoom);
  const fitOptions = useMemo(() => ({ padding: 0.22, duration: 420 }), []);
  const snapToGrid = gridAlignEnabled || settings.gridSnap;
  const groupBounds = useMemo(
    () => referenceGroupBounds(activeCanvas.nodes, referenceSelectionIds, viewport),
    [activeCanvas.nodes, referenceSelectionIds, viewport],
  );
  const visibleEdges = useMemo(
    () => activeCanvas.edges.filter((edge) => !isGroupEdge(edge)),
    [activeCanvas.edges],
  );
  const relatedEdgeIds = useMemo(() => {
    if (!settings.highlightConnections || !selectedNodeId) return new Set<string>();
    return new Set(
      visibleEdges
        .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
        .map((edge) => edge.id),
    );
  }, [selectedNodeId, settings.highlightConnections, visibleEdges]);
  const relatedNodeIds = useMemo(() => {
    if (!relatedEdgeIds.size) return new Set<string>();
    const ids = new Set<string>();
    visibleEdges.forEach((edge) => {
      if (!relatedEdgeIds.has(edge.id)) return;
      ids.add(edge.source);
      ids.add(edge.target);
    });
    ids.delete(selectedNodeId);
    return ids;
  }, [relatedEdgeIds, selectedNodeId, visibleEdges]);
  const displayNodes = useMemo(
    () => activeCanvas.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        uiRelation: relatedNodeIds.has(node.id)
          ? ('related' as const)
          : relatedEdgeIds.size && node.id !== selectedNodeId
            ? ('dimmed' as const)
            : undefined,
      },
    })),
    [activeCanvas.nodes, relatedEdgeIds.size, relatedNodeIds, selectedNodeId],
  );
  const displayEdges = useMemo(
    () => visibleEdges.map((edge) => ({
      ...edge,
      className: relatedEdgeIds.has(edge.id)
        ? 'is-related'
        : relatedEdgeIds.size
          ? 'is-dimmed'
          : undefined,
    })),
    [relatedEdgeIds, visibleEdges],
  );
  const groupEdges = useMemo(
    () => activeCanvas.edges.filter(isGroupEdge),
    [activeCanvas.edges],
  );

  const showImportNotice = useCallback((message: string, tone: ImportNotice['tone']) => {
    if (importNoticeTimerRef.current !== null) window.clearTimeout(importNoticeTimerRef.current);
    setImportNotice({ message, tone });
    importNoticeTimerRef.current = window.setTimeout(() => {
      importNoticeTimerRef.current = null;
      setImportNotice(null);
    }, 4600);
  }, []);

  useEffect(
    () => () => {
      if (importNoticeTimerRef.current !== null) window.clearTimeout(importNoticeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const clearFileDragState = () => {
      fileDragDepthRef.current = 0;
      setFileDragActive(false);
    };

    window.addEventListener('dragend', clearFileDragState);
    window.addEventListener('blur', clearFileDragState);
    return () => {
      window.removeEventListener('dragend', clearFileDragState);
      window.removeEventListener('blur', clearFileDragState);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  useEffect(() => {
    let dismissTimer: number | null = null;
    const handleCompletion = (event: Event) => {
      const detail = (event as CustomEvent<CompletionNoticeDetail>).detail;
      if (!detail) return;
      setCompletionNotice(detail);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => setCompletionNotice(null), 5200);
    };
    window.addEventListener(COMPLETION_NOTICE_EVENT, handleCompletion);
    return () => {
      window.removeEventListener(COMPLETION_NOTICE_EVENT, handleCompletion);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    };
  }, []);

  const importMediaFiles = useCallback(
    async (files: File[], anchor: XYPosition) => {
      if (!files.length) {
        showImportNotice('没有发现可导入的媒体文件。暂不支持递归导入整个文件夹。', 'error');
        return;
      }

      const accepted = files.flatMap((file) => {
        const type = classifyMediaFile(file);
        return type && file.size > 0 ? [{ file, type }] : [];
      });
      const skippedCount = files.length - accepted.length;
      if (!accepted.length) {
        showImportNotice('仅支持图片、视频和音频文件，且文件内容不能为空。', 'error');
        return;
      }

      setAddPanelOpen(false);
      setQuickPanelOpen(false);
      const positions = importedMediaPositions(anchor, accepted.length);
      const jobs: MediaImportJob[] = accepted.map(({ file, type }, index) => ({
        file,
        type,
        nodeId: createImportedMediaNode(
          {
            name: file.name,
            type,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          },
          positions[index],
        ),
      }));

      showImportNotice(`正在导入 ${jobs.length} 个媒体文件…`, 'info');
      let succeeded = 0;
      let failed = 0;
      await runWithConcurrency(jobs, MEDIA_IMPORT_CONCURRENCY, async ({ file, nodeId }) => {
        let lastProgress = 0;
        try {
          const media = await uploadMediaFile(file, (progress) => {
            if (progress < 99 && progress - lastProgress < 2) return;
            lastProgress = progress;
            updateNodeData(nodeId, { progress });
          });
          updateNodeData(nodeId, {
            status: 'success',
            progress: 100,
            importedMedia: media,
            outputs: importedMediaOutputs(media),
            error: '',
          });
          succeeded += 1;
        } catch (error) {
          failed += 1;
          updateNodeData(nodeId, {
            status: 'error',
            progress: 0,
            outputs: {
              assetName: file.name,
              text: '文件未能复制到项目目录。',
            },
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      const summary = [
        succeeded ? `成功导入 ${succeeded} 个` : '',
        failed ? `${failed} 个失败` : '',
        skippedCount ? `跳过 ${skippedCount} 个不支持的文件` : '',
      ].filter(Boolean).join('，');
      showImportNotice(summary || '媒体导入完成。', failed ? (succeeded ? 'info' : 'error') : 'success');
    },
    [createImportedMediaNode, setAddPanelOpen, setQuickPanelOpen, showImportNotice, updateNodeData],
  );

  const requestMediaImport = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      const anchor = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      void importMediaFiles(files, anchor);
    },
    [importMediaFiles, screenToFlowPosition],
  );

  const handleFileDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setFileDragActive(true);
  }, []);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  }, []);

  const handleFileDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current = 0;
      setFileDragActive(false);
      const anchor = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void importMediaFiles(Array.from(event.dataTransfer.files), anchor);
    },
    [importMediaFiles, screenToFlowPosition],
  );

  const handleNodeDrag = useCallback(
    (node: StudioNode) => {
      if (!settings.guideSnap) {
        setAlignmentGuide(null);
        return;
      }
      setAlignmentGuide(alignmentSnapForNode(node, activeCanvas.nodes, zoom));
    },
    [activeCanvas.nodes, settings.guideSnap, zoom],
  );

  const handleNodeDragStop = useCallback(
    (node: StudioNode) => {
      const snap = settings.guideSnap ? alignmentSnapForNode(node, activeCanvas.nodes, zoom) : null;
      if (snap) setNodePositions([{ id: node.id, position: snap.position }]);
      setAlignmentGuide(null);
    },
    [activeCanvas.nodes, setNodePositions, settings.guideSnap, zoom],
  );

  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.detail !== 2) {
        selectNode('');
        setConnectionMenu(null);
        setSelectedEdgeId('');
        return;
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode('text', position);
    },
    [addNode, screenToFlowPosition, selectNode],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: StudioNode) => {
      focusNodeAsTarget(node.id);
      setConnectionMenu(null);
      setSelectedEdgeId('');
      setQuickPanelOpen(false);
    },
    [focusNodeAsTarget, setQuickPanelOpen],
  );

  const handleSelectionChange = useCallback<OnSelectionChangeFunc<StudioNode, StudioEdge>>(
    ({ nodes }) => {
      setSelectedNodes(nodes.map((node) => node.id));
    },
    [setSelectedNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const start = connectionStartRef.current;
      const startNodeId = start.nodeId;
      const otherNodeId =
        connection.source === startNodeId
          ? connection.target
          : connection.target === startNodeId
            ? connection.source
            : start.mode === 'input'
              ? connection.source
              : connection.target;
      if (!startNodeId || !otherNodeId || otherNodeId === startNodeId) return;
      const normalizedConnection =
        start.mode === 'input'
          ? {
              ...connection,
              source: otherNodeId,
              target: startNodeId,
              sourceHandle: 'node-output',
              targetHandle: 'node-input',
            }
          : {
              ...connection,
              source: startNodeId,
              target: otherNodeId,
              sourceHandle: 'node-output',
              targetHandle: 'node-input',
            };
      const groupIds = start.referenceNodeIds.length ? start.referenceNodeIds : referenceSelectionIds;
      setConnectionMenu(null);
      setSelectedEdgeId('');
      onConnect(normalizedConnection);
      if (normalizedConnection.source && normalizedConnection.target) {
        attachReferencesToNode(normalizedConnection.target, [normalizedConnection.source, ...groupIds]);
      }
    },
    [attachReferencesToNode, onConnect, referenceSelectionIds],
  );

  const handleConnectStart = useCallback<OnConnectStart>((event, params) => {
    connectionStartRef.current = {
      nodeId: params.nodeId ?? '',
      mode: connectionModeFromEvent(event, params.handleType),
      referenceNodeIds: referenceSelectionIds,
    };
    setConnectionMenu(null);
    setSelectedEdgeId('');
  }, [referenceSelectionIds]);

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      const anchorNodeId = connectionState.fromNode?.id ?? connectionStartRef.current.nodeId;
      const mode = connectionStartRef.current.mode;
      const referenceNodeIds = connectionStartRef.current.referenceNodeIds;
      connectionStartRef.current = { nodeId: '', mode: null, referenceNodeIds: [] };
      if (!anchorNodeId || connectionState.toNode) return;
      const anchorNode = activeCanvas.nodes.find((node) => node.id === anchorNodeId);
      if (!anchorNode) return;
      const pointer = pointerFromConnectionEvent(event);
      const menuPosition = clampMenuPosition(pointer.x, pointer.y);
      setConnectionMenu({
        mode: mode === 'input' ? 'input' : 'output',
        anchorNodeId,
        anchorKind: anchorNode.data.kind,
        referenceNodeIds,
        x: menuPosition.x,
        y: menuPosition.y,
        flowPosition: screenToFlowPosition(pointer),
      });
    },
    [activeCanvas.nodes, screenToFlowPosition],
  );

  const clearGroupConnectionDrag = useCallback(() => {
    groupConnectionDragRef.current = null;
    setGroupConnectionDrag(null);
  }, []);

  const beginReferenceConnectionDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      options: {
        sourceGroupId?: string;
        anchorKind: NodeKind;
        referenceNodeIds: string[];
        fromX: number;
        fromY: number;
      },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setConnectionMenu(null);
      setSelectedEdgeId('');
      setColorPickerGroupId('');
      const nextDrag: GroupConnectionDragState = {
        sourceGroupId: options.sourceGroupId,
        anchorKind: options.anchorKind,
        referenceNodeIds: options.referenceNodeIds,
        startX: event.clientX,
        startY: event.clientY,
        fromX: options.fromX,
        fromY: options.fromY,
        toX: event.clientX,
        toY: event.clientY,
        moved: false,
      };
      groupConnectionDragRef.current = nextDrag;
      setGroupConnectionDrag(nextDrag);
    },
    [],
  );

  const updateGroupConnectionDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = groupConnectionDragRef.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    const moved =
      current.moved ||
      Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
    const nextDrag = { ...current, toX: event.clientX, toY: event.clientY, moved };
    groupConnectionDragRef.current = nextDrag;
    setGroupConnectionDrag(nextDrag);
  }, []);

  const finishGroupConnectionDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = groupConnectionDragRef.current;
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const pointer = { x: event.clientX, y: event.clientY };
      const targetNode = current.moved
        ? nodeAtScreenPoint(activeCanvas.nodes, viewport, pointer, current.referenceNodeIds)
        : null;
      if (targetNode) {
        if (current.sourceGroupId) {
          attachGroupReferencesToNode(targetNode.id, current.sourceGroupId);
        } else {
          connectSourceNodesToTarget(targetNode.id, current.referenceNodeIds);
        }
        clearGroupConnectionDrag();
        return;
      }
      const menuPosition = clampMenuPosition(pointer.x, pointer.y);
      setConnectionMenu({
        mode: 'output',
        sourceGroupId: current.sourceGroupId,
        anchorNodeId: current.referenceNodeIds[0],
        anchorKind: current.anchorKind,
        referenceNodeIds: current.referenceNodeIds,
        x: menuPosition.x,
        y: menuPosition.y,
        flowPosition: screenToFlowPosition(pointer),
      });
      clearGroupConnectionDrag();
    },
    [activeCanvas.nodes, attachGroupReferencesToNode, clearGroupConnectionDrag, connectSourceNodesToTarget, screenToFlowPosition, viewport],
  );

  const handleEdgeClick = useCallback(
    (event: React.MouseEvent, edge: StudioEdge) => {
      event.stopPropagation();
      selectNode('');
      setConnectionMenu(null);
      setSelectedEdgeId(edge.id);
    },
    [selectNode],
  );

  const fitCanvas = useCallback(() => {
    void fitView(fitOptions);
  }, [fitOptions, fitView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const primaryModifier = event.metaKey || event.ctrlKey;
      if (primaryModifier && key === 's') {
        event.preventDefault();
        saveNow();
        showImportNotice('画布已保存。', 'success');
        return;
      }
      if (primaryModifier && (key === '+' || key === '=')) {
        event.preventDefault();
        void zoomIn({ duration: 140 });
        return;
      }
      if (primaryModifier && key === '-') {
        event.preventDefault();
        void zoomOut({ duration: 140 });
        return;
      }
      if (primaryModifier || event.altKey) return;
      if ((key === 'delete' || key === 'backspace') && selectedEdgeId) {
        event.preventDefault();
        removeEdge(selectedEdgeId);
        setSelectedEdgeId('');
        return;
      }
      if ((key === 'delete' || key === 'backspace' || key === 'd') && selectedNodeIds.length) {
        event.preventDefault();
        onNodesChange(selectedNodeIds.map((id) => ({ id, type: 'remove' as const })));
        return;
      }
      if (key === 'a' && settings.multiAlignMode === 'hold' && selectedNodeIds.length > 1) {
        event.preventDefault();
        setAlignHoldActive(true);
        return;
      }
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
      if (key === 'k') {
        event.preventDefault();
        setActiveRailPanel('settings');
        setAddPanelOpen(false);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') setAlignHoldActive(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    fitCanvas,
    onNodesChange,
    removeEdge,
    saveNow,
    selectedEdgeId,
    selectedNodeIds,
    setAddPanelOpen,
    settings.multiAlignMode,
    showImportNotice,
    zoomIn,
    zoomOut,
  ]);

  useEffect(() => {
    setGridAlignEnabled(settings.gridSnap);
  }, [settings.gridSnap]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (isComposerProtectedTarget(event.target)) return;
      setAddPanelOpen(false);
      selectNode('');
      setConnectionMenu(null);
      setSelectedEdgeId('');
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [selectNode, setAddPanelOpen]);

  useEffect(() => {
    if (!addPanelOpen) return undefined;

    const clearCloseTimer = () => {
      if (addPanelCloseTimerRef.current === null) return;
      window.clearTimeout(addPanelCloseTimerRef.current);
      addPanelCloseTimerRef.current = null;
    };

    const scheduleClose = () => {
      if (addPanelCloseTimerRef.current !== null) return;
      addPanelCloseTimerRef.current = window.setTimeout(() => {
        addPanelCloseTimerRef.current = null;
        setAddPanelOpen(false);
      }, 180);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (isAddPanelHoverTarget(event.target)) {
        clearCloseTimer();
        return;
      }
      scheduleClose();
    };

    const handleWindowLeave = () => {
      scheduleClose();
    };

    window.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('mouseleave', handleWindowLeave);
    return () => {
      clearCloseTimer();
      window.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('mouseleave', handleWindowLeave);
    };
  }, [addPanelOpen, setAddPanelOpen]);

  const handleZoomSlider = useCallback(
    (value: number) => {
      const nextZoom = MIN_ZOOM + (value / 100) * (MAX_ZOOM - MIN_ZOOM);
      void zoomTo(nextZoom, { duration: 140 });
    },
    [zoomTo],
  );

  return (
    <main
      className={`studio-shell theme-${settings.theme} input-surface-${settings.inputSurface} cursor-${settings.cursorSize} ${fileDragActive ? 'is-file-dragging' : ''}`}
      style={{ '--relation-highlight': settings.highlightColor } as CSSProperties}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <input
        ref={fileInputRef}
        className="media-import-input"
        type="file"
        accept={mediaFileAccept}
        multiple
        onChange={handleFileInputChange}
      />
      <TopBar />
      <LeftRail activePanel={activeRailPanel} onPanelChange={setActiveRailPanel} />
      {addPanelOpen && (
        <section
          className="floating-panel add-panel-wrap"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <AddNodePanel onImportRequest={requestMediaImport} />
        </section>
      )}
      <RailPanels activePanel={activeRailPanel} onPanelChange={setActiveRailPanel} />
      <section className="canvas-stage">
        <ReactFlow<StudioNode, StudioEdge>
          key={activeCanvas.id}
          nodes={displayNodes}
          edges={settings.connectionVisible ? displayEdges : []}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          onNodeClick={handleNodeClick}
          onNodeDrag={(_event, node) => handleNodeDrag(node)}
          onNodeDragStop={(_event, node) => handleNodeDragStop(node)}
          onEdgeClick={handleEdgeClick}
          onPaneClick={handlePaneClick}
          onSelectionChange={handleSelectionChange}
          onMoveEnd={(_, viewport) => setViewport(viewport)}
          defaultViewport={activeCanvas.viewport}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          panOnDrag={false}
          panActivationKeyCode="Space"
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          selectionKeyCode={null}
          connectionMode={ConnectionMode.Loose}
          snapToGrid={snapToGrid}
          snapGrid={SNAP_GRID}
          connectionLineComponent={FloatingConnectionLine}
          proOptions={{ hideAttribution: true }}
          fitViewOptions={{ padding: 0.18 }}
        >
          {settings.gridVisible && (
            <Background variant={BackgroundVariant.Dots} gap={34} size={1.15} color="rgba(154, 168, 220, 0.18)" />
          )}
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

      {settings.guideSnap && alignmentGuide?.x !== undefined && (
        <div
          className="alignment-guide is-vertical"
          style={{ left: viewport.x + alignmentGuide.x * viewport.zoom }}
          aria-hidden="true"
        />
      )}
      {settings.guideSnap && alignmentGuide?.y !== undefined && (
        <div
          className="alignment-guide is-horizontal"
          style={{ top: viewport.y + alignmentGuide.y * viewport.zoom }}
          aria-hidden="true"
        />
      )}

      {settings.connectionVisible && (
        <GroupConnectionLines
          edges={groupEdges}
          groups={activeCanvas.groups}
          nodes={activeCanvas.nodes}
          viewport={viewport}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={setSelectedEdgeId}
          onRemoveEdge={(edgeId) => {
            removeEdge(edgeId);
            setSelectedEdgeId('');
          }}
        />
      )}

      {settings.connectionVisible && groupConnectionDrag && (
        <svg className="group-connection-layer group-connection-preview" aria-hidden="true">
          {(() => {
            const curve = Math.max(56, Math.min(180, Math.abs(groupConnectionDrag.toX - groupConnectionDrag.fromX) * 0.42));
            const path = `M ${groupConnectionDrag.fromX},${groupConnectionDrag.fromY} C ${groupConnectionDrag.fromX + curve},${groupConnectionDrag.fromY} ${groupConnectionDrag.toX - curve},${groupConnectionDrag.toY} ${groupConnectionDrag.toX},${groupConnectionDrag.toY}`;
            return (
              <>
                <path d={path} />
                <circle cx={groupConnectionDrag.fromX} cy={groupConnectionDrag.fromY} r="5" />
              </>
            );
          })()}
        </svg>
      )}

      {connectionMenu && (
        <ConnectionCreateMenu
          mode={connectionMenu.mode}
          targetKind={connectionMenu.anchorKind}
          x={connectionMenu.x}
          y={connectionMenu.y}
          onClose={() => setConnectionMenu(null)}
          onCreate={(kind) => {
            if (connectionMenu.sourceGroupId) {
              createReferencedNodeFromGroup(kind, connectionMenu.sourceGroupId, connectionMenu.flowPosition);
            } else if (connectionMenu.mode === 'input' && connectionMenu.anchorNodeId) {
              createInputNode(kind, connectionMenu.anchorNodeId, connectionMenu.flowPosition, connectionMenu.referenceNodeIds);
            } else if (connectionMenu.anchorNodeId) {
              createReferencedNode(kind, connectionMenu.anchorNodeId, connectionMenu.flowPosition, connectionMenu.referenceNodeIds);
            }
            setConnectionMenu(null);
          }}
        />
      )}

      {groupBounds && !selectedGroupId && (
        <div
          className="reference-group-overlay selection-group-overlay"
          style={{ left: groupBounds.left, top: groupBounds.top, width: groupBounds.width, height: groupBounds.height }}
        >
          <span>选中节点 · {referenceSelectionIds.length}</span>
          <div className="selection-group-toolbar" onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" title="执行选中节点">
              <Sparkles size={17} />
            </button>
            <button type="button" title="创建资产">
              <Upload size={17} />
            </button>
            <button type="button" title="打组" onClick={createGroupFromSelection}>
              <Grid2X2 size={17} />
            </button>
          </div>
          <button
            className="selection-group-output"
            type="button"
            aria-label="用引用组生成下一个节点"
            onPointerDown={(event) =>
              beginReferenceConnectionDrag(event, {
                anchorKind: groupBounds.anchorKind,
                referenceNodeIds: referenceSelectionIds,
                fromX: groupBounds.left + groupBounds.width,
                fromY: groupBounds.top + groupBounds.height / 2,
              })
            }
            onPointerMove={updateGroupConnectionDrag}
            onPointerUp={finishGroupConnectionDrag}
            onPointerCancel={clearGroupConnectionDrag}
          >
            <Plus size={18} />
          </button>
        </div>
      )}

      {activeCanvas.groups.map((group) => {
        const bounds = groupScreenBounds(group, viewport);
        const anchorNode = activeCanvas.nodes.find((node) => group.nodeIds.includes(node.id));
        const selected = selectedGroupId === group.id;
        const groupStyle = {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          '--group-color': group.color,
        } as CSSProperties;
        return (
          <div
            className={`canvas-group-overlay ${selected ? 'is-selected' : ''}`}
            key={group.id}
            style={groupStyle}
          >
            <strong>{group.name}</strong>
            <div className="canvas-group-toolbar" onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" title="整组执行" onClick={() => selectGroup(group.id)}>
                <Sparkles size={17} />
              </button>
              <button
                type="button"
                title="颜色"
                onClick={() => {
                  selectGroup(group.id);
                  setColorPickerGroupId((current) => (current === group.id ? '' : group.id));
                }}
              >
                <Palette size={17} />
              </button>
              <button type="button" title="创建工作流" onClick={() => selectGroup(group.id)}>
                <Boxes size={17} />
              </button>
              <button type="button" title="解组" onClick={() => ungroupGroup(group.id)}>
                <Trash2 size={17} />
              </button>
              {colorPickerGroupId === group.id && (
                <div className="group-color-popover">
                  {GROUP_COLORS.map((color) => (
                    <button
                      className={color === group.color ? 'is-active' : ''}
                      key={color}
                      type="button"
                      style={{ background: color }}
                      onClick={() => {
                        updateGroupColor(group.id, color);
                        setColorPickerGroupId('');
                      }}
                      aria-label={`设置组合颜色 ${color}`}
                    />
                  ))}
                </div>
              )}
            </div>
            <button
              className="canvas-group-output"
              type="button"
              aria-label="用组合生成下一个节点"
              onPointerDown={(event) => {
                selectGroup(group.id);
                const bounds = groupScreenBounds(group, viewport);
                beginReferenceConnectionDrag(event, {
                  sourceGroupId: group.id,
                  anchorKind: anchorNode?.data.kind ?? 'image',
                  referenceNodeIds: group.nodeIds,
                  fromX: bounds.left + bounds.width,
                  fromY: bounds.top + bounds.height / 2,
                });
              }}
              onPointerMove={updateGroupConnectionDrag}
              onPointerUp={finishGroupConnectionDrag}
              onPointerCancel={clearGroupConnectionDrag}
            >
              <Plus size={18} />
            </button>
          </div>
        );
      })}

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
              className={`control-circle ${snapToGrid ? 'is-active' : ''}`}
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
          <button className="zoom-step-button" type="button" onClick={() => void zoomOut({ duration: 140 })} aria-label="缩小">
            <Minus size={15} />
          </button>
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
          <button className="zoom-step-button" type="button" onClick={() => void zoomIn({ duration: 140 })} aria-label="放大">
            <Plus size={15} />
          </button>
        </div>
      </div>

      <SelectionReferenceHint />
      {selectedNodeIds.length > 1 &&
        (settings.multiAlignMode === 'click' || (settings.multiAlignMode === 'hold' && alignHoldActive)) && (
          <MultiAlignToolbar
            count={selectedNodeIds.length}
            spacing={settings.alignSpacing}
            onAlign={(alignment) => alignSelectedNodes(alignment, settings.alignSpacing)}
          />
        )}
      <GenerationComposer />

      {fileDragActive && (
        <div className="media-drop-overlay" aria-hidden="true">
          <Upload size={34} />
          <strong>松开即可导入媒体</strong>
          <span>支持一次拖入多个图片、视频和音频文件</span>
        </div>
      )}

      {importNotice && (
        <div className={`media-import-notice tone-${importNotice.tone}`} role="status" aria-live="polite">
          <Upload size={16} />
          <span>{importNotice.message}</span>
        </div>
      )}

      {completionNotice && (
        <button
          className="completion-notice"
          type="button"
          onClick={() => setCompletionNotice(null)}
          aria-label="关闭生成完成通知"
        >
          <BellRing size={18} />
          <span>
            <strong>生成完成</strong>
            <small>{completionNotice.title}</small>
          </span>
        </button>
      )}

      <button
        className="orb-generate"
        type="button"
        onClick={() => setQuickPanelOpen(!quickPanelOpen)}
        title="快捷生成"
      >
        <Sparkles size={27} />
      </button>

      {quickPanelOpen && <QuickChatPanel />}
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
