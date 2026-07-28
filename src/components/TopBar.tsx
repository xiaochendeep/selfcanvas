import { Check, ChevronDown, CircleDot, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { projectRepository, type ProjectSyncStatus } from '../services/projectRepository';
import { useCanvasStore } from '../store/canvasStore';
import type { NodeKind, StudioCanvas } from '../types';

const kindLabels: Record<NodeKind, string> = {
  text: '文本',
  storyboard: '分镜',
  image: '图片',
  collage: '拼图',
  video: '视频',
  audio: '音频',
  asset: '素材',
  upload: '素材',
  stage3d: '3D',
  panorama: '全景',
};

const kindOrder: NodeKind[] = [
  'text',
  'storyboard',
  'image',
  'collage',
  'video',
  'audio',
  'asset',
  'upload',
  'stage3d',
  'panorama',
];

const genericNodeTitles = new Set([
  '生成文本',
  '生成图像',
  '生成视频',
  '生成音频',
  '图片',
  '视频',
  '音频',
  '素材',
  '素材节点',
]);

function subscribeSyncStatus(listener: () => void) {
  return projectRepository.subscribeStatus(() => listener());
}

function getSyncStatus() {
  return projectRepository.getSyncStatus();
}

function truncate(value: string, length = 46) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= length) return normalized;
  return `${normalized.slice(0, length)}…`;
}

function canvasContent(canvas: StudioCanvas) {
  const promptNode = canvas.nodes.find(
    (node) => (node.data.kind === 'text' || node.data.kind === 'storyboard') && node.data.prompt.trim(),
  ) ?? canvas.nodes.find((node) => node.data.prompt.trim());
  const prompt = truncate(promptNode?.data.prompt ?? '');
  if (prompt) return prompt;

  const outputNode = canvas.nodes.find((node) => String(node.data.outputs?.text ?? '').trim());
  const output = truncate(String(outputNode?.data.outputs?.text ?? ''));
  if (output) return output;

  const namedNode = canvas.nodes.find((node) => {
    const title = node.data.title.trim();
    return title && !genericNodeTitles.has(title);
  });
  return truncate(namedNode?.data.title ?? '') || '尚无内容';
}

function canvasTypeSummary(canvas: StudioCanvas) {
  if (!canvas.nodes.length) return '空白画布';
  const counts = new Map<NodeKind, number>();
  canvas.nodes.forEach((node) => counts.set(node.data.kind, (counts.get(node.data.kind) ?? 0) + 1));

  const entries = kindOrder
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
  const visible = entries.slice(0, 4);
  const hiddenCount = entries.slice(4).reduce((total, entry) => total + entry.count, 0);
  const details = visible.map(({ kind, count }) => `${kindLabels[kind]} ${count}`).join(' · ');
  return `${canvas.nodes.length} 个节点${details ? ` · ${details}` : ''}${hiddenCount ? ` · 其他 ${hiddenCount}` : ''}`;
}

function formatCanvasTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚更新';
  const now = new Date();
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  if (elapsed < 60_000) return '刚刚更新';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function syncLabel(status: ProjectSyncStatus, savedAt: string) {
  const savedTime = new Date(savedAt);
  const time = Number.isNaN(savedTime.getTime())
    ? ''
    : savedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (status === 'syncing') return '正在同步画布…';
  if (status === 'synced') return `已同步${time ? ` ${time}` : ''}`;
  if (status === 'offline') return `离线 · 本机已保存${time ? ` ${time}` : ''}`;
  if (status === 'conflict') return '同步冲突 · 请选择处理';
  return `仅本机保存${time ? ` ${time}` : ''}`;
}

export function TopBar() {
  const project = useCanvasStore((state) => state.project);
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const createCanvas = useCanvasStore((state) => state.createCanvas);
  const switchCanvas = useCanvasStore((state) => state.switchCanvas);
  const renameCanvas = useCanvasStore((state) => state.renameCanvas);
  const resetProject = useCanvasStore((state) => state.resetProject);
  const resolveSyncConflict = useCanvasStore((state) => state.resolveSyncConflict);
  const lastSavedAt = useCanvasStore((state) => state.lastSavedAt);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [editingCanvasId, setEditingCanvasId] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const recordsRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const savedAt = lastSavedAt || project.updatedAt;
  const statusText = syncLabel(syncStatus, savedAt);

  const records = useMemo(
    () => project.canvases.map((canvas) => ({
      canvas,
      content: canvasContent(canvas),
      summary: canvasTypeSummary(canvas),
      updated: formatCanvasTime(canvas.updatedAt || project.updatedAt),
    })),
    [project.canvases, project.updatedAt],
  );

  useEffect(() => {
    if (!recordsOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!recordsRef.current?.contains(event.target as Node)) {
        setRecordsOpen(false);
        setEditingCanvasId('');
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editingCanvasId) {
        setEditingCanvasId('');
        return;
      }
      setRecordsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [editingCanvasId, recordsOpen]);

  useEffect(() => {
    if (!editingCanvasId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingCanvasId]);

  const beginRename = (canvas: StudioCanvas) => {
    setEditingCanvasId(canvas.id);
    setNameDraft(canvas.name);
  };

  const cancelRename = () => {
    setEditingCanvasId('');
    setNameDraft('');
  };

  const commitRename = () => {
    if (!editingCanvasId) return;
    const nextName = nameDraft.trim();
    const currentCanvas = project.canvases.find((canvas) => canvas.id === editingCanvasId);
    if (nextName && nextName !== currentCanvas?.name) renameCanvas(editingCanvasId, nextName);
    cancelRename();
  };

  const handleCreateCanvas = () => {
    createCanvas();
    const createdCanvas = useCanvasStore.getState().activeCanvas;
    setRecordsOpen(true);
    beginRename(createdCanvas);
  };

  const handleResetProject = () => {
    const confirmed = window.confirm(
      `确定重置整个项目吗？\n\n这会清空 ${project.canvases.length} 个画布，并同步到其他浏览器。此操作无法撤销。`,
    );
    if (!confirmed) return;
    setRecordsOpen(false);
    cancelRename();
    resetProject();
  };

  const handleResolveConflict = async () => {
    if (resolvingConflict) return;
    const confirmed = window.confirm(
      '服务器画布已被另一浏览器更新。\n\n继续后会先下载当前本机画布的 JSON 备份，再加载服务器版本；不会覆盖服务器内容。',
    );
    if (!confirmed) return;
    const backup = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(backup);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `SelfCanvas-冲突备份-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setResolvingConflict(true);
    const resolved = await resolveSyncConflict();
    setResolvingConflict(false);
    if (!resolved) window.alert('服务器版本加载失败，请检查网络后重试；本机内容仍保留。');
  };

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark">
          <CircleDot size={23} />
        </div>
        <span>SelfCanvas</span>
      </div>
      <div className="canvas-tabs" ref={recordsRef} aria-label="画布分页">
        <button
          className={`canvas-tab is-active ${recordsOpen ? 'is-open' : ''}`}
          type="button"
          onClick={() => setRecordsOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={recordsOpen}
          aria-controls="canvas-record-popover"
        >
          <span className="canvas-tab-name">{activeCanvas.name}</span>
          <span className="canvas-tab-count">{activeCanvas.nodes.length}</span>
          <ChevronDown className="canvas-tab-chevron" size={15} aria-hidden="true" />
        </button>
        <button className="canvas-tab-add" type="button" onClick={handleCreateCanvas} title="新建画布" aria-label="新建画布">
          <Plus size={16} />
        </button>

        {recordsOpen && (
          <section className="canvas-record-popover" id="canvas-record-popover" role="dialog" aria-label="画布记录">
            <header className="canvas-record-header">
              <div>
                <strong>画布记录</strong>
                <span>{project.canvases.length} 个画布</span>
              </div>
              <button type="button" onClick={handleCreateCanvas} aria-label="新建画布" title="新建画布">
                <Plus size={17} />
              </button>
            </header>
            <div className="canvas-record-list">
              {records.map(({ canvas, content, summary, updated }) => {
                const active = canvas.id === activeCanvas.id;
                const editing = canvas.id === editingCanvasId;
                return (
                  <div className={`canvas-record-row ${active ? 'is-active' : ''}`} key={canvas.id}>
                    {editing ? (
                      <form
                        className="canvas-record-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitRename();
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          value={nameDraft}
                          maxLength={40}
                          aria-label="画布名称"
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            event.preventDefault();
                            event.stopPropagation();
                            cancelRename();
                          }}
                          onBlur={(event) => {
                            const form = event.currentTarget.form;
                            const nextTarget = event.relatedTarget;
                            if (form && nextTarget instanceof Node && form.contains(nextTarget)) return;
                            commitRename();
                          }}
                        />
                        <button className="canvas-record-confirm" type="submit" aria-label="保存名称" title="保存名称">
                          <Check size={16} />
                        </button>
                        <button className="canvas-record-cancel" type="button" onClick={cancelRename} aria-label="取消重命名" title="取消">
                          <X size={16} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          className="canvas-record-select"
                          type="button"
                          onClick={() => {
                            switchCanvas(canvas.id);
                            setRecordsOpen(false);
                          }}
                          aria-current={active ? 'page' : undefined}
                        >
                          <span className="canvas-record-name-line">
                            <strong title={canvas.name}>{canvas.name}</strong>
                            {active && (
                              <span className="canvas-record-active">
                                <Check size={12} />
                                当前
                              </span>
                            )}
                          </span>
                          <span className="canvas-record-content" title={content}>{content}</span>
                          <span className="canvas-record-meta">
                            <span>{summary}</span>
                            <time dateTime={canvas.updatedAt}>{updated}</time>
                          </span>
                        </button>
                        <button
                          className="canvas-record-edit"
                          type="button"
                          onClick={() => beginRename(canvas)}
                          aria-label={`重命名 ${canvas.name}`}
                          title="重命名"
                        >
                          <Pencil size={15} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
      <div className="topbar-spacer" />
      <div className={`status-pill is-${syncStatus}`} title={statusText} aria-live="polite">
        <span className="status-dot" />
        {statusText}
      </div>
      {syncStatus === 'conflict' && (
        <button
          className="conflict-resolve-action"
          type="button"
          onClick={() => void handleResolveConflict()}
          disabled={resolvingConflict}
        >
          {resolvingConflict ? '正在加载…' : '备份本机并加载服务器版本'}
        </button>
      )}
      <button className="ghost-action" type="button" onClick={handleResetProject} title="重置整个项目">
        <RotateCcw size={16} />
      </button>
      <div className="version-badge">V 0.1.0</div>
    </header>
  );
}
