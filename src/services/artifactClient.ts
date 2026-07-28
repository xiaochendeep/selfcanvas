import type { GeneratedFile, GeneratedFileType, MediaArtifact, StudioCanvas, StudioNode } from '../types';

type DownloadableGeneratedFile = GeneratedFile & {
  downloadUrl?: string;
  name?: string;
  previewUrl?: string;
};

export interface CanvasMediaFile extends GeneratedFile {
  artifactId?: string;
  canvasId?: string;
  canvasName?: string;
  nodeId?: string;
  nodeTitle?: string;
  source: 'canvas' | 'output';
}

type ImportedMediaArtifact = NonNullable<StudioNode['data']['importedMedia']> & {
  artifact?: MediaArtifact;
  createdAt?: string;
  downloadUrl?: string;
  previewUrl?: string;
};

const mediaOutputKeys: Array<{ type: Exclude<GeneratedFileType, 'other'>; key: 'imageUrl' | 'videoUrl' | 'audioUrl' }> = [
  { type: 'image', key: 'imageUrl' },
  { type: 'video', key: 'videoUrl' },
  { type: 'audio', key: 'audioUrl' },
];

function controlledArtifactId(value: string | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized && !normalized.startsWith('pending:') ? normalized : undefined;
}

function comparableUrl(value: string | undefined) {
  if (!value) return '';
  try {
    const url = new URL(value, window.location.href);
    return `${decodeURIComponent(url.pathname)}${url.search}`;
  } catch {
    return value.trim();
  }
}

function comparableName(value: string | undefined) {
  if (!value) return '';
  const tail = value.split(/[\\/]/).pop() ?? value;
  try {
    return decodeURIComponent(tail).toLocaleLowerCase();
  } catch {
    return tail.toLocaleLowerCase();
  }
}

function outputMedia(node: StudioNode) {
  const importedMedia = node.data.importedMedia as ImportedMediaArtifact | undefined;
  const outputArtifact = node.data.outputs?.artifact;
  const artifact = outputArtifact ?? importedMedia?.artifact;
  const outputEntry = mediaOutputKeys.find(({ key }) => Boolean(node.data.outputs?.[key]));
  const artifactType = artifact?.type === 'image' || artifact?.type === 'video' || artifact?.type === 'audio'
    ? artifact.type
    : undefined;
  const type = importedMedia?.type ?? artifactType ?? outputEntry?.type;
  if (!type) return null;

  const typedOutputUrl = outputEntry ? String(node.data.outputs?.[outputEntry.key] ?? '') : '';
  const previewUrl = artifact?.previewUrl || importedMedia?.previewUrl || importedMedia?.url || typedOutputUrl || node.data.outputs?.fileUrl || '';
  if (!previewUrl) return null;

  const artifactId = controlledArtifactId(artifact?.id) ?? controlledArtifactId(importedMedia?.id);
  const downloadUrl = artifact?.downloadUrl || importedMedia?.downloadUrl || (artifactId ? `/api/files/download/${encodeURIComponent(artifactId)}` : '');
  return {
    artifactId,
    createdAt: importedMedia?.createdAt,
    downloadUrl,
    mimeType: artifact?.mimeType || importedMedia?.mimeType,
    name: artifact?.name || importedMedia?.name || node.data.outputs?.assetName,
    previewUrl,
    size: Number(artifact?.size ?? importedMedia?.size ?? 0),
    type,
  };
}

/** Build an immediately searchable media index from the canvas itself. */
export function canvasMediaFiles(canvas: StudioCanvas): CanvasMediaFile[] {
  return canvas.nodes.flatMap((node) => {
    const media = outputMedia(node);
    if (!media) return [];
    const title = media.name || node.data.outputs?.assetName || node.data.title;
    return [{
      id: media.artifactId || `canvas:${canvas.id}:node:${node.id}`,
      artifactId: media.artifactId,
      title,
      type: media.type,
      url: media.previewUrl,
      size: media.size,
      createdAt: media.createdAt || canvas.updatedAt,
      mimeType: media.mimeType,
      previewUrl: media.previewUrl,
      downloadUrl: media.downloadUrl,
      canvasId: canvas.id,
      canvasName: canvas.name,
      nodeId: node.id,
      nodeTitle: node.data.title,
      source: 'canvas' as const,
    }];
  });
}

function fileMatchesCanvasMedia(file: GeneratedFile, canvasFile: CanvasMediaFile) {
  if (canvasFile.artifactId && file.id === canvasFile.artifactId) return true;
  const fileUrls = [file.url, file.previewUrl, file.downloadUrl].map(comparableUrl).filter(Boolean);
  const canvasUrls = [canvasFile.url, canvasFile.previewUrl, canvasFile.downloadUrl].map(comparableUrl).filter(Boolean);
  if (fileUrls.some((value) => canvasUrls.includes(value))) return true;
  const fileName = comparableName((file as DownloadableGeneratedFile).name || file.title || file.url);
  const canvasName = comparableName(canvasFile.title || canvasFile.url);
  return Boolean(fileName && canvasName && fileName === canvasName && (!file.size || !canvasFile.size || file.size === canvasFile.size));
}

/**
 * Reconcile the server's opaque artifacts with node outputs. Canvas-owned entries
 * stay available even while /api/files is refreshing or a remote result has not
 * been copied locally yet.
 */
export function mergeCanvasMediaFiles(canvas: StudioCanvas, files: GeneratedFile[]): CanvasMediaFile[] {
  const canvasFiles = canvasMediaFiles(canvas);
  return canvasFiles.map((canvasFile) => {
    const file = files.find((candidate) => fileMatchesCanvasMedia(candidate, canvasFile));
    if (!file) return canvasFile;
    return {
      ...canvasFile,
      ...file,
      artifactId: file.id,
      canvasId: canvasFile.canvasId,
      canvasName: canvasFile.canvasName,
      nodeId: canvasFile.nodeId,
      nodeTitle: canvasFile.nodeTitle,
      source: 'canvas' as const,
      previewUrl: generatedFilePreviewUrl(file) || canvasFile.previewUrl,
      downloadUrl: generatedFileDownloadUrl(file) || canvasFile.downloadUrl,
    };
  });
}

/** Add current-canvas node links to the global output-folder listing. */
export function linkOutputFilesToCanvas(canvas: StudioCanvas, files: GeneratedFile[]): CanvasMediaFile[] {
  const canvasFiles = canvasMediaFiles(canvas);
  return files.map((file) => {
    const canvasFile = canvasFiles.find((candidate) => fileMatchesCanvasMedia(file, candidate));
    return {
      ...file,
      artifactId: file.id,
      canvasId: canvasFile?.canvasId,
      canvasName: canvasFile?.canvasName,
      nodeId: canvasFile?.nodeId,
      nodeTitle: canvasFile?.nodeTitle,
      source: canvasFile ? 'canvas' as const : 'output' as const,
    };
  });
}

export function generatedFilePreviewUrl(file: GeneratedFile) {
  const downloadableFile = file as DownloadableGeneratedFile;
  return downloadableFile.previewUrl || file.url || '';
}

export function generatedFileDownloadUrl(file: GeneratedFile) {
  const downloadableFile = file as DownloadableGeneratedFile;
  return downloadableFile.downloadUrl || file.url || '';
}

export function generatedFileDownloadName(file: GeneratedFile) {
  const downloadableFile = file as DownloadableGeneratedFile;
  if (downloadableFile.name) return downloadableFile.name;
  const currentIdName = file.id.split('/').pop();
  if (currentIdName && currentIdName.includes('.')) {
    try {
      return decodeURIComponent(currentIdName);
    } catch {
      return currentIdName;
    }
  }
  return file.title || 'SelfCanvas-media';
}

export function isLocallyDownloadableUrl(value: string | undefined) {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('blob:') || value.startsWith('data:')) return true;
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function triggerMediaDownload(url: string, filename?: string) {
  if (!isLocallyDownloadableUrl(url)) return false;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename?.trim() || '';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
