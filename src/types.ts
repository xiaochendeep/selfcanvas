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

export interface NodeOutput {
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  fileUrl?: string;
  assetName?: string;
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
  error?: string;
}

export type StudioNode = Node<StudioNodeData, 'studioNode'>;
export type StudioEdge = Edge<Record<string, unknown>>;

export interface StudioCanvas {
  id: string;
  name: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
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
  kind: NodeKind;
  provider: string;
  model: string;
  status: GenerationJobStatus;
  progress: number;
  prompt: string;
  inputs: string[];
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
