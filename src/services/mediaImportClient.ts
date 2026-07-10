import type { ImportedMedia, ImportedMediaType } from '../types';

const mediaExtensions: Record<ImportedMediaType, Set<string>> = {
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v']),
  audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']),
};

export const mediaFileAccept = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
].join(',');

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function classifyMediaFile(file: File): ImportedMediaType | null {
  const extension = extensionOf(file.name);
  return (Object.entries(mediaExtensions) as Array<[ImportedMediaType, Set<string>]>).find(([, extensions]) =>
    extensions.has(extension),
  )?.[0] ?? null;
}

function responseError(xhr: XMLHttpRequest) {
  const payload = xhr.response as { error?: unknown } | string | null;
  if (payload && typeof payload === 'object' && payload.error) return String(payload.error);
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as { error?: unknown };
      if (parsed.error) return String(parsed.error);
    } catch {
      if (payload.trim()) return payload.trim();
    }
  }
  return xhr.statusText || `HTTP ${xhr.status}`;
}

export function uploadMediaFile(file: File, onProgress?: (progress: number) => void): Promise<ImportedMedia> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ImportedMedia);
        return;
      }
      reject(new Error(responseError(xhr)));
    });
    xhr.addEventListener('error', () => reject(new Error('本地文件服务不可用，请确认后端已启动。')));
    xhr.addEventListener('abort', () => reject(new Error('文件导入已取消。')));
    xhr.send(file);
  });
}
