import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  FolderOpen,
  Image,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  mergeCanvasMediaFiles,
  generatedFileDownloadName,
  generatedFileDownloadUrl,
  generatedFilePreviewUrl,
  isLocallyDownloadableUrl,
  triggerMediaDownload,
} from '../services/artifactClient';
import {
  buildAssetBrowserIndex,
  assetEmptyState,
  formatAssetSize,
  MAX_ASSET_EXPORT_FILES,
  parseAssetFileList,
  safeAssetPreviewUrl,
  scopeAssets,
  searchAssets,
  sortAssets,
  type AssetOrigin,
  type AssetScope,
  type AssetSort,
  type BrowserAsset,
} from '../services/assetBrowser';
import { generationClient, type FileExportJob } from '../services/generationClient';
import { useCanvasStore } from '../store/canvasStore';
import type { GeneratedFile, GenerationJob } from '../types';
import type { RailPanelId } from './LeftRail';
import { SettingsPanel } from './SettingsPanel';
import { CreativeStudioPanel } from './CreativeStudioPanel';
import '../assets-panel.css';

interface RailPanelsProps {
  activePanel: RailPanelId | null;
  onPanelChange: (panel: RailPanelId | null) => void;
}

const fileTabs: Array<{ id: AssetScope; label: string }> = [
  { id: 'current', label: '当前画布' },
  { id: 'project', label: '全部画布' },
  { id: 'output', label: '输出文件夹' },
];
const mediaFilters = [
  { label: '所有', type: 'all', icon: Sparkles },
  { label: '图片', type: 'image', icon: Image },
  { label: '视频', type: 'video', icon: Video },
  { label: '音频', type: 'audio', icon: Volume2 },
  { label: '其他', type: 'other', icon: Package },
] as const;
const assetTypeLabels = { image: '图片', video: '视频', audio: '音频', other: '文件' };
const assetOriginLabels = { imported: '导入素材', generated: '生成结果', output: '未关联画布' };
const assetsPerPage = 36;

function PanelShell({
  children,
  className,
  onClose,
  title,
  subtitle,
}: {
  className: string;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`floating-panel rail-panel ${className}`} aria-label={title}>
      <header className="rail-panel-header">
        <div><h2>{title}</h2>{subtitle && <div className="asset-panel-subtitle">{subtitle}</div>}</div>
        <button className="rail-panel-close" type="button" onClick={onClose} aria-label="关闭面板">
          <X size={22} />
        </button>
      </header>
      {children}
    </section>
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

function AssetPreview({ file }: { file: BrowserAsset }) {
  const [failed, setFailed] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const previewRef = useRef<HTMLAnchorElement>(null);
  const previewUrl = safeAssetPreviewUrl(generatedFilePreviewUrl(file));
  useEffect(() => { setFailed(false); setVideoReady(false); }, [previewUrl]);
  useEffect(() => {
    const element = previewRef.current;
    if (file.type !== 'video' || !element) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setVideoVisible(entry.isIntersecting);
      if (!entry.isIntersecting) setVideoReady(false);
    }, { root: element.closest('.asset-library'), rootMargin: '0px', threshold: 0.05 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [file.type, previewUrl]);
  return (
    <a ref={previewRef} className="asset-preview" href={previewUrl || undefined} target="_blank" rel="noreferrer" aria-label={previewUrl ? `预览 ${file.title}` : `${file.title} 暂无预览地址`} aria-disabled={!previewUrl}>
      {file.type === 'image' && previewUrl && !failed ? (
        <img src={previewUrl} alt={file.title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className={`asset-preview-placeholder type-${file.type}`}>
          {failed || !previewUrl ? <FileQuestion size={30} /> : file.type === 'video' ? <Video size={30} /> : file.type === 'audio' ? <Volume2 size={30} /> : <Package size={30} />}
          {file.type === 'audio' && <div className="asset-audio-wave" aria-hidden="true">{[12, 21, 16, 30, 42, 25, 35, 17, 28, 39, 20, 12].map((height, index) => <i key={index} style={{ height }} />)}</div>}
          <span>{!previewUrl ? '暂无预览地址' : failed ? '预览暂不可用' : file.type === 'video' ? '点击播放视频' : file.type === 'audio' ? '点击试听音频' : '打开文件'}</span>
        </div>
      )}
      {file.type === 'video' && previewUrl && videoVisible && !failed && (
        <video
          className={`asset-video-thumbnail ${videoReady ? 'is-ready' : ''}`}
          src={previewUrl}
          preload="metadata"
          muted
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration) && video.duration > 0) {
              try { video.currentTime = Math.min(0.08, video.duration / 2); } catch { /* Metadata can precede a seekable range. */ }
            }
          }}
          onLoadedData={() => setVideoReady(true)}
          onSeeked={() => setVideoReady(true)}
          onError={() => setFailed(true)}
        />
      )}
      <span className={`asset-type-badge type-${file.type}`}>{assetTypeLabels[file.type]}</span>
      {file.type === 'video' && previewUrl && !failed && <span className="asset-preview-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>}
    </a>
  );
}

function FileManagerPanel({ onClose }: { onClose: () => void }) {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const canvases = useCanvasStore((state) => state.project.canvases);
  const revealNode = useCanvasStore((state) => state.revealNode);
  const [activeTab, setActiveTab] = useState<AssetScope>('current');
  const [activeFilter, setActiveFilter] = useState<(typeof mediaFilters)[number]['type']>('all');
  const [originFilter, setOriginFilter] = useState<'all' | AssetOrigin>('all');
  const [sort, setSort] = useState<AssetSort>('newest');
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [filesError, setFilesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const mountedRef = useRef(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const indexedFiles = useMemo(() => {
    const canvasFiles = canvases.flatMap((canvas) => {
      const importedNodeIds = new Set(canvas.nodes.filter((node) => node.data.importedMedia).map((node) => node.id));
      return mergeCanvasMediaFiles(canvas, files).map((file) => ({
        ...file,
        origin: (file.nodeId && importedNodeIds.has(file.nodeId) ? 'imported' : 'generated') as AssetOrigin,
      }));
    });
    return buildAssetBrowserIndex(canvasFiles, files, activeCanvas.id);
  }, [activeCanvas.id, canvases, files]);
  const scopedFiles = useMemo(() => scopeAssets(indexedFiles, activeTab, activeCanvas.id), [activeCanvas.id, activeTab, indexedFiles]);
  const searchedFiles = useMemo(() => searchAssets(scopedFiles, searchQuery, originFilter), [scopedFiles, searchQuery, originFilter]);
  const visibleFiles = useMemo(() => sortAssets(searchedFiles.filter((file) => activeFilter === 'all' || file.type === activeFilter), sort), [searchedFiles, activeFilter, sort]);
  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / assetsPerPage));
  const currentPage = Math.min(page, pageCount);
  const pageFiles = visibleFiles.slice((currentPage - 1) * assetsPerPage, currentPage * assetsPerPage);
  const exportableVisibleFiles = pageFiles.filter((file) => Boolean(file.artifactId) && isLocallyDownloadableUrl(generatedFileDownloadUrl(file)));
  const allVisibleSelected = exportableVisibleFiles.length > 0
    && exportableVisibleFiles.every((file) => selectedFileIds.has(file.artifactId as string));
  const hasFilters = Boolean(searchQuery || activeFilter !== 'all' || originFilter !== 'all');
  const emptyState = assetEmptyState(activeTab, hasFilters, loading, Boolean(filesError));
  const selectionLimitReached = selectedFileIds.size >= MAX_ASSET_EXPORT_FILES;

  useEffect(() => { setPage(1); }, [activeTab, activeFilter, originFilter, searchQuery, sort, activeCanvas.id]);
  useEffect(() => { gridRef.current?.scrollTo({ top: 0 }); }, [currentPage, activeTab, activeFilter, originFilter, searchQuery, sort, activeCanvas.id]);

  useEffect(() => {
    mountedRef.current = true;
    let mounted = true;
    let pending = false;
    const loadFiles = () => {
      if (pending) return;
      pending = true;
      void generationClient
        .listFiles()
        .then((items) => {
          if (!mounted) return;
          setFiles(parseAssetFileList(items));
          setFilesError('');
        })
        .catch((error) => {
          if (!mounted) return;
          setFilesError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          pending = false;
          if (mounted) setLoading(false);
        });
    };
    loadFiles();
    const timer = window.setInterval(loadFiles, 4500);
    return () => {
      mounted = false;
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

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
      else if (next.size < MAX_ASSET_EXPORT_FILES) next.add(fileId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      exportableVisibleFiles.forEach((file) => {
        const fileId = file.artifactId as string;
        if (allVisibleSelected) next.delete(fileId);
        else if (next.size < MAX_ASSET_EXPORT_FILES) next.add(fileId);
      });
      return next;
    });
  };

  const exportDownloadUrl = (job: FileExportJob) =>
    job.downloadUrl || job.file?.downloadUrl || job.file?.url || job.result?.downloadUrl || job.result?.url || '';

  const downloadSelectedAsZip = async () => {
    if (exporting || selectedFileIds.size === 0) return;
    if (selectedFileIds.size > MAX_ASSET_EXPORT_FILES) {
      setExportNotice(`一次最多打包 ${MAX_ASSET_EXPORT_FILES} 个文件，请减少选择后重试。`);
      return;
    }
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
    <PanelShell className="rail-panel-files asset-library" title="资产库" subtitle={`${canvases.length} 个画布 · ${indexedFiles.length} 个媒体文件`} onClose={onClose}>
      <div className="asset-library-controls">
        <div className="asset-scope-tabs" role="tablist" aria-label="资产范围">
          {fileTabs.map((tab) => (
            <button className={activeTab === tab.id ? 'is-active' : ''} key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="asset-search-row">
          <label className="asset-search-field">
            <Search size={17} />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} aria-label="搜索资产" placeholder="搜索文件名、节点、画布…" />
            {searchQuery && <button type="button" aria-label="清空搜索" onClick={() => setSearchQuery('')}><X size={15} /></button>}
          </label>
          <label className="asset-select-control">
            <select value={originFilter} aria-label="资产来源" onChange={(event) => setOriginFilter(event.currentTarget.value as 'all' | AssetOrigin)}>
              <option value="all">全部来源</option>
              <option value="imported">导入素材</option>
              <option value="generated">生成结果</option>
              <option value="output">未关联画布</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="asset-select-control asset-sort-control">
            <ArrowDownUp size={15} aria-hidden="true" />
            <select value={sort} aria-label="资产排序" onChange={(event) => setSort(event.currentTarget.value as AssetSort)}>
              <option value="newest">最近创建</option>
              <option value="oldest">最早创建</option>
              <option value="name">名称 A–Z</option>
              <option value="size">文件大小</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>
        <div className="asset-type-filters" aria-label="媒体类型">
          {mediaFilters.map((filter) => {
            const Icon = filter.icon;
            const count = filter.type === 'all' ? searchedFiles.length : searchedFiles.filter((file) => file.type === filter.type).length;
            if (filter.type === 'other' && count === 0 && activeFilter !== 'other') return null;
            return <button className={activeFilter === filter.type ? 'is-active' : ''} key={filter.type} type="button" aria-pressed={activeFilter === filter.type} onClick={() => setActiveFilter(filter.type)}><Icon size={15} /><span>{filter.label}</span><small>{count}</small></button>;
          })}
          <button className="asset-refresh" type="button" aria-label="刷新资产列表" disabled={loading} onClick={() => { setLoading(true); setRefreshKey((current) => current + 1); }}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>
      <div className="asset-result-summary">
        <span>{activeTab === 'current' ? activeCanvas.name : activeTab === 'project' ? '所有画布中的素材' : '已保存的输出文件'}<strong>{visibleFiles.length} 项</strong></span>
        {hasFilters && <button type="button" onClick={() => { setSearchQuery(''); setActiveFilter('all'); setOriginFilter('all'); }}>清除筛选</button>}
      </div>
      {filesError && <div className="asset-service-notice" role="status">文件列表暂未同步{indexedFiles.length > 0 ? '，仍可浏览已索引素材' : ''}。<button type="button" onClick={() => { setLoading(true); setRefreshKey((current) => current + 1); }}>重试</button><span title={filesError}>查看连接状态</span></div>}
      <div className="asset-grid-scroll" ref={gridRef} aria-busy={loading && pageFiles.length === 0}>
        <div className="asset-library-grid">
          {pageFiles.length === 0 ? (
            <div className="asset-library-empty" role="status">{emptyState.pending ? <LoaderCircle size={28} className="spin" /> : emptyState.failed ? <FileQuestion size={32} /> : <FolderOpen size={32} />}<strong>{emptyState.title}</strong><span>{emptyState.detail}</span>{!emptyState.pending && (emptyState.failed ? <button type="button" onClick={() => { setLoading(true); setRefreshKey((current) => current + 1); }}>重新读取</button> : (hasFilters || activeTab === 'current') && <button type="button" onClick={() => { setSearchQuery(''); setActiveFilter('all'); setOriginFilter('all'); if (!hasFilters) setActiveTab('project'); }}>{hasFilters ? '清除筛选' : '查看全部画布'}</button>)}</div>
          ) : pageFiles.map((file) => {
            const downloadUrl = generatedFileDownloadUrl(file);
            const downloadable = isLocallyDownloadableUrl(downloadUrl);
            const selected = Boolean(file.artifactId && selectedFileIds.has(file.artifactId));
            return (
              <article className={`asset-library-card ${selected ? 'is-selected' : ''}`} key={file.key} aria-label={file.title}>
                <div className="asset-card-cover">
                  <AssetPreview file={file} />
                  <button className="asset-card-select" type="button" aria-label={selected ? `取消选择 ${file.title}` : `选择 ${file.title}`} aria-pressed={selected} disabled={!file.artifactId || !downloadable || exporting || (selectionLimitReached && !selected)} title={!file.artifactId || !downloadable ? '文件落盘后可加入打包' : selectionLimitReached && !selected ? `一次最多选择 ${MAX_ASSET_EXPORT_FILES} 个文件` : '选择文件'} onClick={() => toggleFileSelection(file.artifactId)}>{selected && <Check size={13} strokeWidth={3} />}</button>
                  <div className="asset-card-actions">
                    {file.nodeId && <button type="button" aria-label={`在画布中定位 ${file.title}`} title={`定位到 ${file.canvasName}`} onClick={() => { revealNode(file.nodeId as string, file.canvasId); onClose(); }}><LocateFixed size={16} /></button>}
                    <button type="button" aria-label={`下载 ${file.title}`} title={downloadable ? '下载原文件' : '暂不可下载：文件尚未落盘'} disabled={!downloadable} onClick={() => triggerMediaDownload(downloadUrl, generatedFileDownloadName(file))}><Download size={16} /></button>
                  </div>
                </div>
                <div className="asset-card-info">
                  <strong title={file.title}>{file.title}</strong>
                  <div className="asset-card-meta"><span>{file.origins.map((origin) => assetOriginLabels[origin]).join(' / ')}</span><span>{formatAssetSize(file.size)}</span></div>
                  <div className="asset-card-location">
                    <span title={file.locations.map((location) => `${location.canvasName} · ${location.nodeTitle}`).join('\n')}>{file.canvasName || '尚未关联画布'}{file.locations.length > 1 ? ` +${file.locations.length - 1} 处` : ''}</span>
                    {!downloadable && <small>待落盘</small>}
                    {file.locations.length > 1 ? (
                      <label className="asset-location-picker">
                        <LocateFixed size={12} aria-hidden="true" />
                        <select aria-label={`选择 ${file.title} 的画布位置`} value="" onChange={(event) => {
                          const location = file.locations[Number(event.currentTarget.value)];
                          if (!location) return;
                          revealNode(location.nodeId, location.canvasId);
                          onClose();
                        }}>
                          <option value="" disabled>定位</option>
                          {file.locations.map((location, index) => <option key={`${location.canvasId}:${location.nodeId}`} value={index}>{location.canvasName} · {location.nodeTitle}</option>)}
                        </select>
                        <ChevronDown size={11} aria-hidden="true" />
                      </label>
                    ) : file.nodeId && <button type="button" aria-label={`定位素材 ${file.title}`} onClick={() => { revealNode(file.nodeId as string, file.canvasId); onClose(); }}><LocateFixed size={12} />定位</button>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {pageCount > 1 && <nav className="asset-pagination" aria-label="资产分页"><span>第 {currentPage} / {pageCount} 页 · 每页 {assetsPerPage} 项</span><button type="button" aria-label="上一页资产" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><button type="button" aria-label="下一页资产" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></nav>}
      {exportNotice && <div className={`asset-export-notice ${exporting ? 'is-running' : ''}`} role="status">{exportNotice}</div>}
      <footer className="asset-batch-footer">
        <button className={`asset-select-page ${allVisibleSelected ? 'is-active' : ''}`} type="button" disabled={exportableVisibleFiles.length === 0 || exporting || (selectionLimitReached && !allVisibleSelected)} onClick={toggleVisibleSelection}><span className="asset-selection-box">{allVisibleSelected && <Check size={12} strokeWidth={3} />}</span><span>{allVisibleSelected ? '取消本页选择' : '选择本页'}</span></button>
        <span className="asset-selection-summary" title={`一次最多打包 ${MAX_ASSET_EXPORT_FILES} 项`}>已选 <strong>{selectedFileIds.size}</strong> / {MAX_ASSET_EXPORT_FILES} 项</span>
        {selectedFileIds.size > 0 && <button className="asset-clear-selection" type="button" disabled={exporting} onClick={() => setSelectedFileIds(new Set())}>清空</button>}
        <button className="asset-batch-download" type="button" disabled={selectedFileIds.size === 0 || exporting} onClick={() => void downloadSelectedAsZip()}>{exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}<span>{exporting ? '正在打包…' : '打包下载'}</span></button>
      </footer>
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
  if (activePanel === 'creative') return <CreativeStudioPanel onClose={close} />;
  if (activePanel === 'assets') return <FileManagerPanel onClose={close} />;
  if (activePanel === 'workflows') return <WorkflowPanel onClose={close} />;
  if (activePanel === 'files') return <FileManagerPanel onClose={close} />;
  if (activePanel === 'tasks') return <TaskPanel onClose={close} />;
  if (activePanel === 'settings') return <SettingsPanel onClose={close} />;
  return <CanvasPanel onClose={close} />;
}
