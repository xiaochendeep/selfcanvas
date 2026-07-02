import {
  Box,
  FileStack,
  Globe2,
  Image,
  LayoutGrid,
  Music,
  PenLine,
  Table2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { nodePresets, useCanvasStore } from '../store/canvasStore';
import type { NodeKind } from '../types';

interface NodeMenuItem {
  kind: NodeKind;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

interface NodeMenuSection {
  title: string;
  items: NodeMenuItem[];
}

const iconByKind: Record<NodeKind, LucideIcon> = {
  text: PenLine,
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

const descriptions: Partial<Record<NodeKind, string>> = {
  text: '文案、脚本、提示词扩写',
  image: '文生图、参考图、视觉结果',
  video: '图生视频、镜头预览、成片占位',
  asset: '本地素材、角色图、音视频引用',
};

const compactKinds: NodeKind[] = ['text', 'image', 'video', 'asset'];

const menuSections: NodeMenuSection[] = [
  {
    title: '生成节点',
    items: [
      { kind: 'text', label: '文本', icon: PenLine },
      { kind: 'image', label: '图像', icon: Image },
      { kind: 'video', label: '视频', icon: Video },
      { kind: 'audio', label: '音频', icon: Music },
    ],
  },
  {
    title: '功能节点',
    items: [
      { kind: 'stage3d', label: '3D导演台', icon: Globe2 },
      { kind: 'panorama', label: '360全景图', icon: Globe2 },
      { kind: 'storyboard', label: '分镜脚本', icon: Table2, badge: 'BETA' },
      { kind: 'collage', label: '拼图', icon: LayoutGrid },
    ],
  },
  {
    title: '添加资源',
    items: [{ kind: 'upload', label: '上传文件', icon: Upload }],
  },
];

export function AddNodePanel({ compact = false }: { compact?: boolean }) {
  const addNode = useCanvasStore((state) => state.addNode);
  const setAddPanelOpen = useCanvasStore((state) => state.setAddPanelOpen);
  const setQuickPanelOpen = useCanvasStore((state) => state.setQuickPanelOpen);

  const handleAdd = (kind: NodeKind) => {
    addNode(kind);
    setAddPanelOpen(false);
    setQuickPanelOpen(false);
  };

  if (compact) {
    return (
      <div className="quick-node-grid">
        {compactKinds.map((kind) => {
          const preset = nodePresets[kind];
          const Icon = iconByKind[kind];
          return (
            <button key={kind} type="button" onClick={() => handleAdd(kind)}>
              <span className={`node-option-icon icon-${kind}`}>
                <Icon size={17} />
              </span>
              <span>
                <strong>{preset.title}</strong>
                <small>{descriptions[kind]}</small>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="add-node-menu">
      {menuSections.map((section) => (
        <section className="add-node-section" key={section.title}>
          <div className="add-node-section-title">
            <span>{section.title}</span>
            <i />
          </div>
          <div className="add-node-list">
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={`add-node-list-item menu-kind-${item.kind}`}
                  key={item.kind}
                  type="button"
                  onClick={() => handleAdd(item.kind)}
                >
                  <span className="add-node-list-icon">
                    <Icon size={29} />
                  </span>
                  <span className="add-node-list-label">{item.label}</span>
                  {item.badge && <span className="node-beta-badge">{item.badge}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
