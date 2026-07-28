import {
  ArrowDownUp,
  Check,
  Download,
  Image,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  Map as MapIcon,
  Package,
  Plus,
  Search,
  Sparkles,
  UserRound,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  linkOutputFilesToCanvas,
  mergeCanvasMediaFiles,
  generatedFileDownloadName,
  generatedFileDownloadUrl,
  generatedFilePreviewUrl,
  isLocallyDownloadableUrl,
  type CanvasMediaFile,
  triggerMediaDownload,
} from '../services/artifactClient';
import { generationClient, type FileExportJob } from '../services/generationClient';
import { useCanvasStore } from '../store/canvasStore';
import type { GeneratedFile, GenerationJob } from '../types';
import type { RailPanelId } from './LeftRail';
import { SettingsPanel } from './SettingsPanel';

interface RailPanelsProps {
  activePanel: RailPanelId | null;
  onPanelChange: (panel: RailPanelId | null) => void;
}

const assetTabs = [
  { id: 'people', label: '人物', empty: '暂无人物资产', icon: UserRound },
  { id: 'scene', label: '场景', empty: '暂无场景资产', icon: MapIcon },
  { id: 'object', label: '物品', empty: '暂无物品资产', icon: Package },
] as const;

const fileTabs = ['当前画布生成', '历史生成', '输出文件夹'] as const;
const mediaFilters = [
  { label: '所有', type: 'all', icon: Sparkles },
  { label: '图像', type: 'image', icon: Image },
  { label: '视频', type: 'video', icon: Video },
  { label: '声音', type: 'audio', icon: Volume2 },
] as const;

function PanelShell({
  children,
  className,
  onClose,
  title,
}: {
  className: string;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={`floating-panel rail-panel ${className}`}>
      <header className="rail-panel-header">
        <h2>{title}</h2>
        <button className="rail-panel-close" type="button" onClick={onClose} aria-label="关闭面板">
          <X size={22} />
        </button>
      </header>
      {children}
    </section>
  );
}

function AssetsPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<(typeof assetTabs)[number]['id']>('people');
  const current = assetTabs.find((tab) => tab.id === activeTab) ?? assetTabs[0];
  const CurrentIcon = current.icon;

  return (
    <PanelShell className="rail-panel-assets" title="资产" onClose={onClose}>
      <div className="asset-tabbar">
        {assetTabs.map((tab) => (
          <button
            className={activeTab === tab.id ? 'is-active' : ''}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="asset-empty">
        <CurrentIcon size={30} />
        <span>{current.empty}</span>
      </div>
    </PanelShell>
  );
}

function WorkflowPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell className="rail-panel-workflows" title="工作流" onClose={onClose}>
      <label className="workflow-search">
        <Search size={23} />
        <input placeholder="搜索名称、标签、备注" />
      </label>
      <div className="workflow-empty">还没有工作流</div>
    </PanelShell>
  );
}

function FileManagerPanel({ onClose }: { onClose: () => void }) {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const revealNode = useCanvasStore((state) => state.revealNode);
  const [activeTab, setActiveTab] = useState<(typeof fileTabs)[number]>('当前画布生成');
  const [activeFilter, setActiveFilter] = useState<(typeof mediaFilters)[number]['type']>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [filesError, setFilesError] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const mountedRef = useRef(true);
  const indexedFiles = useMemo<CanvasMediaFile[]>(
    () => activeTab === '当前画布生成'
      ? mergeCanvasMediaFiles(activeCanvas, files)
      : linkOutputFilesToCanvas(activeCanvas, files),
    [activeCanvas, activeTab, files],
  );
  const visibleFiles = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase();
    return indexedFiles.filter((file) => {
      if (activeFilter !== 'all' && file.type !== activeFilter) return false;
      if (!needle) return true;
      return [file.title, file.nodeTitle, file.canvasName, file.mimeType, file.type]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(needle));
    });
  }, [activeFilter, indexedFiles, searchQuery]);
  const exportableVisibleFiles = visibleFiles.filter((file) => Boolean(file.artifactId));
  const allVisibleSelected = exportableVisibleFiles.length > 0
    && exportableVisibleFiles.every((file) => selectedFileIds.has(file.artifactId as string));

  useEffect(() => {
    mountedRef.current = true;
    let mounted = true;
    const loadFiles = () => {
      void generationClient
        .listFiles()
        .then((items) => {
          if (!mounted) return;
          setFiles(items);
          setFilesError('');
        })
        .catch((error) => {
          if (!mounted) return;
          setFilesError(error instanceof Error ? error.message : String(error));
        });
    };
    loadFiles();
    const timer = window.setInterval(loadFiles, 4500);
    return () => {
      mounted = false;
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const currentIds = new Set(indexedFiles.map((file) => file.artifactId).filter((id): id is string => Boolean(id)));
    setSelectedFileIds((current) => {
      const retained = new Set(Array.from(current).filter((id) => currentIds.has(id)));
      if (retained.size === current.size) return current;
      return retained;
    });
  }, [indexedFiles]);

  const toggleFileSelection = (fileId: string | undefined) => {
    if (!fileId) return;
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      exportableVisibleFiles.forEach((file) => {
        const fileId = file.artifactId as string;
        if (allVisibleSelected) next.delete(fileId);
        else next.add(fileId);
      });
      return next;
    });
  };

  const exportDownloadUrl = (job: FileExportJob) =>
    job.downloadUrl || job.file?.downloadUrl || job.file?.url || job.result?.downloadUrl || job.result?.url || '';

  const downloadSelectedAsZip = async () => {
    if (exporting || selectedFileIds.size === 0) return;
    setExporting(true);
    setExportNotice(`正在打包 ${selectedFileIds.size} 个文件…`);
    try {
      let job = await generationClient.createExport(Array.from(selectedFileIds));
      for (let attempt = 0; attempt < 600 && mountedRef.current; attempt += 1) {
        if (job.status === 'success' || job.status === 'ready') {
          const downloadUrl = exportDownloadUrl(job);
          if (!downloadUrl) throw new Error('压缩包已生成，但没有可用的下载地址。');
          if (!triggerMediaDownload(downloadUrl)) throw new Error('压缩包下载地址无效。');
          setSelectedFileIds(new Set());
          setExportNotice('压缩包已开始下载。');
          return;
        }
        if (job.status === 'error' || job.status === 'canceled') {
          throw new Error(job.error || (job.status === 'canceled' ? '打包任务已取消。' : '文件打包失败。'));
        }
        const progress = Number(job.progress ?? 0);
        setExportNotice(progress > 0 ? `正在打包 ${Math.round(progress)}%…` : '正在打包，请稍候…');
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (!mountedRef.current) return;
        job = await generationClient.getExport(job.id);
      }
      if (mountedRef.current) throw new Error('文件打包超时，请稍后重试。');
    } catch (error) {
      if (mountedRef.current) setExportNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setExporting(false);
    }
  };

  return (
    <PanelShell className="rail-panel-files" title="文件管理" onClose={onClose}>
      <div className="file-tabs">
        {fileTabs.map((tab) => (
          <button className={activeTab === tab ? 'is-active' : ''} key={tab} type="button" onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="file-subtitle">{activeTab}媒体历史</div>
      <label className="file-search">
        <Search size={18} />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="搜索文件名、节点或媒体类型"
        />
        <span>{visibleFiles.length}</span>
      </label>
      <div className="media-filter-row">
        <div className="media-filters">
          {mediaFilters.map((filter) => {
            const Icon = filter.icon;
            return (
              <button
                className={activeFilter === filter.type ? 'is-active' : ''}
                key={filter.label}
                type="button"
                onClick={() => setActiveFilter(filter.type)}
              >
                <Icon size={18} />
                <span>{filter.label}</span>
              </button>
            );
          })}
        </div>
        <button className="sort-button" type="button" aria-label="排序">
          <ArrowDownUp size={22} />
        </button>
      </div>
      {indexedFiles.length > 0 && (
        <div className="file-batch-toolbar">
          <button
            className={allVisibleSelected ? 'is-active' : ''}
            type="button"
            disabled={exportableVisibleFiles.length === 0 || exporting}
            onClick={toggleVisibleSelection}
          >
            <span className="file-selection-box">{allVisibleSelected && <Check size={14} strokeWidth={3} />}</span>
            <span>{allVisibleSelected ? '取消全选' : '选择当前结果'}</span>
          </button>
          <span className="file-selection-count">已选 {selectedFileIds.size} 项</span>
          <button
            className="file-batch-download"
            type="button"
            disabled={selectedFileIds.size === 0 || exporting}
            onClick={() => void downloadSelectedAsZip()}
          >
            {exporting ? <LoaderCircle className="spin" size={17} /> : <Package size={17} />}
            <span>{exporting ? '正在打包' : '打包下载 ZIP'}</span>
          </button>
        </div>
      )}
      {exportNotice && <div className={`file-export-notice ${exporting ? 'is-running' : ''}`}>{exportNotice}</div>}
      <div className="media-grid">
        {filesError && indexedFiles.length === 0 && <div className="media-empty">文件服务暂不可用：{filesError}</div>}
        {indexedFiles.length > 0 && visibleFiles.length === 0 && <div className="media-empty">暂无匹配媒体</div>}
        {visibleFiles.length > 0 &&
          visibleFiles.map((file) => {
            const previewUrl = generatedFilePreviewUrl(file);
            const downloadUrl = generatedFileDownloadUrl(file);
            const downloadable = isLocallyDownloadableUrl(downloadUrl);
            const selected = Boolean(file.artifactId && selectedFileIds.has(file.artifactId));
            return (
              <article
                className={`media-card generated-media-card ${selected ? 'is-selected' : ''}`}
                key={`${file.canvasId ?? 'output'}:${file.nodeId ?? 'file'}:${file.id}`}
                title={file.nodeId ? `${file.title} · 位于 ${file.canvasName ?? '当前画布'}` : file.title}
              >
                <a className="generated-media-preview" href={previewUrl} target="_blank" rel="noreferrer" aria-label={`预览 ${file.title}`}>
                  {file.type === 'image' ? (
                    <img src={previewUrl} alt={file.title} />
                  ) : (
                    <div className={`generated-media-fallback type-${file.type}`}>
                      {file.type === 'video' ? <Video size={34} /> : <Volume2 size={34} />}
                    </div>
                  )}
                </a>
                <button
                  className="media-card-select"
                  type="button"
                  aria-label={selected ? `取消选择 ${file.title}` : `选择 ${file.title}`}
                  aria-pressed={selected}
                  disabled={!file.artifactId}
                  onClick={() => toggleFileSelection(file.artifactId)}
                >
                  {selected && <Check size={14} strokeWidth={3} />}
                </button>
                <button
                  className="media-card-download"
                  type="button"
                  aria-label={`下载 ${file.title}`}
                  title={downloadable ? '下载' : '暂不可下载：文件尚未落盘'}
                  disabled={!downloadable}
                  onClick={() => triggerMediaDownload(downloadUrl, generatedFileDownloadName(file))}
                >
                  <Download size={16} />
                </button>
                {file.nodeId && (
                  <button
                    className="media-card-locate"
                    type="button"
                    aria-label={`在画布中定位 ${file.title}`}
                    title="定位到画布"
                    onClick={() => {
                      revealNode(file.nodeId as string, file.canvasId);
                      onClose();
                    }}
                  >
                    <LocateFixed size={16} />
                  </button>
                )}
                <span className="media-card-title">{file.title}</span>
                {file.nodeId && <span className="media-card-context">{file.nodeTitle || '素材节点'}</span>}
              </article>
            );
          })}
        {!filesError && indexedFiles.length === 0 && (
          <div className="media-empty">
            {activeTab === '当前画布生成' ? '当前画布还没有可管理的媒体资产' : '输出文件夹为空'}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function CanvasPanel({ onClose }: { onClose: () => void }) {
  const createCanvas = useCanvasStore((state) => state.createCanvas);

  return (
    <PanelShell className="rail-panel-canvases" title="AI 画布" onClose={onClose}>
      <div className="canvas-panel-empty">暂无保存的工作流</div>
      <button
        className="new-canvas-button"
        type="button"
        onClick={() => {
          createCanvas();
          onClose();
        }}
      >
        <Plus size={22} />
        <span>新建画布</span>
      </button>
    </PanelShell>
  );
}

function TaskPanel({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [error, setError] = useState('');
  const reconcileGenerationJobs = useCanvasStore((state) => state.reconcileGenerationJobs);
  const hydrateProjectFromServer = useCanvasStore((state) => state.hydrateProjectFromServer);
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const loadJobs = () => {
      if (requestInFlightRef.current) return;
      requestInFlightRef.current = true;
      void generationClient
        .listJobs()
        .then(async (items) => {
          if (!mounted) return;
          const project = useCanvasStore.getState().project;
          const nodesByJobId = new globalThis.Map(
            project.canvases.flatMap((canvas) =>
              canvas.nodes.flatMap((node) => {
                const jobId = String(node.data.lastJobId || '');
                return jobId ? [[jobId, node] as const] : [];
              }),
            ),
          );
          const hasUnprojectedTerminalJob = items.some((job) => {
            const node = nodesByJobId.get(job.id);
            if (!node) return false;
            if (job.status === 'success') return node.data.status !== 'success';
            if (job.status === 'error' || job.status === 'canceled') return node.data.status !== 'error';
            return false;
          });
          if (hasUnprojectedTerminalJob) await hydrateProjectFromServer();
          if (!mounted) return;
          reconcileGenerationJobs(items);
          setJobs(items);
          setError('');
        })
        .catch((nextError) => {
          if (!mounted) return;
          setJobs([]);
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        })
        .finally(() => {
          requestInFlightRef.current = false;
        });
    };
    loadJobs();
    const timer = window.setInterval(loadJobs, 1400);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [hydrateProjectFromServer, reconcileGenerationJobs]);

  const statusText: Record<GenerationJob['status'], string> = {
    queued: '排队中',
    running: '运行中',
    success: '已完成',
    error: '失败',
    canceled: '已取消',
  };

  return (
    <PanelShell className="rail-panel-tasks" title="任务" onClose={onClose}>
      <div className="task-panel-status">
        {error ? `后台任务不可用：${error}` : jobs.length > 0 ? '后台生成任务已连接' : '当前没有后台生成任务'}
      </div>
      {jobs.length > 0 ? (
        <div className="desktop-task-list">
          {jobs.map((job) => (
            <article className={`desktop-task-card task-${job.status}`} key={job.id}>
              <div>
                <strong>{job.kind} · {job.model}</strong>
                <span>{job.error || `${statusText[job.status]} · ${job.provider}`}</span>
              </div>
              <span>{job.progress}%</span>
            </article>
          ))}
        </div>
      ) : (
        <div className="task-empty">
          <ListChecks size={30} />
          <span>{error ? '桌面任务不可用' : '暂无后台任务'}</span>
        </div>
      )}
    </PanelShell>
  );
}

export function RailPanels({ activePanel, onPanelChange }: RailPanelsProps) {
  const close = () => onPanelChange(null);
  if (!activePanel) return null;
  if (activePanel === 'assets') return <AssetsPanel onClose={close} />;
  if (activePanel === 'workflows') return <WorkflowPanel onClose={close} />;
  if (activePanel === 'files') return <FileManagerPanel onClose={close} />;
  if (activePanel === 'tasks') return <TaskPanel onClose={close} />;
  if (activePanel === 'settings') return <SettingsPanel onClose={close} />;
  return <CanvasPanel onClose={close} />;
}
