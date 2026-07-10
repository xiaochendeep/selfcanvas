import { FileText, Image, Music, PanelsTopLeft, Upload, Video, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import type { NodeKind } from '../types';

export type ConnectionCreateMode = 'input' | 'output';

interface ConnectionCreateMenuProps {
  mode: ConnectionCreateMode;
  targetKind?: NodeKind;
  x: number;
  y: number;
  onClose: () => void;
  onCreate: (kind: NodeKind) => void;
}

interface ConnectionOption {
  kind: NodeKind;
  label: string;
  icon: LucideIcon;
  beta?: boolean;
}

const outputOptions: ConnectionOption[] = [
  { kind: 'text', label: '文本', icon: FileText },
  { kind: 'image', label: '图像', icon: Image },
  { kind: 'video', label: '视频', icon: Video },
  { kind: 'storyboard', label: '分镜脚本', icon: PanelsTopLeft, beta: true },
  { kind: 'panorama', label: '360全景图', icon: Image },
];

function inputOptionsFor(kind?: NodeKind): ConnectionOption[] {
  if (kind === 'image') {
    return [
      { kind: 'asset', label: '源图像', icon: Image },
      { kind: 'image', label: '图像', icon: Image },
      { kind: 'text', label: '文本', icon: FileText },
    ];
  }

  if (kind === 'video') {
    return [
      { kind: 'asset', label: '源图像', icon: Image },
      { kind: 'video', label: '源视频', icon: Video },
      { kind: 'text', label: '文本', icon: FileText },
    ];
  }

  if (kind === 'audio') {
    return [
      { kind: 'audio', label: '参考音频', icon: Music },
      { kind: 'text', label: '文本脚本', icon: FileText },
      { kind: 'upload', label: '上传素材', icon: Upload },
    ];
  }

  return [
    { kind: 'text', label: '文本', icon: FileText },
    { kind: 'image', label: '图像', icon: Image },
    { kind: 'video', label: '视频', icon: Video },
  ];
}

export function ConnectionCreateMenu({ mode, targetKind, x, y, onClose, onCreate }: ConnectionCreateMenuProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const title = mode === 'input' ? '创建输入节点' : '引用该节点生成';
  const options = mode === 'input' ? inputOptionsFor(targetKind) : outputOptions;

  return (
    <section className={`connection-create-menu mode-${mode}`} style={{ left: x, top: y }} aria-label={title}>
      <h2>{title}</h2>
      <div className="connection-create-list">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.kind} type="button" onClick={() => onCreate(option.kind)}>
              <span>
                <Icon size={22} />
              </span>
              <strong>{option.label}</strong>
              {option.beta && <em>BETA</em>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
