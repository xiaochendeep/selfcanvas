import {
  ArrowDownUp,
  Image,
  ListChecks,
  Map,
  Package,
  Plus,
  Search,
  Sparkles,
  UserRound,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { desktopTaskProvider } from '../services/desktopTaskProvider';
import { useCanvasStore } from '../store/canvasStore';
import type { DesktopTask, DesktopTaskCapability } from '../types';
import type { RailPanelId } from './LeftRail';

interface RailPanelsProps {
  activePanel: RailPanelId | null;
  onPanelChange: (panel: RailPanelId | null) => void;
}

const assetTabs = [
  { id: 'people', label: '人物', empty: '暂无人物资产', icon: UserRound },
  { id: 'scene', label: '场景', empty: '暂无场景资产', icon: Map },
  { id: 'object', label: '物品', empty: '暂无物品资产', icon: Package },
] as const;

const fileTabs = ['当前画布生成', '历史生成', '输出文件夹'] as const;
const mediaFilters = [
  { label: '所有', icon: Sparkles },
  { label: '图像', icon: Image },
  { label: '视频', icon: Video },
  { label: '声音', icon: Volume2 },
] as const;

const mediaItems = [
  { title: '窗边小猫', palette: ['#f7ead6', '#b98b58', '#11131a'], shape: 'circle' },
  { title: '参考小猫', palette: ['#efe5d5', '#8b5d36', '#1a1d24'], shape: 'circle' },
  { title: '红色能量场', palette: ['#1b0508', '#c30c1e', '#ff3f2f'], shape: 'wave' },
  { title: '草原蒙古包', palette: ['#8fd6ff', '#57a862', '#e7eef8'], shape: 'landscape' },
  { title: '视频预览', palette: ['#f4d7b4', '#bf8051', '#20160f'], shape: 'circle' },
  { title: '狗狗素材', palette: ['#f5dcc1', '#d38a43', '#2a1f1a'], shape: 'portrait' },
];

function thumbnail(title: string, palette: string[], shape: string) {
  const visual =
    shape === 'wave'
      ? `<path d="M0 190 C120 88 214 226 330 112 C434 22 520 132 640 74 L640 360 L0 360 Z" fill="${palette[1]}" opacity=".62"/><path d="M42 282 C184 182 264 300 420 174 C494 114 548 146 624 90" fill="none" stroke="${palette[2]}" stroke-width="18" opacity=".7"/>`
      : shape === 'landscape'
        ? `<rect y="0" width="640" height="180" fill="${palette[0]}"/><path d="M0 190 C94 126 166 190 254 132 C350 70 444 174 640 86 L640 360 L0 360 Z" fill="${palette[1]}"/><rect x="74" y="204" width="156" height="62" rx="31" fill="${palette[2]}" opacity=".9"/><rect x="272" y="218" width="118" height="50" rx="25" fill="${palette[2]}" opacity=".86"/>`
        : `<circle cx="246" cy="158" r="108" fill="${palette[1]}" opacity=".86"/><ellipse cx="332" cy="218" rx="176" ry="90" fill="${palette[0]}" opacity=".82"/><rect x="78" y="54" width="484" height="252" rx="30" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="1" stop-color="#090a0e"/></linearGradient></defs><rect width="640" height="360" fill="url(#bg)"/>${visual}<text x="34" y="328" fill="rgba(255,255,255,.74)" font-family="Inter,Arial,sans-serif" font-size="24" font-weight="800">${title}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

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
  const [activeTab, setActiveTab] = useState<(typeof fileTabs)[number]>('当前画布生成');
  const thumbnails = useMemo(
    () => mediaItems.map((item) => ({ ...item, src: thumbnail(item.title, item.palette, item.shape) })),
    [],
  );

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
      <div className="media-filter-row">
        <div className="media-filters">
          {mediaFilters.map((filter, index) => {
            const Icon = filter.icon;
            return (
              <button className={index === 0 ? 'is-active' : ''} key={filter.label} type="button">
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
      <div className="media-grid">
        {thumbnails.map((item) => (
          <button className="media-card" key={item.title} type="button">
            <img src={item.src} alt={item.title} />
          </button>
        ))}
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
  const [capability, setCapability] = useState<DesktopTaskCapability>({
    available: false,
    reason: '当前 Web 环境无法访问桌面后台任务',
  });
  const [tasks, setTasks] = useState<DesktopTask[]>([]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([desktopTaskProvider.getCapability(), desktopTaskProvider.listTasks()]).then(
      ([nextCapability, nextTasks]) => {
        if (!mounted) return;
        setCapability(nextCapability);
        setTasks(nextTasks);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <PanelShell className="rail-panel-tasks" title="任务" onClose={onClose}>
      <div className="task-panel-status">
        {capability.available ? '桌面后台任务已连接' : '当前环境没有桌面后台任务'}
      </div>
      {tasks.length > 0 ? (
        <div className="desktop-task-list">
          {tasks.map((task) => (
            <article className={`desktop-task-card task-${task.status}`} key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <span>{task.message ?? task.status}</span>
              </div>
              <span>{task.progress}%</span>
            </article>
          ))}
        </div>
      ) : (
        <div className="task-empty">
          <ListChecks size={30} />
          <span>{capability.available ? '暂无后台任务' : '桌面任务不可用'}</span>
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
  return <CanvasPanel onClose={close} />;
}
