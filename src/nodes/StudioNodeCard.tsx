import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Box,
  FileStack,
  Globe2,
  Image,
  LayoutGrid,
  LoaderCircle,
  Music,
  Play,
  Sparkles,
  Table2,
  Text,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import type { NodeKind, StudioNode } from '../types';

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

function OutputPreview({ node }: { node: StudioNode }) {
  const { kind, outputs, status, progress } = node.data;
  if (status === 'running') {
    return (
      <div className="node-progress">
        <div className="node-progress-head">
          <LoaderCircle className="spin" size={15} />
          <span>生成中 {progress}%</span>
        </div>
        <div className="progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
    );
  }

  if (kind === 'image' && outputs.imageUrl) {
    return (
      <div className="media-preview image-preview">
        <img src={outputs.imageUrl} alt="generated preview" />
        <span>图像结果</span>
      </div>
    );
  }

  if (kind === 'video' && outputs.videoUrl) {
    return (
      <div className="media-preview video-preview">
        <video src={outputs.videoUrl} muted playsInline controls />
        <div className="video-play">
          <Play size={20} fill="currentColor" />
        </div>
        <span>视频结果</span>
      </div>
    );
  }

  if (kind === 'audio' && outputs.audioUrl) {
    return (
      <div className="audio-preview">
        <Music size={20} />
        <span>{outputs.text ?? '音频结果已生成'}</span>
        <audio src={outputs.audioUrl} controls />
      </div>
    );
  }

  if (outputs.imageUrl) {
    return (
      <div className="media-preview image-preview">
        <img src={outputs.imageUrl} alt="mock preview" />
        <span>{labelByKind[kind]}结果</span>
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

  return (
    <div className="empty-preview">
      <Sparkles size={16} />
      <span>等待生成或连接上游节点</span>
    </div>
  );
}

export function StudioNodeCard({ id, data, selected }: NodeProps<StudioNode>) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runNode = useCanvasStore((state) => state.runNode);
  const Icon = iconByKind[data.kind];
  const running = data.status === 'running';

  return (
    <article className={`studio-node kind-${data.kind} ${selected ? 'is-selected' : ''}`}>
      <Handle className="node-handle node-handle-in" type="target" position={Position.Left} />
      <header className="node-card-header">
        <div className="node-kind-icon">
          <Icon size={17} />
        </div>
        <div className="node-title-wrap">
          <input
            className="node-title-input"
            value={data.title}
            onChange={(event) => updateNodeData(id, { title: event.currentTarget.value })}
          />
          <span>{labelByKind[data.kind]} · {data.model}</span>
        </div>
        <span className={`status-badge status-${data.status}`}>{data.status}</span>
      </header>

      <textarea
        className="node-prompt"
        value={data.prompt}
        placeholder="输入提示词、素材名或节点说明"
        onChange={(event) => updateNodeData(id, { prompt: event.currentTarget.value })}
      />

      <OutputPreview node={{ id, type: 'studioNode', position: { x: 0, y: 0 }, data }} />

      {data.error && <div className="node-error">{data.error}</div>}

      <footer className="node-card-footer">
        <span>{data.provider}</span>
        <button type="button" disabled={running} onClick={() => void runNode(id)}>
          {running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
          <span>{running ? '运行中' : '生成'}</span>
        </button>
      </footer>
      <Handle className="node-handle node-handle-out" type="source" position={Position.Right} />
    </article>
  );
}
