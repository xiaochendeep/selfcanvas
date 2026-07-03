import { FolderOpen, Grid3X3, ListChecks, PanelRightOpen, Plus, Settings, Upload, X } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';

export type RailPanelId = 'canvases' | 'assets' | 'workflows' | 'files' | 'tasks';

interface LeftRailProps {
  activePanel: RailPanelId | null;
  onPanelChange: (panel: RailPanelId | null) => void;
}

export function LeftRail({ activePanel, onPanelChange }: LeftRailProps) {
  const addPanelOpen = useCanvasStore((state) => state.addPanelOpen);
  const setAddPanelOpen = useCanvasStore((state) => state.setAddPanelOpen);

  const openAddPanel = () => {
    onPanelChange(null);
    setAddPanelOpen(true);
  };

  const toggleAddPanel = () => {
    onPanelChange(null);
    setAddPanelOpen(!addPanelOpen);
  };

  const togglePanel = (panel: RailPanelId) => {
    setAddPanelOpen(false);
    onPanelChange(activePanel === panel ? null : panel);
  };

  return (
    <aside className="left-rail" aria-label="工具栏">
      <button
        className={`rail-button rail-button-primary ${addPanelOpen ? 'is-active' : ''}`}
        type="button"
        onFocus={openAddPanel}
        onMouseEnter={openAddPanel}
        onMouseMove={openAddPanel}
        onMouseOver={openAddPanel}
        onPointerEnter={openAddPanel}
        onPointerMove={openAddPanel}
        onClick={toggleAddPanel}
        title={addPanelOpen ? '关闭节点菜单' : '添加节点'}
      >
        {addPanelOpen ? <X size={32} strokeWidth={2.8} /> : <Plus size={25} />}
      </button>
      <button
        className={`rail-button ${activePanel === 'canvases' ? 'is-active' : ''}`}
        type="button"
        title="AI 画布"
        onClick={() => togglePanel('canvases')}
      >
        <PanelRightOpen size={21} />
      </button>
      <button
        className={`rail-button ${activePanel === 'assets' ? 'is-active' : ''}`}
        type="button"
        title="资产"
        onClick={() => togglePanel('assets')}
      >
        <Upload size={22} />
      </button>
      <button
        className={`rail-button ${activePanel === 'workflows' ? 'is-active' : ''}`}
        type="button"
        title="工作流"
        onClick={() => togglePanel('workflows')}
      >
        <Grid3X3 size={21} />
      </button>
      <button
        className={`rail-button ${activePanel === 'files' ? 'is-active' : ''}`}
        type="button"
        title="文件管理"
        onClick={() => togglePanel('files')}
      >
        <FolderOpen size={21} />
      </button>
      <button
        className={`rail-button ${activePanel === 'tasks' ? 'is-active' : ''}`}
        type="button"
        title="任务列表"
        onClick={() => togglePanel('tasks')}
      >
        <ListChecks size={21} />
      </button>
      <div className="rail-fill" />
      <button className="rail-button" type="button" title="设置">
        <Settings size={21} />
      </button>
    </aside>
  );
}
