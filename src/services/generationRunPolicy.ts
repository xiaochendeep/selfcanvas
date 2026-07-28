import type { ProjectSyncStatus } from './projectRepository';

export function isMissingCanvasNodeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /节点不存在/.test(message);
}

export function generationSyncError(status: ProjectSyncStatus) {
  if (status === 'synced') return '';
  if (status === 'conflict') return '画布存在同步冲突，请刷新页面确认最新内容后再生成。';
  if (status === 'offline') return '节点尚未同步到服务器，未开始生成。请检查本机服务后重试。';
  return '画布仍在同步，节点尚未保存；请稍后重试。';
}
