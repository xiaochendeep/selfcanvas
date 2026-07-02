import { FileStack, Image, Text, Video } from 'lucide-react';
import { nodePresets, useCanvasStore } from '../store/canvasStore';
import type { NodeKind } from '../types';

const iconByKind: Record<NodeKind, typeof Text> = {
  text: Text,
  image: Image,
  video: Video,
  asset: FileStack,
};

const descriptions: Record<NodeKind, string> = {
  text: '文案、脚本、提示词扩写',
  image: '文生图、参考图、视觉结果',
  video: '图生视频、镜头预览、成片占位',
  asset: '本地素材、角色图、音视频引用',
};

export function AddNodePanel({ compact = false }: { compact?: boolean }) {
  const addNode = useCanvasStore((state) => state.addNode);
  const setAddPanelOpen = useCanvasStore((state) => state.setAddPanelOpen);
  const setQuickPanelOpen = useCanvasStore((state) => state.setQuickPanelOpen);
  const entries = Object.values(nodePresets);

  return (
    <div className={compact ? 'quick-node-grid' : 'add-node-panel'}>
      {entries.map((preset) => {
        const Icon = iconByKind[preset.kind];
        return (
          <button
            key={preset.kind}
            type="button"
            onClick={() => {
              addNode(preset.kind);
              setAddPanelOpen(false);
              setQuickPanelOpen(false);
            }}
          >
            <span className={`node-option-icon icon-${preset.kind}`}>
              <Icon size={compact ? 17 : 20} />
            </span>
            <span>
              <strong>{preset.title}</strong>
              {!compact && <small>{descriptions[preset.kind]}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

