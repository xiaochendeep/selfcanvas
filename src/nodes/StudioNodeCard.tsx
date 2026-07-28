import { Handle, NodeResizer, Position, useViewport, type NodeProps } from '@xyflow/react';
import {
  Box,
  Check,
  Download,
  FileStack,
  Globe2,
  Image,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Music,
  Pause,
  Pencil,
  Play,
  Table2,
  Text,
  Upload,
  Video,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { isLocallyDownloadableUrl, triggerMediaDownload } from '../services/artifactClient';
import { useCanvasStore } from '../store/canvasStore';
import { useSettingsStore } from '../store/settingsStore';
import type { NodeKind, StoryboardDocument, StoryboardShot, StudioNode } from '../types';
import { storyboardToMarkdown } from '../utils/storyboard';

const iconByKind: Record<NodeKind, LucideIcon> = {
  text: Text,
  image: Image,
  video: Video,
  audio: Music,
  stage3d: Box,
  panorama: Globe2,
  storyboard: Table2,
  collage: LayoutGrid,
  asset: FileStack,
  upload: Upload,
};

const labelByKind: Record<NodeKind, string> = {
  text: '文本',
  image: '图像',
  video: '视频',
  audio: '音频',
  stage3d: '3D导演台',
  panorama: '360全景图',
  storyboard: '分镜脚本',
  collage: '拼图',
  asset: '素材',
  upload: '上传',
};

const importedMediaLabel = {
  image: '图片素材',
  video: '视频素材',
  audio: '音频素材',
} as const;

function readableFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const composerNodeKinds = new Set<NodeKind>(['text', 'image', 'video', 'audio', 'storyboard']);

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, input, textarea, select, video, audio, .video-preview, .audio-preview, .node-handle-hotspot, .react-flow__handle',
    ),
  );
}

function hasNodeOutput(node: StudioNode) {
  const { outputs, status } = node.data;
  return Boolean(
    status === 'running' ||
      outputs.text ||
      outputs.imageUrl ||
      outputs.videoUrl ||
      outputs.audioUrl ||
      outputs.assetName ||
      outputs.fileUrl,
  );
}

function displayNodeError(message: string) {
  if (/Sub2API 401:.*API key is required|Sub2API 未读取到 API Key/i.test(message)) {
    return 'Sub2API 未读取到 API Key。请重新生成一次。';
  }
  if (/Missing bearer|basic authentication|Authorization header/i.test(message)) {
    return '当前模型接口缺少 API Key，请检查设置或 .env。';
  }
  if (/No available compatible accounts/i.test(message)) {
    return 'Sub2API 已连接，但没有可服务该模型的账号/渠道。';
  }
  return message;
}

function StoryboardPanel({ node }: { node: StudioNode }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runNode = useCanvasStore((state) => state.runNode);
  const createNodeFromShot = useCanvasStore((state) => state.createNodeFromStoryboardShot);
  const { outputs, status, progress, providerOptions } = node.data;
  const storyboard = outputs.storyboard;
  const promptMode = providerOptions?.promptMode === 'video' ? 'video' : 'image';
  const viewMode = providerOptions?.viewMode === 'card' ? 'card' : 'list';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StoryboardDocument | null>(storyboard ?? null);
  const [fullscreen, setFullscreen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(storyboard ?? null);
  }, [editing, storyboard]);

  const updateOptions = (patch: Partial<NonNullable<StudioNode['data']['providerOptions']>>) => {
    updateNodeData(node.id, { providerOptions: { ...providerOptions, ...patch } });
  };

  const updateShot = (index: number, field: keyof Omit<StoryboardShot, 'shotNumber'>, value: string) => {
    setDraft((current) => current ? {
      ...current,
      shots: current.shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, [field]: value } : shot),
    } : current);
  };

  const saveDraft = () => {
    if (!draft || draft.shots.some((shot) => [shot.shotSize, shot.visualDescription, shot.cameraMovement, shot.imagePrompt, shot.videoPrompt].some((field) => !field.trim()))) return;
    const normalized: StoryboardDocument = {
      version: 1,
      shotCount: draft.shots.length,
      shots: draft.shots.map((shot, index) => ({ ...shot, shotNumber: index + 1 })),
    };
    updateNodeData(node.id, { outputs: { ...outputs, storyboard: normalized, text: storyboardToMarkdown(normalized) } });
    setDraft(normalized);
    setEditing(false);
  };

  const download = (format: 'json' | 'markdown') => {
    if (!storyboard) return;
    const body = format === 'json' ? JSON.stringify(storyboard, null, 2) : storyboardToMarkdown(storyboard);
    const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${node.data.title || 'storyboard'}.${format === 'json' ? 'json' : 'md'}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloadOpen(false);
  };

  const shownDocument = editing ? draft : storyboard;

  const renderShots = (isFullscreen = false) => {
    if (status === 'running') {
      return (
        <div className="storyboard-running">
          <LoaderCircle className="spin" size={22} />
          <strong>正在生成 {Number(providerOptions?.shotCount ?? 5)} 镜分镜 {progress}%</strong>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        </div>
      );
    }
    if (!shownDocument && outputs.text) {
      return (
        <div className="storyboard-legacy-result">
          <div><strong>旧版文本结果</strong><span>这份结果没有结构化镜头数据。</span></div>
          <pre>{outputs.text}</pre>
          <button type="button" onClick={() => void runNode(node.id)}>按结构化格式重新生成</button>
        </div>
      );
    }
    if (!shownDocument) {
      return (
        <div className="storyboard-empty-state">
          <strong>暂无分镜脚本数据</strong>
          <span>选中节点后，引用剧情正文并设置镜头数量即可生成。</span>
        </div>
      );
    }
    return (
      <div className={`storyboard-shot-collection view-${viewMode} ${isFullscreen ? 'is-fullscreen-content' : ''}`}>
        {shownDocument.shots.map((shot, index) => {
          const currentPrompt = promptMode === 'video' ? shot.videoPrompt : shot.imagePrompt;
          return (
            <article className="storyboard-shot-item" key={shot.shotNumber}>
              <div className="storyboard-shot-number">{String(shot.shotNumber).padStart(2, '0')}</div>
              <div className="storyboard-shot-fields">
                {editing ? (
                  <>
                    <label><span>景别</span><input value={shot.shotSize} onChange={(event) => updateShot(index, 'shotSize', event.currentTarget.value)} /></label>
                    <label><span>画面</span><textarea value={shot.visualDescription} onChange={(event) => updateShot(index, 'visualDescription', event.currentTarget.value)} /></label>
                    <label><span>运镜</span><input value={shot.cameraMovement} onChange={(event) => updateShot(index, 'cameraMovement', event.currentTarget.value)} /></label>
                    <label><span>图像提示词</span><textarea value={shot.imagePrompt} onChange={(event) => updateShot(index, 'imagePrompt', event.currentTarget.value)} /></label>
                    <label><span>视频提示词</span><textarea value={shot.videoPrompt} onChange={(event) => updateShot(index, 'videoPrompt', event.currentTarget.value)} /></label>
                  </>
                ) : (
                  <>
                    <div className="storyboard-shot-meta"><strong>{shot.shotSize}</strong><span>{shot.cameraMovement}</span></div>
                    <p>{shot.visualDescription}</p>
                    <div className="storyboard-current-prompt"><span>{promptMode === 'video' ? '视频提示词' : '图像提示词'}</span><p>{currentPrompt}</p></div>
                    {viewMode === 'card' && (
                      <div className="storyboard-alternate-prompt"><span>{promptMode === 'video' ? '图像提示词' : '视频提示词'}</span><p>{promptMode === 'video' ? shot.imagePrompt : shot.videoPrompt}</p></div>
                    )}
                  </>
                )}
              </div>
              {!editing && (
                <div className="storyboard-shot-actions">
                  <button type="button" title="创建图像节点" onClick={() => createNodeFromShot(node.id, shot, 'image')}><Image size={15} /></button>
                  <button type="button" title="创建视频节点" onClick={() => createNodeFromShot(node.id, shot, 'video')}><Video size={15} /></button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    );
  };

  return (
    <div className="storyboard-board">
      <div
        className="storyboard-floating-toolbar"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {editing ? (
          <>
            <button type="button" onClick={saveDraft} aria-label="保存分镜"><Check size={15} /><span>保存</span></button>
            <button type="button" onClick={() => { setEditing(false); setDraft(storyboard ?? null); }} aria-label="取消编辑"><X size={15} /></button>
          </>
        ) : (
          <button type="button" onClick={() => { setDraft(storyboard ?? null); setEditing(Boolean(storyboard)); }} disabled={!storyboard} aria-label="编辑分镜"><Pencil size={15} /><span>编辑</span></button>
        )}
        <button
          type="button"
          aria-label="放大分镜"
          onPointerDown={(event) => {
            event.stopPropagation();
            setFullscreen(true);
          }}
          onClick={() => setFullscreen(true)}
        >
          <Maximize2 size={15} />
        </button>
        <button type="button" aria-label="下载分镜" disabled={!storyboard} onClick={() => setDownloadOpen((open) => !open)}>
          <Download size={16} />
        </button>
        {downloadOpen && <div className="storyboard-download-menu"><button type="button" onClick={() => download('json')}>导出 JSON</button><button type="button" onClick={() => download('markdown')}>导出 Markdown</button></div>}
      </div>
      <div className="storyboard-board-header">
        <div className="storyboard-board-title">
          <Table2 size={15} />
          <strong>分镜脚本</strong>
          <span>BETA</span>
        </div>
        <div className="storyboard-board-actions">
          <div className="storyboard-segment">
            <button className={promptMode === 'image' ? 'is-active' : ''} type="button" onClick={() => updateOptions({ promptMode: 'image' })}>图像提示词</button>
            <button className={promptMode === 'video' ? 'is-active' : ''} type="button" onClick={() => updateOptions({ promptMode: 'video' })}>视频提示词</button>
          </div>
          <div className="storyboard-segment">
            <button className={viewMode === 'list' ? 'is-active' : ''} type="button" onClick={() => updateOptions({ viewMode: 'list' })}>列表视图</button>
            <button className={viewMode === 'card' ? 'is-active' : ''} type="button" onClick={() => updateOptions({ viewMode: 'card' })}>卡片视图</button>
          </div>
        </div>
      </div>
      <div className="storyboard-board-body">
        {renderShots()}
      </div>
      {fullscreen && createPortal(
        <div className="storyboard-fullscreen-backdrop" role="dialog" aria-modal="true">
          <section className="storyboard-fullscreen-panel">
            <header><div><Table2 size={20} /><strong>{node.data.title}</strong><span>{storyboard?.shotCount ?? 0} 镜</span></div><button type="button" onClick={() => setFullscreen(false)} aria-label="关闭全屏"><X size={20} /></button></header>
            <div className="storyboard-fullscreen-body">{renderShots(true)}</div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '00:00';
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function MediaDownloadButton({ url }: { url: string | undefined }) {
  const downloadable = isLocallyDownloadableUrl(url);
  const title = downloadable ? '下载媒体' : '远程结果尚未落盘，暂不可下载';

  return (
    <button
      className="media-download-button nodrag nowheel"
      type="button"
      aria-label={title}
      title={title}
      disabled={!downloadable}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (url) triggerMediaDownload(url);
      }}
    >
      <Download size={16} />
    </button>
  );
}

function VideoOutputPreview({ label, src, downloadUrl }: { label: string; src: string; downloadUrl?: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    setPaused(true);
    setCurrentTime(0);
    setDuration(0);
    setMuted(true);
    setVolume(1);
  }, [src]);

  const syncPlaybackState = () => {
    const video = videoRef.current;
    if (!video) return;
    setPaused(video.paused);
    setCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setPaused(true));
    } else {
      video.pause();
    }
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volumeProgress = muted ? 0 : volume * 100;

  return (
    <div
      className="media-preview video-preview nodrag nowheel"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <video
        ref={videoRef}
        className="nodrag nowheel"
        src={src}
        muted={muted}
        playsInline
        preload="metadata"
        aria-label="视频预览，点击播放或暂停"
        onClick={togglePlayback}
        onLoadedMetadata={syncPlaybackState}
        onDurationChange={syncPlaybackState}
        onTimeUpdate={syncPlaybackState}
        onPlay={syncPlaybackState}
        onPause={syncPlaybackState}
        onEnded={syncPlaybackState}
        onVolumeChange={() => {
          const video = videoRef.current;
          if (!video) return;
          setMuted(video.muted);
          setVolume(video.volume);
        }}
      />
      <span className="video-result-label">{label}</span>
      <MediaDownloadButton url={downloadUrl || src} />
      <div className="video-controls nodrag nowheel" role="group" aria-label="视频播放控制">
        <button
          className="video-control-button"
          type="button"
          onClick={togglePlayback}
          aria-label={paused ? '播放视频' : '暂停视频'}
          title={paused ? '播放' : '暂停'}
        >
          {paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
        </button>
        <input
          className="video-range video-seek"
          type="range"
          min="0"
          max={duration > 0 ? duration : 0.01}
          step="0.01"
          value={Math.min(currentTime, duration > 0 ? duration : 0)}
          aria-label="视频进度"
          aria-valuetext={`${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`}
          style={{ '--video-range-progress': `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const video = videoRef.current;
            if (!video) return;
            const nextTime = Number(event.currentTarget.value);
            video.currentTime = nextTime;
            setCurrentTime(nextTime);
          }}
        />
        <output className="video-time" aria-label="视频时间">
          {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
        </output>
        <button
          className="video-control-button"
          type="button"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            setMuted(video.muted);
          }}
          aria-label={muted ? '打开声音' : '静音'}
          aria-pressed={muted}
          title={muted ? '打开声音' : '静音'}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          className="video-range video-volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={muted ? 0 : volume}
          aria-label="视频音量"
          aria-valuetext={`${Math.round(volumeProgress)}%`}
          style={{ '--video-range-progress': `${volumeProgress}%` } as CSSProperties}
          onChange={(event) => {
            const video = videoRef.current;
            if (!video) return;
            const nextVolume = Number(event.currentTarget.value);
            video.volume = nextVolume;
            video.muted = nextVolume === 0;
            setVolume(nextVolume);
            setMuted(video.muted);
          }}
        />
      </div>
    </div>
  );
}

function OutputPreview({ node }: { node: StudioNode }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { importedMedia, kind, outputs, prompt, status, progress } = node.data;
  const EmptyIcon = iconByKind[kind];
  if (kind === 'storyboard') return <StoryboardPanel node={node} />;

  if (status === 'running') {
    return (
      <div className="node-progress">
        <div className="node-progress-head">
          <LoaderCircle className="spin" size={15} />
          <span>{importedMedia ? '导入中' : '生成中'} {progress}%</span>
        </div>
        <div className="progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
    );
  }

  if (kind === 'text') {
    return (
      <textarea
        className="node-text-editor nodrag nowheel"
        value={outputs.text ?? ''}
        placeholder="在这里直接填写或修改剧本…"
        aria-label="剧本内容"
        onChange={(event) => updateNodeData(node.id, {
          outputs: { ...outputs, text: event.currentTarget.value },
        })}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      />
    );
  }

  if (outputs.imageUrl) {
    return (
      <div className="media-preview image-preview nodrag nowheel">
        <img src={outputs.imageUrl} alt="generated preview" />
        <span>{importedMedia ? importedMediaLabel.image : '图像结果'}</span>
        <MediaDownloadButton url={outputs.fileUrl || outputs.imageUrl} />
      </div>
    );
  }

  if (outputs.videoUrl) {
    return (
      <VideoOutputPreview
        label={importedMedia ? importedMediaLabel.video : '视频结果'}
        src={outputs.videoUrl}
        downloadUrl={outputs.fileUrl}
      />
    );
  }

  if (outputs.audioUrl) {
    return (
      <div
        className="audio-preview nodrag nowheel"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Music size={20} />
        <span>{outputs.text ?? '音频结果已生成'}</span>
        <audio className="nodrag nowheel" src={outputs.audioUrl} controls />
      </div>
    );
  }

  if (outputs.editPlan) {
    return (
      <div className="video-edit-plan-preview nodrag nowheel">
        <div>
          <strong>AI 剪辑方案已生成</strong>
          <span>
            {outputs.editPlan.clips.length} 个片段 ·{' '}
            {outputs.editPlan.clips.some((clip) => clip.transition?.type === 'crossfade') ? '含交叉淡化' : '硬切'}
          </span>
        </div>
        <ol>
          {outputs.editPlan.clips.slice(0, 5).map((clip, index) => (
            <li key={`${clip.referenceKey ?? clip.sourceIndex ?? index}-${index}`}>
              <span>{index + 1}</span>
              <strong>{clip.referenceKey ?? `素材 ${Number(clip.sourceIndex ?? index) + 1}`}</strong>
              <small>
                {typeof clip.in === 'number'
                  ? `${clip.in.toFixed(1)}s`
                  : typeof clip.inMs === 'number'
                    ? `${(clip.inMs / 1000).toFixed(1)}s`
                    : '开头'}{' '}
                →{' '}
                {typeof clip.out === 'number'
                  ? `${clip.out.toFixed(1)}s`
                  : typeof clip.outMs === 'number'
                    ? `${(clip.outMs / 1000).toFixed(1)}s`
                    : '结尾'}
              </small>
            </li>
          ))}
        </ol>
        <span className="video-edit-plan-hint">点击下方发送按钮按此方案渲染</span>
      </div>
    );
  }

  if ((kind === 'asset' || kind === 'upload') && outputs.assetName) {
    return (
      <div className="asset-preview">
        <FileStack size={22} />
        <strong>{outputs.assetName}</strong>
        <span>{outputs.text}</span>
      </div>
    );
  }

  if (outputs.text) return <div className="text-preview">{outputs.text}</div>;

  if (!composerNodeKinds.has(kind) && prompt.trim()) {
    return (
      <div className={`prompt-preview prompt-preview-${kind}`}>
        <EmptyIcon size={32} />
        <strong>{prompt}</strong>
        <span>输入提示词开始创作</span>
      </div>
    );
  }

  return (
    <div className="empty-preview">
      <EmptyIcon size={34} />
      {!composerNodeKinds.has(kind) && <span>输入提示词开始创作</span>}
    </div>
  );
}

export function StudioNodeCard({ id, data, selected }: NodeProps<StudioNode>) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const focusNodeAsTarget = useCanvasStore((state) => state.focusNodeAsTarget);
  const runNode = useCanvasStore((state) => state.runNode);
  const mediaNodeResize = useSettingsStore((state) => state.settings.mediaNodeResize);
  const titleScaleWithCanvas = useSettingsStore((state) => state.settings.titleScaleWithCanvas);
  const videoNodeInfo = useSettingsStore((state) => state.settings.videoNodeInfo);
  const { zoom } = useViewport();
  const importedMedia = data.importedMedia;
  const Icon = importedMedia ? iconByKind[importedMedia.type] : iconByKind[data.kind];
  const running = data.status === 'running';
  const isComposerNode = composerNodeKinds.has(data.kind);
  const isImportedMedia = data.kind === 'asset' && Boolean(importedMedia);
  const isResizableMedia = data.kind === 'image' || data.kind === 'video' || importedMedia?.type === 'image' || importedMedia?.type === 'video';
  const titleCounterScale = titleScaleWithCanvas ? 1 : Math.max(0.58, Math.min(3.4, 1 / Math.max(zoom, 0.1)));
  const videoInfo = data.kind === 'video'
    ? [
        data.providerOptions?.resolution ?? data.providerOptions?.resolutionTier ?? '自适应',
        data.providerOptions?.fps ? `${data.providerOptions.fps} fps` : '',
        data.providerOptions?.duration ? `${data.providerOptions.duration}s` : '',
      ].filter(Boolean).join(' · ')
    : '';
  const hasOutput = hasNodeOutput({ id, type: 'studioNode', position: { x: 0, y: 0 }, data });

  return (
    <article
      className={`studio-node kind-${data.kind} ${isComposerNode ? 'is-composer-node' : ''} ${hasOutput ? 'has-output' : 'is-empty-node'} ${isImportedMedia ? `has-imported-media media-${importedMedia?.type}` : ''} ${data.uiRelation ? `is-${data.uiRelation}` : ''} ${titleScaleWithCanvas ? 'title-scales-with-canvas' : 'title-screen-fixed'} ${selected ? 'is-selected' : ''}`}
      style={{ '--node-title-counter-scale': titleCounterScale } as CSSProperties}
      onPointerDownCapture={(event) => {
        if (!isInteractiveTarget(event.target)) focusNodeAsTarget(id);
      }}
      onClick={(event) => {
        if (!isInteractiveTarget(event.target)) focusNodeAsTarget(id);
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected && mediaNodeResize && isResizableMedia)}
        minWidth={240}
        minHeight={150}
        maxWidth={980}
        maxHeight={820}
        keepAspectRatio
        color="var(--relation-highlight, #7493ff)"
        handleClassName="studio-node-resize-handle"
        lineClassName="studio-node-resize-line"
      />
      <div className="node-handle-hotspot node-handle-hotspot-in">
        <Handle className="node-handle node-handle-in" id="node-input" type="target" position={Position.Left} />
      </div>
      <header className="node-card-header">
        <div className="node-title-wrap">
          <Icon size={17} />
          <input
            className="node-title-input"
            value={data.title}
            onChange={(event) => updateNodeData(id, { title: event.currentTarget.value })}
          />
        </div>
        {!isComposerNode && !isImportedMedia && (
          <span className="node-model-label">
            {`${labelByKind[data.kind]} · ${data.model}`}
          </span>
        )}
        {!isComposerNode && !isImportedMedia && <span className={`status-badge status-${data.status}`}>{data.status}</span>}
      </header>

      <section className={`node-glass-surface ${hasOutput ? 'has-output' : 'is-empty'}`}>
        <OutputPreview node={{ id, type: 'studioNode', position: { x: 0, y: 0 }, data }} />
        {!hasOutput && !isComposerNode && (
          <textarea
            className="node-prompt"
            value={data.prompt}
            placeholder="输入提示词开始创作"
            onChange={(event) => updateNodeData(id, { prompt: event.currentTarget.value })}
          />
        )}
      </section>

      {videoNodeInfo && videoInfo && <div className="node-video-info">{videoInfo}</div>}

      {data.error && <div className="node-error">{displayNodeError(data.error)}</div>}

      {!isComposerNode && (
        <footer className="node-card-footer">
          <span>
            {importedMedia
              ? `${importedMediaLabel[importedMedia.type]} · ${readableFileSize(importedMedia.size)}`
              : data.provider}
          </span>
          {isImportedMedia ? (
            <span className={`imported-media-state state-${data.status}`}>
              {data.status === 'running' ? '导入中' : data.status === 'error' ? '导入失败' : '已导入'}
            </span>
          ) : (
            <button type="button" disabled={running} onClick={() => void runNode(id)}>
              {running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              <span>{running ? '运行中' : '生成'}</span>
            </button>
          )}
        </footer>
      )}
      <div className="node-handle-hotspot node-handle-hotspot-out">
        <Handle className="node-handle node-handle-out" id="node-output" type="source" position={Position.Right} />
      </div>
    </article>
  );
}
