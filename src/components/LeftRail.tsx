import { Download, FileStack, FolderOpen, Grid3X3, Plus, Settings } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';

function exportProject() {
  const project = useCanvasStore.getState().project;
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.name || 'canvaspro-project'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LeftRail() {
  const addPanelOpen = useCanvasStore((state) => state.addPanelOpen);
  const setAddPanelOpen = useCanvasStore((state) => state.setAddPanelOpen);

  return (
    <aside className="left-rail" aria-label="工具栏">
      <button
        className={`rail-button rail-button-primary ${addPanelOpen ? 'is-active' : ''}`}
        type="button"
        onClick={() => setAddPanelOpen(!addPanelOpen)}
        title="添加节点"
      >
        <Plus size={25} />
      </button>
      <button className="rail-button" type="button" title="素材">
        <FileStack size={21} />
      </button>
      <button className="rail-button" type="button" title="项目">
        <FolderOpen size={21} />
      </button>
      <button className="rail-button" type="button" title="工作流">
        <Grid3X3 size={21} />
      </button>
      <button className="rail-button" type="button" title="导出 JSON" onClick={exportProject}>
        <Download size={21} />
      </button>
      <div className="rail-fill" />
      <button className="rail-button" type="button" title="设置">
        <Settings size={21} />
      </button>
    </aside>
  );
}

