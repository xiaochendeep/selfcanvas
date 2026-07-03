import type { GeneratedFile, GenerationJob, NodeKind, StudioNodeData } from '../types';

interface CreateGenerationJobInput {
  nodeId: string;
  node: StudioNodeData;
}

interface CreateGenerationJobPayload {
  nodeId: string;
  kind: NodeKind;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  inputs: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data ? String((data as { error?: unknown }).error) : response.statusText;
    throw new Error(message || `请求失败：${response.status}`);
  }
  return data as T;
}

export const generationClient = {
  createJob(input: CreateGenerationJobInput) {
    const payload: CreateGenerationJobPayload = {
      nodeId: input.nodeId,
      kind: input.node.kind,
      title: input.node.title,
      prompt: input.node.prompt,
      provider: input.node.provider,
      model: input.node.model,
      inputs: input.node.inputs,
    };
    return request<GenerationJob>('/api/generation/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
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
};
