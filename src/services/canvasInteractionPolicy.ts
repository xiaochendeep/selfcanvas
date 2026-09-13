import type { ProjectSyncStatus } from './projectRepository';

export function canvasShortcutBlocked(context: {
  defaultPrevented?: boolean; composing?: boolean; interactiveTarget?: boolean;
  overlayOpen?: boolean; textSelected?: boolean;
}) {
  return Boolean(context.defaultPrevented || context.composing || context.interactiveTarget || context.overlayOpen || context.textSelected);
}

/** flush() may resolve without syncing when offline or in a CAS conflict. */
export async function saveCanvasFeedback(flush: () => Promise<void>, getStatus: () => ProjectSyncStatus): Promise<{ message: string; tone: 'success' | 'error' | 'info' }> {
  try {
    await flush();
    if (getStatus() === 'synced') return { message: '画布已保存到服务器。', tone: 'success' };
    if (getStatus() === 'conflict') return { message: '存在同步冲突，尚未保存到服务器；请先处理顶部的冲突提示。', tone: 'error' };
    return { message: '画布尚未同步到服务器，请检查连接与顶部保存状态。', tone: 'info' };
  } catch {
    return { message: '保存到服务器失败，请检查连接后重试；未覆盖服务器画布。', tone: 'error' };
  }
}
