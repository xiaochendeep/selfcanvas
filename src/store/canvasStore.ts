import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import { create } from 'zustand';
import { mockGenerationAdapter } from '../services/mockGenerationAdapter';
import { projectRepository } from '../services/projectRepository';
import type { NodeKind, NodePreset, StudioCanvas, StudioEdge, StudioNode, StudioProject } from '../types';

const presets: Record<NodeKind, NodePreset> = {
  text: {
    kind: 'text',
    title: '生成文本',
    prompt: '写一段适合短视频开头的悬念文案',
    model: 'mock-text-director',
    provider: 'Mock Studio',
    width: 300,
    height: 250,
  },
  image: {
    kind: 'image',
    title: '生成图像',
    prompt: '暖色窗边，一只安静的小猫，电影感光影',
    model: 'mock-image-studio',
    provider: 'Mock Studio',
    width: 320,
    height: 300,
  },
  video: {
    kind: 'video',
    title: '生成视频',
    prompt: '镜头缓慢推进，角色回头，背景光线柔和',
    model: 'mock-video-5s',
    provider: 'Mock Studio',
    width: 380,
    height: 310,
  },
  asset: {
    kind: 'asset',
    title: '素材节点',
    prompt: 'reference-pack.png',
    model: 'local-asset',
    provider: 'Local',
    width: 280,
    height: 220,
  },
};

interface CanvasStore {
  project: StudioProject;
  activeCanvas: StudioCanvas;
  selectedNodeId: string;
  addPanelOpen: boolean;
  quickPanelOpen: boolean;
  lastSavedAt: string;
  onNodesChange: (changes: NodeChange<StudioNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<StudioEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  setViewport: (viewport: Viewport) => void;
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
  updateNodeData: (nodeId: string, patch: Partial<StudioNode['data']>) => void;
  selectNode: (nodeId: string) => void;
  runNode: (nodeId: string) => Promise<void>;
  createCanvas: () => void;
  setAddPanelOpen: (open: boolean) => void;
  setQuickPanelOpen: (open: boolean) => void;
  resetProject: () => void;
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeNode(kind: NodeKind, index: number, position?: { x: number; y: number }): StudioNode {
  const preset = presets[kind];
  return {
    id: newId(kind),
    type: 'studioNode',
    position: position ?? {
      x: 140 + (index % 3) * 360,
      y: 120 + Math.floor(index / 3) * 280,
    },
    width: preset.width,
    height: preset.height,
    data: {
      kind,
      title: preset.title,
      prompt: preset.prompt,
      status: 'idle',
      progress: 0,
      provider: preset.provider,
      model: preset.model,
      inputs: [],
      outputs: {},
      error: '',
    },
  };
}

function createStarterProject(): StudioProject {
  const createdAt = nowIso();
  const nodes = [
    makeNode('text', 0, { x: 120, y: 110 }),
    makeNode('image', 1, { x: 500, y: 150 }),
    makeNode('video', 2, { x: 920, y: 80 }),
    makeNode('asset', 3, { x: 540, y: 500 }),
  ];
  const edges: StudioEdge[] = [
    {
      id: 'starter_edge_text_image',
      source: nodes[0].id,
      target: nodes[1].id,
      animated: true,
      style: { stroke: 'rgba(143, 162, 255, 0.72)', strokeWidth: 1.4 },
    },
    {
      id: 'starter_edge_image_video',
      source: nodes[1].id,
      target: nodes[2].id,
      animated: true,
      style: { stroke: 'rgba(143, 162, 255, 0.72)', strokeWidth: 1.4 },
    },
  ];
  return {
    id: newId('project'),
    name: '默认画布',
    activeCanvasId: 'canvas_main',
    createdAt,
    updatedAt: createdAt,
    canvases: [
      {
        id: 'canvas_main',
        name: '默认画布',
        nodes,
        edges,
        viewport: { x: 0, y: 0, zoom: 0.84 },
      },
    ],
  };
}

function resolveProject() {
  return projectRepository.load() ?? createStarterProject();
}

function activeCanvasOf(project: StudioProject): StudioCanvas {
  return project.canvases.find((canvas) => canvas.id === project.activeCanvasId) ?? project.canvases[0];
}

function saveProject(project: StudioProject) {
  projectRepository.save(project);
  return nowIso();
}

function updateActiveCanvas(project: StudioProject, updater: (canvas: StudioCanvas) => StudioCanvas) {
  const updatedAt = nowIso();
  const canvases = project.canvases.map((canvas) =>
    canvas.id === project.activeCanvasId ? updater(canvas) : canvas,
  );
  return { ...project, canvases, updatedAt };
}

const initialProject = resolveProject();

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  project: initialProject,
  activeCanvas: activeCanvasOf(initialProject),
  selectedNodeId: '',
  addPanelOpen: false,
  quickPanelOpen: false,
  lastSavedAt: initialProject.updatedAt,

  onNodesChange: (changes) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: applyNodeChanges(changes, canvas.nodes),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        edges: applyEdgeChanges(changes, canvas.edges),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  onConnect: (connection) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        edges: addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: 'rgba(143, 162, 255, 0.74)', strokeWidth: 1.4 },
          },
          canvas.edges,
        ),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  setViewport: (viewport) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({ ...canvas, viewport }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  addNode: (kind, position) => {
    set((state) => {
      const index = state.activeCanvas.nodes.length;
      const node = makeNode(kind, index, position);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes, node],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  updateNodeData: (nodeId, patch) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node,
        ),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  runNode: async (nodeId) => {
    const node = get().activeCanvas.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    get().updateNodeData(nodeId, { status: 'running', progress: 3, error: '', outputs: {} });
    try {
      const outputs = await mockGenerationAdapter.run(node.data, (progress) => {
        get().updateNodeData(nodeId, { progress });
      });
      get().updateNodeData(nodeId, { status: 'success', progress: 100, outputs });
    } catch (error) {
      get().updateNodeData(nodeId, {
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createCanvas: () => {
    set((state) => {
      const id = newId('canvas');
      const project: StudioProject = {
        ...state.project,
        activeCanvasId: id,
        updatedAt: nowIso(),
        canvases: [
          ...state.project.canvases,
          {
            id,
            name: `画布 ${state.project.canvases.length + 1}`,
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 0.9 },
          },
        ],
      };
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  setAddPanelOpen: (open) => set({ addPanelOpen: open }),
  setQuickPanelOpen: (open) => set({ quickPanelOpen: open }),

  resetProject: () => {
    const project = createStarterProject();
    projectRepository.save(project);
    set({
      project,
      activeCanvas: activeCanvasOf(project),
      selectedNodeId: '',
      addPanelOpen: false,
      quickPanelOpen: false,
      lastSavedAt: project.updatedAt,
    });
  },
}));

export const nodePresets = presets;
