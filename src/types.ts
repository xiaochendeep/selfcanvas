import type { Edge, Node, Viewport } from '@xyflow/react';

export type NodeKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'stage3d'
  | 'panorama'
  | 'storyboard'
  | 'collage'
  | 'asset'
  | 'upload';
export type RunStatus = 'idle' | 'running' | 'success' | 'error';
export type GenerationJobStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export interface StoryboardShot {
  shotNumber: number;
  shotSize: string;
  visualDescription: string;
  cameraMovement: string;
  imagePrompt: string;
  videoPrompt: string;
}

export interface StoryboardDocument {
  version: 1;
  shotCount: number;
  shots: StoryboardShot[];
}

export interface NodeOutput {
  text?: string;
  storyboard?: StoryboardDocument;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  fileUrl?: string;
  assetName?: string;
}

export type ImportedMediaType = 'image' | 'video' | 'audio';

export interface ImportedMedia {
  id: string;
  name: string;
  type: ImportedMediaType;
  mimeType: string;
  size: number;
  url: string;
  path: string;
}

export type ProviderOptionValue = string | number | boolean;

export interface ProviderOptions {
  providerTool?: string;
  model?: string;
  mode?: string;
  size?: string;
  count?: number;
  referenceQuality?: string;
  outputFormat?: string;
  transparentBackground?: boolean;
  quality?: string;
  resolutionTier?: string;
  temperature?: number;
  responseFormat?: string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  generateAudio?: boolean;
  fps?: number;
  format?: string;
  multiShot?: boolean;
  shotCount?: number;
  promptMode?: 'image' | 'video';
  viewMode?: 'list' | 'card';
  style?: string;
  voiceReference?: string;
  targetVoice?: string;
  voiceMode?: string;
  systemPrompt?: string;
}

export interface NodeReference {
  nodeId: string;
  title: string;
  kind: NodeKind | GeneratedFileType;
  outputType: GeneratedFileType | 'text';
  source: 'canvas' | 'output' | 'group';
  groupId?: string;
  url?: string;
  path?: string;
  thumbnailUrl?: string;
  content?: string;
}

export interface StudioNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  prompt: string;
  status: RunStatus;
  progress: number;
  provider: string;
  model: string;
  inputs: string[];
  outputs: NodeOutput;
  references?: NodeReference[];
  providerOptions?: ProviderOptions;
  importedMedia?: ImportedMedia;
  uiRelation?: 'related' | 'dimmed';
  lastJobId?: string;
  error?: string;
}

export type StudioNode = Node<StudioNodeData, 'studioNode'>;
export type StudioEdge = Edge<Record<string, unknown>>;

export interface CanvasGroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasGroup {
  id: string;
  name: string;
  nodeIds: string[];
  bounds: CanvasGroupBounds;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioCanvas {
  id: string;
  name: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  groups: CanvasGroup[];
  viewport: Viewport;
}

export interface StudioProject {
  id: string;
  name: string;
  canvases: StudioCanvas[];
  activeCanvasId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioTask {
  id: string;
  nodeId: string;
  kind: NodeKind;
  status: RunStatus;
  progress: number;
  logs: string[];
  result?: NodeOutput;
  error?: string;
}

export interface GenerationJob {
  id: string;
  nodeId: string;
  targetNodeId?: string;
  kind: NodeKind;
  provider: string;
  model: string;
  status: GenerationJobStatus;
  progress: number;
  prompt: string;
  inputs: string[];
  references?: NodeReference[];
  options?: ProviderOptions;
  result?: NodeOutput;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type GeneratedFileType = 'image' | 'video' | 'audio' | 'other';

export interface GeneratedFile {
  id: string;
  title: string;
  type: GeneratedFileType;
  url: string;
  path: string;
  size: number;
  createdAt: string;
}

export type DesktopTaskStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export interface DesktopTask {
  id: string;
  title: string;
  status: DesktopTaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  message?: string;
  error?: string;
}

export interface DesktopTaskCapability {
  available: boolean;
  reason?: string;
}

export interface DesktopTaskProvider {
  getCapability: () => Promise<DesktopTaskCapability>;
  listTasks: () => Promise<DesktopTask[]>;
  cancelTask?: (taskId: string) => Promise<void>;
}

export interface NodePreset {
  kind: NodeKind;
  title: string;
  prompt: string;
  model: string;
  provider: string;
  width: number;
  height: number;
}
