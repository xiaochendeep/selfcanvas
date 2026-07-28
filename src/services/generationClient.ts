import type { GeneratedFile, GenerationJob } from '../types';
import { browserApiFetch } from './browserSession';

interface CreateGenerationJobInput {
  canvasId: string;
  nodeId: string;
  baseRevision: number;
  requestId: string;
}

interface ManagedGenerationJobResponse {
  projectId: string;
  canvasId: string;
  nodeId: string;
  revision: number;
  requestId: string;
  job: GenerationJob;
}

export type FileExportStatus = 'queued' | 'running' | 'success' | 'ready' | 'error' | 'canceled';

export interface FileExportJob {
  id: string;
  status: FileExportStatus;
  progress?: number;
  downloadUrl?: string;
  error?: string;
  file?: {
    url?: string;
    downloadUrl?: string;
  };
  result?: {
    url?: string;
    downloadUrl?: string;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await browserApiFetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const errorValue = data && typeof data === 'object' && 'error' in data
      ? (data as { error?: unknown }).error
      : undefined;
    const message = typeof errorValue === 'object' && errorValue && 'message' in errorValue
      ? String((errorValue as { message?: unknown }).message)
      : errorValue !== undefined
        ? String(errorValue)
        : response.statusText;
    throw new Error(message || `请求失败：${response.status}`);
  }
  return data as T;
}

export const generationClient = {
  createJob(input: CreateGenerationJobInput) {
    return request<ManagedGenerationJobResponse>(
      `/api/v2/canvases/${encodeURIComponent(input.canvasId)}/nodes/${encodeURIComponent(input.nodeId)}/run`,
      {
      method: 'POST',
        body: JSON.stringify({ baseRevision: input.baseRevision, requestId: input.requestId }),
      },
    );
  },

  getJob(jobId: string) {
    return request<GenerationJob>(`/api/generation/jobs/${encodeURIComponent(jobId)}`);
  },

  listJobs() {
    return request<GenerationJob[]>('/api/generation/jobs');
  },

  listFiles() {
    return request<GeneratedFile[]>('/api/files');
  },

  createExport(fileIds: string[]) {
    return request<FileExportJob>('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    });
  },

  getExport(exportId: string) {
    return request<FileExportJob>(`/api/exports/${encodeURIComponent(exportId)}`);
  },
};
