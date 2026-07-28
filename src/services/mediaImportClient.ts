import type { ImportedMedia, ImportedMediaType } from '../types';
import { browserCsrfToken } from './browserSession';

const mediaExtensions: Record<ImportedMediaType, Set<string>> = {
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v']),
  audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']),
};

const imageExtensionByMime: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const mediaFileAccept = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
].join(',');

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function clipboardImageFile(file: File, index: number) {
  const extension = imageExtensionByMime[file.type] ?? (extensionOf(file.name) || 'png');
  const currentExtension = extensionOf(file.name);
  const genericName = !file.name || file.name === 'image' || file.name.startsWith('blob');
  const name = genericName || !currentExtension
    ? `clipboard-${Date.now()}-${index + 1}.${extension}`
    : file.name;
  return new File([file], name, {
    type: file.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    lastModified: Date.now(),
  });
}

async function imageFileFromSource(source: string, index: number) {
  if (!source.startsWith('data:image/') && !/^https?:\/\//i.test(source)) return null;
  try {
    const response = await fetch(source, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size <= 0) return null;
    return clipboardImageFile(new File([blob], '', { type: blob.type }), index);
  } catch {
    return null;
  }
}

export async function imageFilesFromClipboard(clipboardData: DataTransfer) {
  const directFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && file.size > 0));
  const fallbackFiles = Array.from(clipboardData.files).filter((file) => file.type.startsWith('image/') && file.size > 0);
  const files = directFiles.length ? directFiles : fallbackFiles;
  if (files.length) return files.map(clipboardImageFile);

  const html = clipboardData.getData('text/html');
  const sources = html
    ? Array.from(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img[src]'))
        .map((image) => image.getAttribute('src')?.trim() ?? '')
        .filter(Boolean)
    : [];
  const uriList = clipboardData.getData('text/uri-list').split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !item.startsWith('#'));
  const uniqueSources = Array.from(new Set([...sources, ...uriList])).slice(0, 24);
  const imported = await Promise.all(uniqueSources.map(imageFileFromSource));
  return imported.filter((file): file is File => Boolean(file));
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
    void browserCsrfToken().then((csrfToken) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.responseType = 'json';
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-SelfCanvas-CSRF', csrfToken);
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
    }).catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}
