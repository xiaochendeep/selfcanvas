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
import { notifyGenerationComplete, prepareCompletionFeedback } from '../services/completionNotifier';
import { generationClient } from '../services/generationClient';
import { projectRepository } from '../services/projectRepository';
import { useSettingsStore, type StudioSettings } from './settingsStore';
import type {
  CanvasGroup,
  CanvasGroupBounds,
  ImportedMedia,
  NodeReference,
  NodeKind,
  NodePreset,
  ProviderOptions,
  StoryboardShot,
  StudioCanvas,
  StudioEdge,
  StudioNode,
  StudioProject,
} from '../types';
import {
  appendReferenceMentions,
  mergeReferences,
  nodeToGroupReference,
  nodeToReference,
  referenceKey,
} from '../utils/nodeReferences';
import { storyboardShotToText } from '../utils/storyboard';

const presets: Record<NodeKind, NodePreset> = {
  text: {
    kind: 'text',
    title: '生成文本',
    prompt: '写一段适合短视频开头的悬念文案',
    model: 'gpt-4o-mini',
    provider: 'Sub2API',
    width: 286,
    height: 220,
  },
  image: {
    kind: 'image',
    title: '生成图像',
    prompt: '暖色窗边，一只安静的小猫，电影感光影',
    model: 'gpt-image-2',
    provider: 'Sub2API',
    width: 286,
    height: 236,
  },
  video: {
    kind: 'video',
    title: '生成视频',
    prompt: '镜头缓慢推进，角色回头，背景光线柔和',
    model: 'seedance-2-fast',
    provider: 'AnyCap',
    width: 318,
    height: 238,
  },
  audio: {
    kind: 'audio',
    title: '生成音频',
    prompt: '温柔旁白，轻微空间混响，适合短片开场',
    model: 'anycap-audio',
    provider: 'AnyCap',
    width: 286,
    height: 226,
  },
  stage3d: {
    kind: 'stage3d',
    title: '3D导演台',
    prompt: '搭建一个电影感室内场景，放置主角、相机和柔光灯',
    model: 'mock-stage-3d',
    provider: 'Local Tool',
    width: 360,
    height: 260,
  },
  panorama: {
    kind: 'panorama',
    title: '360全景图',
    prompt: '生成一个可环视的草原黄昏全景场景',
    model: 'mock-panorama-360',
    provider: 'Mock Studio',
    width: 360,
    height: 260,
  },
  storyboard: {
    kind: 'storyboard',
    title: '分镜脚本',
    prompt: '把这个创意拆成 5 个镜头，包含景别、运镜和画面提示词',
    model: 'gpt-5.5',
    provider: 'Sub2API',
    width: 760,
    height: 440,
  },
  collage: {
    kind: 'collage',
    title: '拼图',
    prompt: '把上游图片组合成 2x2 视觉参考板',
    model: 'mock-collage-layout',
    provider: 'Local Tool',
    width: 340,
    height: 250,
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
  upload: {
    kind: 'upload',
    title: '上传文件',
    prompt: '拖入或选择本地图片、视频、音频文件',
    model: 'local-upload',
    provider: 'Local',
    width: 300,
    height: 230,
  },
};

export type NodeAlignment = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' | 'distribute-x' | 'distribute-y';

interface CanvasStore {
  project: StudioProject;
  activeCanvas: StudioCanvas;
  selectedNodeId: string;
  selectedNodeIds: string[];
  selectedGroupId: string;
  referenceSelectionIds: string[];
  addPanelOpen: boolean;
  quickPanelOpen: boolean;
  lastSavedAt: string;
  onNodesChange: (changes: NodeChange<StudioNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<StudioEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  setViewport: (viewport: Viewport) => void;
  setNodePositions: (positions: Array<{ id: string; position: { x: number; y: number } }>) => void;
  alignSelectedNodes: (alignment: NodeAlignment, spacing: number) => void;
  saveNow: () => void;
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
  createImportedMediaNode: (
    media: Pick<ImportedMedia, 'name' | 'type' | 'mimeType' | 'size'>,
    position: { x: number; y: number },
  ) => string;
  updateNodeData: (nodeId: string, patch: Partial<StudioNode['data']>) => void;
  selectNode: (nodeId: string) => void;
  focusNodeAsTarget: (nodeId: string) => void;
  setSelectedNodes: (nodeIds: string[]) => void;
  selectGroup: (groupId: string) => void;
  createGroupFromSelection: () => void;
  ungroupGroup: (groupId: string) => void;
  updateGroupColor: (groupId: string, color: string) => void;
  attachReferencesToNode: (targetNodeId: string, sourceNodeIds: string[]) => void;
  attachGroupReferencesToNode: (targetNodeId: string, groupId: string) => void;
  connectSourceNodesToTarget: (targetNodeId: string, sourceNodeIds: string[]) => void;
  removeEdge: (edgeId: string) => void;
  createInputNode: (
    kind: NodeKind,
    targetNodeId: string,
    position?: { x: number; y: number },
    sourceNodeIds?: string[],
  ) => void;
  createReferencedNode: (
    kind: NodeKind,
    sourceNodeId: string,
    position?: { x: number; y: number },
    sourceNodeIds?: string[],
  ) => void;
  createReferencedNodeFromGroup: (kind: NodeKind, groupId: string, position?: { x: number; y: number }) => void;
  createNodeFromStoryboardShot: (storyboardNodeId: string, shot: StoryboardShot, kind: 'image' | 'video') => void;
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

function defaultModelForKind(kind: NodeKind, model: string) {
  if (model && !model.startsWith('mock-') && !model.startsWith('local-')) return model;
  if (kind === 'text') return 'gpt-4o-mini';
  if (kind === 'image') return 'gpt-image-2';
  if (kind === 'video') return 'seedance-2-fast';
  if (kind === 'audio') return 'anycap-audio';
  if (kind === 'storyboard') return 'gpt-5.5';
  return model || 'local-preview';
}

function defaultProviderOptions(kind: NodeKind, model: string): ProviderOptions {
  const resolvedModel = defaultModelForKind(kind, model);
  if (kind === 'text') return { providerTool: 'sub2api', model: resolvedModel, temperature: 0.8 };
  if (kind === 'image') {
    return {
      providerTool: 'sub2api',
      model: resolvedModel,
      size: '1024x1024',
      resolutionTier: '1K',
      aspectRatio: 'adaptive',
      count: 1,
      responseFormat: 'url',
      outputFormat: 'png',
      transparentBackground: false,
      quality: 'standard',
      referenceQuality: 'high',
    };
  }
  if (kind === 'video') {
    return {
      providerTool: 'anycap',
      model: resolvedModel,
      mode: 'multi-modal-reference',
      resolution: '720p',
      duration: 6,
      aspectRatio: 'adaptive',
      generateAudio: true,
      format: 'mp4',
    };
  }
  if (kind === 'audio') {
    return {
      providerTool: 'anycap',
      model: resolvedModel,
      mode: 'text-to-music',
      duration: 30,
      style: 'cinematic',
      voiceMode: 'voice-reference',
      voiceReference: '',
      targetVoice: '',
    };
  }
  if (kind === 'storyboard') {
    return {
      providerTool: 'sub2api',
      model: resolvedModel,
      temperature: 0.7,
      shotCount: 5,
      promptMode: 'image',
      viewMode: 'list',
      systemPrompt: '你是专业影视分镜师。把用户剧情拆成清晰镜头列表，每个镜头包含镜号、景别、画面、运镜、图像提示词和视频提示词。',
    };
  }
  return { model: resolvedModel };
}

function defaultProviderForKind(kind: NodeKind, provider: string) {
  if (provider && provider !== 'Mock Studio') return provider;
  if (kind === 'text' || kind === 'image' || kind === 'storyboard') return 'Sub2API';
  if (kind === 'video' || kind === 'audio') return 'AnyCap';
  return provider || 'Local';
}

function normalizeCanvas(canvas: Partial<StudioCanvas>, index: number): StudioCanvas {
  const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
  const groups = normalizeGroups(Array.isArray(canvas.groups) ? canvas.groups : [], nodes);
  const viewport = canvas.viewport ?? { x: 0, y: 0, zoom: 0.84 };
  return {
    id: canvas.id || `canvas_${index + 1}`,
    name: canvas.name || `画布 ${index + 1}`,
    viewport,
    edges,
    groups,
    nodes: nodes.map((node) => {
      const model = defaultModelForKind(node.data.kind, String(node.data.model || ''));
      const providerOptions = {
        ...defaultProviderOptions(node.data.kind, model),
        ...(node.data.providerOptions ?? {}),
      };
      const optionModel = defaultModelForKind(node.data.kind, String(providerOptions.model || model));
      return {
        ...node,
        selected: false,
        data: {
          ...node.data,
          model: optionModel,
          provider: defaultProviderForKind(node.data.kind, String(node.data.provider || '')),
          inputs: Array.isArray(node.data.inputs) ? node.data.inputs : [],
          outputs: node.data.outputs ?? {},
          references: node.data.references ?? [],
          providerOptions: { ...providerOptions, model: optionModel },
          error: node.data.error ?? '',
        },
      };
    }),
  };
}

function normalizeProject(project: StudioProject): StudioProject {
  const fallback = createStarterProject();
  const sourceCanvases = Array.isArray(project.canvases) && project.canvases.length ? project.canvases : fallback.canvases;
  const canvases = sourceCanvases.map((canvas, index) => normalizeCanvas(canvas, index));
  const activeCanvasId = canvases.some((canvas) => canvas.id === project.activeCanvasId)
    ? project.activeCanvasId
    : canvases[0].id;
  return {
    ...project,
    id: project.id || fallback.id,
    name: project.name || fallback.name,
    createdAt: project.createdAt || fallback.createdAt,
    updatedAt: project.updatedAt || fallback.updatedAt,
    activeCanvasId,
    canvases,
  };
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
      references: [],
      providerOptions: defaultProviderOptions(kind, preset.model),
      error: '',
    },
  };
}

function nodeDimensions(node: StudioNode) {
  return {
    width: node.measured?.width ?? node.width ?? presets[node.data.kind].width,
    height: node.measured?.height ?? node.height ?? presets[node.data.kind].height,
  };
}

function overlapsExistingNode(
  position: { x: number; y: number },
  size: { width: number; height: number },
  nodes: StudioNode[],
) {
  const padding = 18;
  return nodes.some((node) => {
    const current = nodeDimensions(node);
    return !(
      position.x + size.width + padding <= node.position.x ||
      position.x >= node.position.x + current.width + padding ||
      position.y + size.height + padding <= node.position.y ||
      position.y >= node.position.y + current.height + padding
    );
  });
}

function nextNodePosition(
  kind: NodeKind,
  nodes: StudioNode[],
  selectedNodeId: string,
  settings: StudioSettings,
) {
  if (!nodes.length) return { x: 140, y: 120 };
  const anchor = nodes.find((node) => node.id === selectedNodeId) ?? nodes[nodes.length - 1];
  const anchorSize = nodeDimensions(anchor);
  const size = { width: presets[kind].width, height: presets[kind].height };
  const horizontal = settings.newNodeDirection === 'right';
  const step = settings.newNodeSpacing;
  const position = horizontal
    ? { x: anchor.position.x + anchorSize.width + step, y: anchor.position.y }
    : { x: anchor.position.x, y: anchor.position.y + anchorSize.height + step };

  if (!settings.newNodeAvoidOverlap) return position;
  const stride = (horizontal ? size.width : size.height) + step;
  for (let attempt = 0; attempt < 64 && overlapsExistingNode(position, size, nodes); attempt += 1) {
    if (horizontal) position.x += stride;
    else position.y += stride;
  }
  return position;
}

function makeImportedMediaNode(
  id: string,
  media: Pick<ImportedMedia, 'name' | 'type' | 'mimeType' | 'size'>,
  position: { x: number; y: number },
): StudioNode {
  return {
    id,
    type: 'studioNode',
    position,
    width: media.type === 'audio' ? 320 : 340,
    height: media.type === 'audio' ? 190 : 260,
    data: {
      kind: 'asset',
      title: media.name,
      prompt: '',
      status: 'running',
      progress: 1,
      provider: 'Local Upload',
      model: 'local-upload',
      inputs: [],
      outputs: {
        assetName: media.name,
        text: '正在复制到项目文件夹…',
      },
      references: [],
      providerOptions: { model: 'local-upload' },
      importedMedia: {
        id: `pending:${id}`,
        ...media,
        url: '',
        path: '',
      },
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
        groups: [],
        viewport: { x: 0, y: 0, zoom: 0.84 },
      },
    ],
  };
}

function resolveProject() {
  const loadedProject = projectRepository.load();
  if (!loadedProject) return createStarterProject();
  const normalizedProject = normalizeProject(loadedProject);
  projectRepository.save(normalizedProject);
  return normalizedProject;
}

function activeCanvasOf(project: StudioProject): StudioCanvas {
  const canvas = project.canvases.find((item) => item.id === project.activeCanvasId) ?? project.canvases[0];
  if (canvas) return canvas;
  return createStarterProject().canvases[0];
}

function saveProject(project: StudioProject) {
  projectRepository.save(project);
  return nowIso();
}

function pause(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readableGenerationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Sub2API 401:.*API key is required|Sub2API 未读取到 API Key/i.test(message)) {
    return 'Sub2API 未读取到 API Key。已改为自动读取 .env，请重新生成一次。';
  }
  if (/Missing bearer|basic authentication|Authorization header/i.test(message)) {
    return '当前模型接口缺少 API Key，请在设置里填入密钥或检查 .env。';
  }
  if (/No available compatible accounts/i.test(message)) {
    return 'Sub2API 已连接，但没有可服务该模型的账号/渠道。';
  }
  return message;
}

function updateActiveCanvas(project: StudioProject, updater: (canvas: StudioCanvas) => StudioCanvas) {
  const updatedAt = nowIso();
  const canvases = project.canvases.map((canvas) =>
    canvas.id === project.activeCanvasId ? updater(canvas) : canvas,
  );
  return { ...project, canvases, updatedAt };
}

function nodeRect(node: StudioNode) {
  const width = node.measured?.width ?? node.width ?? presets[node.data.kind]?.width ?? 300;
  const height = node.measured?.height ?? node.height ?? presets[node.data.kind]?.height ?? 240;
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
    right: node.position.x + width,
    bottom: node.position.y + height,
  };
}

function boundsForNodeIds(nodes: StudioNode[], nodeIds: string[], padding = 48): CanvasGroupBounds | null {
  const idSet = new Set(nodeIds);
  const groupNodes = nodes.filter((node) => idSet.has(node.id));
  if (groupNodes.length < 2) return null;
  const rects = groupNodes.map(nodeRect);
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.right));
  const maxY = Math.max(...rects.map((rect) => rect.bottom));
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function normalizeGroups(groups: Partial<CanvasGroup>[], nodes: StudioNode[]): CanvasGroup[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return groups
    .map((group, index) => {
      const ids = [...new Set(Array.isArray(group.nodeIds) ? group.nodeIds.filter((id) => nodeIds.has(id)) : [])];
      if (ids.length < 2) return null;
      const bounds = boundsForNodeIds(nodes, ids) ?? group.bounds;
      if (!bounds) return null;
      const timestamp = group.createdAt || nowIso();
      return {
        id: group.id || newId('group'),
        name: group.name || `组合 ${index + 1}`,
        nodeIds: ids,
        bounds,
        color: group.color || '#6d63ff',
        createdAt: timestamp,
        updatedAt: group.updatedAt || timestamp,
      };
    })
    .filter((group): group is CanvasGroup => Boolean(group));
}

function refreshCanvasGroups(canvas: StudioCanvas): StudioCanvas {
  return {
    ...canvas,
    groups: normalizeGroups(canvas.groups ?? [], canvas.nodes),
  };
}

function edgeFor(source: string, target: string): StudioEdge {
  return {
    id: `edge_${source}_${target}_${Date.now().toString(36)}`,
    source,
    target,
    animated: true,
    style: { stroke: 'rgba(143, 162, 255, 0.74)', strokeWidth: 1.4, strokeDasharray: '7 8' },
  };
}

function groupEdgeFor(groupId: string, target: string): StudioEdge {
  return {
    id: `edge_group_${groupId}_${target}_${Date.now().toString(36)}`,
    source: groupId,
    target,
    animated: true,
    data: { sourceGroupId: groupId },
    style: { stroke: 'rgba(255, 255, 255, 0.78)', strokeWidth: 1.8, strokeDasharray: '0' },
  };
}

function hasGroupEdge(edges: StudioEdge[], groupId: string, targetNodeId: string) {
  return edges.some((edge) => edge.data?.sourceGroupId === groupId && edge.target === targetNodeId);
}

function hasNodeEdge(edges: StudioEdge[], sourceNodeId: string, targetNodeId: string) {
  return edges.some((edge) => edge.source === sourceNodeId && edge.target === targetNodeId && !edge.data?.sourceGroupId);
}

function pruneEdgesForCanvas(canvas: StudioCanvas) {
  const nodeIds = new Set(canvas.nodes.map((node) => node.id));
  const groupIds = new Set(canvas.groups.map((group) => group.id));
  return canvas.edges.filter((edge) => {
    const sourceGroupId = typeof edge.data?.sourceGroupId === 'string' ? edge.data.sourceGroupId : '';
    if (sourceGroupId) return groupIds.has(sourceGroupId) && nodeIds.has(edge.target);
    return nodeIds.has(edge.source) && nodeIds.has(edge.target);
  });
}

function nodeReferencesFromIds(nodes: StudioNode[], ids: string[], excludeId?: string) {
  const uniqueIds = [...new Set(ids)].filter((id) => id && id !== excludeId);
  return uniqueIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is StudioNode => Boolean(node))
    .map(nodeToReference);
}

function hydrateNodeReferences(node: StudioNode, nodes: StudioNode[]) {
  return (node.data.references ?? []).map((reference) => {
    if (reference.source === 'output') return reference;
    const sourceNode = nodes.find((item) => item.id === reference.nodeId);
    if (!sourceNode) return reference;
    const fresh = nodeToReference(sourceNode);
    return {
      ...fresh,
      source: reference.source,
      groupId: reference.groupId,
    };
  });
}

function patchNodeWithReferences(node: StudioNode, references: ReturnType<typeof nodeReferencesFromIds>) {
  const existing = node.data.references ?? [];
  const merged = mergeReferences(existing, references);
  const addedReferences = references.filter(
    (reference) => !existing.some((item) => referenceKey(item) === referenceKey(reference)),
  );
  return {
    ...node,
    data: {
      ...node.data,
      references: merged,
      prompt: appendReferenceMentions(node.data.prompt, addedReferences),
    },
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripReferenceMentions(prompt: string, references: NodeReference[]) {
  return references
    .reduce((nextPrompt, reference) => {
      const mention = `@${reference.title}`;
      return nextPrompt.replace(new RegExp(`(^|\\s)${escapeRegExp(mention)}(?=\\s|$)`, 'g'), '$1');
    }, prompt)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function groupReferencesFromId(canvas: StudioCanvas, groupId: string, excludeId?: string) {
  const group = canvas.groups.find((item) => item.id === groupId);
  if (!group) return [];
  const idSet = new Set(group.nodeIds.filter((id) => id !== excludeId));
  return canvas.nodes
    .filter((node) => idSet.has(node.id))
    .map((node) => nodeToGroupReference(node, group));
}

function referencesForEdge(canvas: StudioCanvas, edge: StudioEdge) {
  const groupId = typeof edge.data?.sourceGroupId === 'string' ? edge.data.sourceGroupId : '';
  if (groupId) return groupReferencesFromId(canvas, groupId, edge.target);
  const sourceNode = canvas.nodes.find((node) => node.id === edge.source);
  return sourceNode ? [nodeToReference(sourceNode)] : [];
}

function removeReferencesForEdges(canvas: StudioCanvas, removedEdges: StudioEdge[]) {
  if (!removedEdges.length) return canvas;
  const removalsByTarget = new Map<string, NodeReference[]>();
  for (const edge of removedEdges) {
    const references = referencesForEdge(canvas, edge);
    if (!references.length) continue;
    removalsByTarget.set(edge.target, [...(removalsByTarget.get(edge.target) ?? []), ...references]);
  }
  if (!removalsByTarget.size) return canvas;
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      const removals = removalsByTarget.get(node.id);
      if (!removals?.length) return node;
      const removalKeys = new Set(removals.map(referenceKey));
      const references = (node.data.references ?? []).filter((reference) => !removalKeys.has(referenceKey(reference)));
      return {
        ...node,
        data: {
          ...node.data,
          references,
          prompt: stripReferenceMentions(node.data.prompt, removals),
        },
      };
    }),
  };
}

const initialProject = resolveProject();

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  project: initialProject,
  activeCanvas: activeCanvasOf(initialProject),
  selectedNodeId: '',
  selectedNodeIds: [],
  selectedGroupId: '',
  referenceSelectionIds: [],
  addPanelOpen: false,
  quickPanelOpen: false,
  lastSavedAt: initialProject.updatedAt,

  onNodesChange: (changes) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => {
        const refreshed = refreshCanvasGroups({
          ...canvas,
          nodes: applyNodeChanges(changes, canvas.nodes),
        });
        return {
          ...refreshed,
          edges: pruneEdgesForCanvas(refreshed),
        };
      });
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
      const project = updateActiveCanvas(state.project, (canvas) => {
        const removedEdges = canvas.edges.filter((edge) => removedIds.has(edge.id));
        return removeReferencesForEdges(
          {
            ...canvas,
            edges: applyEdgeChanges(changes, canvas.edges),
          },
          removedEdges,
        );
      });
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

  setNodePositions: (positions) => {
    if (!positions.length) return;
    const byId = new Map(positions.map((item) => [item.id, item.position]));
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => {
          const position = byId.get(node.id);
          return position ? { ...node, position } : node;
        }),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  alignSelectedNodes: (alignment, spacing) => {
    set((state) => {
      const selected = state.activeCanvas.nodes.filter((node) => state.selectedNodeIds.includes(node.id));
      if (selected.length < 2) return state;

      const left = Math.min(...selected.map((node) => node.position.x));
      const top = Math.min(...selected.map((node) => node.position.y));
      const right = Math.max(...selected.map((node) => node.position.x + nodeDimensions(node).width));
      const bottom = Math.max(...selected.map((node) => node.position.y + nodeDimensions(node).height));
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const positions = new Map<string, { x: number; y: number }>();

      if (alignment === 'distribute-x') {
        const ordered = [...selected].sort((a, b) => a.position.x - b.position.x);
        let cursor = ordered[0].position.x;
        ordered.forEach((node, index) => {
          positions.set(node.id, { x: cursor, y: node.position.y });
          cursor += nodeDimensions(node).width + (index < ordered.length - 1 ? spacing : 0);
        });
      } else if (alignment === 'distribute-y') {
        const ordered = [...selected].sort((a, b) => a.position.y - b.position.y);
        let cursor = ordered[0].position.y;
        ordered.forEach((node, index) => {
          positions.set(node.id, { x: node.position.x, y: cursor });
          cursor += nodeDimensions(node).height + (index < ordered.length - 1 ? spacing : 0);
        });
      } else {
        selected.forEach((node) => {
          const size = nodeDimensions(node);
          let x = node.position.x;
          let y = node.position.y;
          if (alignment === 'left') x = left;
          if (alignment === 'center-x') x = centerX - size.width / 2;
          if (alignment === 'right') x = right - size.width;
          if (alignment === 'top') y = top;
          if (alignment === 'center-y') y = centerY - size.height / 2;
          if (alignment === 'bottom') y = bottom - size.height;
          positions.set(node.id, { x, y });
        });
      }

      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position } : node;
        }),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  saveNow: () => {
    set((state) => ({ lastSavedAt: saveProject(state.project) }));
  },

  addNode: (kind, position) => {
    set((state) => {
      const index = state.activeCanvas.nodes.length;
      const settings = useSettingsStore.getState().settings;
      const resolvedPosition = position ?? nextNodePosition(kind, state.activeCanvas.nodes, state.selectedNodeId, settings);
      const node = makeNode(kind, index, resolvedPosition);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes, node],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedGroupId: '',
        selectedNodeIds: [node.id],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  createImportedMediaNode: (media, position) => {
    const nodeId = newId('asset');
    set((state) => {
      const node = makeImportedMediaNode(nodeId, media, position);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes, node],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedGroupId: '',
        selectedNodeIds: [node.id],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
    return nodeId;
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

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      selectedNodeIds: nodeId ? [nodeId] : [],
      selectedGroupId: '',
      referenceSelectionIds: nodeId ? state.referenceSelectionIds : [],
    })),

  setSelectedNodes: (nodeIds) => {
    const uniqueIds = [...new Set(nodeIds)];
    const selectedSet = new Set(uniqueIds);
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => ({ ...node, selected: selectedSet.has(node.id) })),
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: uniqueIds.length === 1 ? uniqueIds[0] : '',
        selectedNodeIds: uniqueIds,
        selectedGroupId: '',
        referenceSelectionIds: uniqueIds.length > 1 ? uniqueIds : state.referenceSelectionIds,
        lastSavedAt: saveProject(project),
      };
    });
  },

  selectGroup: (groupId) =>
    set((state) => {
      const group = state.activeCanvas.groups.find((item) => item.id === groupId);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => ({ ...node, selected: false })),
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: '',
        selectedNodeIds: group?.nodeIds ?? [],
        selectedGroupId: groupId,
        referenceSelectionIds: [],
        lastSavedAt: saveProject(project),
      };
    }),

  createGroupFromSelection: () => {
    set((state) => {
      const ids = [...new Set(state.selectedNodeIds.length > 1 ? state.selectedNodeIds : state.referenceSelectionIds)];
      const bounds = boundsForNodeIds(state.activeCanvas.nodes, ids);
      if (!bounds || ids.length < 2) return state;
      const createdAt = nowIso();
      const group: CanvasGroup = {
        id: newId('group'),
        name: '组合',
        nodeIds: ids,
        bounds,
        color: '#6d63ff',
        createdAt,
        updatedAt: createdAt,
      };
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        groups: [...(canvas.groups ?? []), group],
        nodes: canvas.nodes.map((node) => ({ ...node, selected: false })),
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: '',
        selectedNodeIds: [],
        selectedGroupId: group.id,
        referenceSelectionIds: [],
        lastSavedAt: saveProject(project),
      };
    });
  },

  ungroupGroup: (groupId) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        groups: (canvas.groups ?? []).filter((group) => group.id !== groupId),
        edges: canvas.edges.filter((edge) => edge.data?.sourceGroupId !== groupId),
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedGroupId: state.selectedGroupId === groupId ? '' : state.selectedGroupId,
        selectedNodeIds: [],
        referenceSelectionIds: [],
        lastSavedAt: saveProject(project),
      };
    });
  },

  updateGroupColor: (groupId, color) => {
    set((state) => {
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        groups: (canvas.groups ?? []).map((group) =>
          group.id === groupId ? { ...group, color, updatedAt: nowIso() } : group,
        ),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  attachReferencesToNode: (targetNodeId, sourceNodeIds) => {
    set((state) => {
      const references = nodeReferencesFromIds(state.activeCanvas.nodes, sourceNodeIds, targetNodeId);
      if (!references.length) return state;
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => (node.id === targetNodeId ? patchNodeWithReferences(node, references) : node)),
      }));
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  attachGroupReferencesToNode: (targetNodeId, groupId) => {
    set((state) => {
      const references = groupReferencesFromId(state.activeCanvas, groupId, targetNodeId);
      if (!references.length) return state;
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => (node.id === targetNodeId ? patchNodeWithReferences(node, references) : node)),
        edges: hasGroupEdge(canvas.edges, groupId, targetNodeId)
          ? canvas.edges
          : [...canvas.edges, groupEdgeFor(groupId, targetNodeId)],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedGroupId: '',
        selectedNodeId: targetNodeId,
        selectedNodeIds: [targetNodeId],
        lastSavedAt: saveProject(project),
      };
    });
  },

  connectSourceNodesToTarget: (targetNodeId, sourceNodeIds) => {
    set((state) => {
      const sourceIds = [...new Set(sourceNodeIds)].filter((id) => id && id !== targetNodeId);
      const references = nodeReferencesFromIds(state.activeCanvas.nodes, sourceIds, targetNodeId);
      if (!references.length) return state;
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => (node.id === targetNodeId ? patchNodeWithReferences(node, references) : node)),
        edges: [
          ...canvas.edges,
          ...sourceIds
            .filter((sourceId) => !hasNodeEdge(canvas.edges, sourceId, targetNodeId))
            .map((sourceId) => edgeFor(sourceId, targetNodeId)),
        ],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedGroupId: '',
        selectedNodeId: targetNodeId,
        selectedNodeIds: [targetNodeId],
        referenceSelectionIds: [],
        lastSavedAt: saveProject(project),
      };
    });
  },

  removeEdge: (edgeId) => {
    set((state) => {
      const edge = state.activeCanvas.edges.find((item) => item.id === edgeId);
      if (!edge) return state;
      const project = updateActiveCanvas(state.project, (canvas) =>
        removeReferencesForEdges(
          {
            ...canvas,
            edges: canvas.edges.filter((item) => item.id !== edgeId),
          },
          [edge],
        ),
      );
      return { project, activeCanvas: activeCanvasOf(project), lastSavedAt: saveProject(project) };
    });
  },

  createInputNode: (kind, targetNodeId, position, sourceNodeIds) => {
    set((state) => {
      const index = state.activeCanvas.nodes.length;
      const node = makeNode(kind, index, position);
      const extraSourceIds = (sourceNodeIds ?? state.referenceSelectionIds).filter((id) => id !== targetNodeId);
      const references = [nodeToReference(node), ...nodeReferencesFromIds(state.activeCanvas.nodes, extraSourceIds, targetNodeId)];
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [
          ...canvas.nodes.map((canvasNode) =>
            canvasNode.id === targetNodeId ? patchNodeWithReferences(canvasNode, references) : canvasNode,
          ),
          node,
        ],
        edges: [...canvas.edges, edgeFor(node.id, targetNodeId)],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedNodeIds: [node.id],
        selectedGroupId: '',
        referenceSelectionIds: [],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  focusNodeAsTarget: (nodeId) => {
    const state = get();
    const selectedGroupId = state.selectedGroupId;
    const selectedGroup = state.activeCanvas.groups.find((group) => group.id === selectedGroupId);
    if (selectedGroup && !selectedGroup.nodeIds.includes(nodeId)) {
      get().attachGroupReferencesToNode(nodeId, selectedGroupId);
      return;
    }
    const bufferedIds = state.referenceSelectionIds.filter((id) => id !== nodeId);
    if (bufferedIds.length) {
      get().attachReferencesToNode(nodeId, bufferedIds);
    }
    set((nextState) => {
      const project = updateActiveCanvas(nextState.project, (canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) => ({ ...node, selected: node.id === nodeId })),
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: nodeId,
        selectedNodeIds: [nodeId],
        selectedGroupId: '',
        referenceSelectionIds: bufferedIds,
        lastSavedAt: saveProject(project),
      };
    });
  },

  createReferencedNode: (kind, sourceNodeId, position, sourceNodeIds) => {
    set((state) => {
      const index = state.activeCanvas.nodes.length;
      const node = makeNode(kind, index, position);
      const sourceIds = [...new Set([sourceNodeId, ...(sourceNodeIds ?? state.referenceSelectionIds)])].filter(
        (id) => id && id !== node.id,
      );
      const references = nodeReferencesFromIds(state.activeCanvas.nodes, sourceIds);
      const nodeWithReferences = patchNodeWithReferences(node, references);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes, nodeWithReferences],
        edges: [...canvas.edges, ...sourceIds.map((id) => edgeFor(id, node.id))],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedNodeIds: [node.id],
        selectedGroupId: '',
        referenceSelectionIds: [],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  createReferencedNodeFromGroup: (kind, groupId, position) => {
    set((state) => {
      const group = state.activeCanvas.groups.find((item) => item.id === groupId);
      if (!group) return state;
      const index = state.activeCanvas.nodes.length;
      const node = makeNode(kind, index, position);
      const references = groupReferencesFromId(state.activeCanvas, groupId, node.id);
      const nodeWithReferences = patchNodeWithReferences(node, references);
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes, nodeWithReferences],
        edges: [...canvas.edges, groupEdgeFor(groupId, node.id)],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedNodeIds: [node.id],
        selectedGroupId: '',
        referenceSelectionIds: [],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  createNodeFromStoryboardShot: (storyboardNodeId, shot, kind) => {
    set((state) => {
      const storyboardNode = state.activeCanvas.nodes.find((node) => node.id === storyboardNodeId);
      if (!storyboardNode) return state;
      const index = state.activeCanvas.nodes.length;
      const storyboardSize = nodeDimensions(storyboardNode);
      const desired = {
        x: storyboardNode.position.x + storyboardSize.width + 80,
        y: storyboardNode.position.y + (shot.shotNumber - 1) * (presets[kind].height + 34),
      };
      const position = { ...desired };
      const size = { width: presets[kind].width, height: presets[kind].height };
      while (overlapsExistingNode(position, size, state.activeCanvas.nodes)) position.y += size.height + 34;
      const child = makeNode(kind, index, position);
      const mediaReferences = (storyboardNode.data.references ?? []).filter((reference) =>
        reference.outputType === 'image' || reference.outputType === 'video' || reference.outputType === 'audio',
      );
      const shotReference: NodeReference = {
        nodeId: `${storyboardNodeId}:shot:${shot.shotNumber}`,
        title: `分镜 ${String(shot.shotNumber).padStart(2, '0')}`,
        kind: 'storyboard',
        outputType: 'text',
        source: 'canvas',
        content: storyboardShotToText(shot),
      };
      const node: StudioNode = {
        ...child,
        selected: true,
        data: {
          ...child.data,
          title: `镜头 ${String(shot.shotNumber).padStart(2, '0')} · ${kind === 'image' ? '图像' : '视频'}`,
          prompt: kind === 'image' ? shot.imagePrompt : shot.videoPrompt,
          references: [shotReference, ...mediaReferences],
        },
      };
      const project = updateActiveCanvas(state.project, (canvas) => ({
        ...canvas,
        nodes: [...canvas.nodes.map((item) => ({ ...item, selected: false })), node],
        edges: [...canvas.edges, edgeFor(storyboardNodeId, node.id)],
      }));
      return {
        project,
        activeCanvas: activeCanvasOf(project),
        selectedNodeId: node.id,
        selectedNodeIds: [node.id],
        selectedGroupId: '',
        referenceSelectionIds: [],
        addPanelOpen: false,
        quickPanelOpen: false,
        lastSavedAt: saveProject(project),
      };
    });
  },

  runNode: async (nodeId) => {
    const canvas = get().activeCanvas;
    const node = canvas.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const references = hydrateNodeReferences(node, canvas.nodes);
    if (node.data.kind === 'storyboard') {
      const emptyTextReference = references.find(
        (reference) => reference.outputType === 'text' && !reference.content?.trim(),
      );
      if (emptyTextReference) {
        get().updateNodeData(nodeId, {
          status: 'error',
          progress: 0,
          error: `引用的文本节点“${emptyTextReference.title}”尚未生成正文。`,
        });
        return;
      }
    }
    prepareCompletionFeedback();
    get().updateNodeData(nodeId, { status: 'running', progress: 3, error: '', outputs: {} });
    try {
      let job = await generationClient.createJob({
        nodeId,
        node: { ...node.data, references },
      });
      get().updateNodeData(nodeId, {
        progress: job.progress,
        provider: job.provider,
        model: job.model,
        lastJobId: job.id,
      });

      while (job.status === 'queued' || job.status === 'running') {
        await pause(900);
        job = await generationClient.getJob(job.id);
        get().updateNodeData(nodeId, {
          status: 'running',
          progress: Math.max(3, Math.min(99, job.progress)),
          provider: job.provider,
          model: job.model,
          lastJobId: job.id,
        });
      }

      if (job.status === 'success') {
        get().updateNodeData(nodeId, {
          status: 'success',
          progress: 100,
          outputs: job.result ?? {},
          provider: job.provider,
          model: job.model,
          lastJobId: job.id,
        });
        notifyGenerationComplete(node.data.title, node.data.kind);
        return;
      }

      throw new Error(job.error || '生成任务失败');
    } catch (error) {
      get().updateNodeData(nodeId, {
        status: 'error',
        progress: 0,
        error: readableGenerationError(error),
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
            groups: [],
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
      selectedNodeIds: [],
      selectedGroupId: '',
      referenceSelectionIds: [],
      addPanelOpen: false,
      quickPanelOpen: false,
      lastSavedAt: project.updatedAt,
    });
  },
}));

export const nodePresets = presets;
