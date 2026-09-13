import type { CanvasMediaFile } from './artifactClient';
import type { GeneratedFile } from '../types';

export type AssetOrigin = 'imported' | 'generated' | 'output';
export type AssetScope = 'current' | 'project' | 'output';
export type AssetSort = 'newest' | 'oldest' | 'name' | 'size';
export const MAX_ASSET_EXPORT_FILES = 200;

export function assetEmptyState(scope: AssetScope, hasFilters: boolean, loading: boolean, failed: boolean) {
  if (loading) return { title: '正在读取素材', detail: '画布素材和生成结果会显示在这里', pending: true, failed: false };
  if (failed) return { title: scope === 'output' ? '输出文件列表暂不可用' : '素材列表尚未同步', detail: '当前无法确认是否有其他文件，请检查连接后重试。已有画布数据不会被清空。', pending: false, failed: true };
  return {
    title: hasFilters ? '没有找到匹配的素材' : scope === 'current' ? '这个画布还没有素材' : '暂无媒体文件',
    detail: hasFilters ? '试试其他关键词，或切换到全部画布' : '将图片、视频或音频拖入画布，生成结果也会自动收录',
    pending: false, failed: false,
  };
}

export function parseAssetFileList(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value) || value.some((file) => !file || typeof file.id !== 'string' || !file.id || typeof file.title !== 'string' || typeof file.url !== 'string' || !['image', 'video', 'audio', 'other'].includes(file.type))) {
    throw new Error('文件列表格式异常，请刷新后重试');
  }
  return value;
}

export function safeAssetPreviewUrl(value: string): string {
  const url = value.trim();
  if (/^\/(?!\/)/.test(url) && !url.includes('\\')) return url;
  if (/^(?:https?:\/\/|blob:)/i.test(url)) return url;
  if (/^data:(?:image|audio|video)\/[a-z0-9.+-]+;/i.test(url)) return url;
  return '';
}

export interface AssetLocation {
  canvasId: string;
  canvasName: string;
  nodeId: string;
  nodeTitle: string;
}

export interface BrowserAsset extends CanvasMediaFile {
  key: string;
  locations: AssetLocation[];
  origins: AssetOrigin[];
  inOutputFolder: boolean;
}

/** One card per file, with every canvas location preserved for lookup. */
export function buildAssetBrowserIndex(
  canvasFiles: Array<CanvasMediaFile & { origin: AssetOrigin }>,
  outputFiles: GeneratedFile[],
  activeCanvasId: string,
): BrowserAsset[] {
  const index = new Map<string, BrowserAsset>();
  const keyOf = (file: GeneratedFile & { artifactId?: string }) =>
    file.artifactId ? `artifact:${file.artifactId}` : `media:${file.previewUrl || file.url || file.id}`;

  outputFiles.forEach((file) => {
    const key = `artifact:${file.id}`;
    index.set(key, {
      ...file, key, artifactId: file.id, source: 'output', locations: [], origins: [], inOutputFolder: true,
    });
  });

  canvasFiles.forEach((file) => {
    const key = keyOf(file);
    const existing = index.get(key);
    const location = file.nodeId && file.canvasId ? {
      canvasId: file.canvasId,
      canvasName: file.canvasName || '未命名画布',
      nodeId: file.nodeId,
      nodeTitle: file.nodeTitle || file.title,
    } : null;
    const locations = [...(existing?.locations ?? [])];
    if (location && !locations.some((item) => item.canvasId === location.canvasId && item.nodeId === location.nodeId)) {
      locations.push(location);
    }
    const origins = [...new Set([...(existing?.origins ?? []), file.origin])];
    const primary = locations.find((item) => item.canvasId === activeCanvasId) ?? locations[0];
    index.set(key, {
      ...file,
      ...existing,
      key,
      source: 'canvas',
      locations,
      origins,
      inOutputFolder: existing?.inOutputFolder ?? false,
      canvasId: primary?.canvasId,
      canvasName: primary?.canvasName,
      nodeId: primary?.nodeId,
      nodeTitle: primary?.nodeTitle,
    });
  });

  return Array.from(index.values()).map((file) => ({
    ...file,
    origins: file.origins.length ? file.origins : ['output'],
  }));
}

export function scopeAssets(files: BrowserAsset[], scope: AssetScope, canvasId: string) {
  return files.filter((file) => scope === 'current'
    ? file.locations.some((location) => location.canvasId === canvasId)
    : scope === 'project' ? file.locations.length > 0 : file.inOutputFolder);
}

export function searchAssets(files: BrowserAsset[], query: string, origin: 'all' | AssetOrigin) {
  const needle = query.trim().toLocaleLowerCase();
  return files.filter((file) => {
    if (origin !== 'all' && !file.origins.includes(origin)) return false;
    if (!needle) return true;
    return [file.title, file.type, file.mimeType, ...file.locations.flatMap((item) => [item.nodeTitle, item.canvasName])]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(needle));
  });
}

export function sortAssets(files: BrowserAsset[], sort: AssetSort) {
  const timestamp = (value: string) => Date.parse(value) || 0;
  return [...files].sort((a, b) => {
    if (sort === 'name') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN', { numeric: true });
    if (sort === 'size') return (Number.isFinite(b.size) ? b.size : 0) - (Number.isFinite(a.size) ? a.size : 0);
    return sort === 'oldest' ? timestamp(a.createdAt) - timestamp(b.createdAt) : timestamp(b.createdAt) - timestamp(a.createdAt);
  });
}

export function formatAssetSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '大小未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
