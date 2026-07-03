import { CircleDot, Plus, RotateCcw } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';

export function TopBar() {
  const project = useCanvasStore((state) => state.project);
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const createCanvas = useCanvasStore((state) => state.createCanvas);
  const resetProject = useCanvasStore((state) => state.resetProject);
  const lastSavedAt = useCanvasStore((state) => state.lastSavedAt);

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark">
          <CircleDot size={23} />
        </div>
        <span>SelfCanvas</span>
      </div>
      <div className="canvas-tabs" aria-label="画布分页">
        <button className="canvas-tab is-active" type="button">
          {activeCanvas.name}
          <span>{activeCanvas.nodes.length}</span>
        </button>
        <button className="canvas-tab-add" type="button" onClick={createCanvas} title="新建画布">
          <Plus size={16} />
        </button>
      </div>
      <div className="topbar-spacer" />
      <div className="status-pill">
        <span className="status-dot" />
        已自动保存 {new Date(lastSavedAt || project.updatedAt).toLocaleTimeString()}
      </div>
      <button className="ghost-action" type="button" onClick={resetProject} title="重置演示项目">
        <RotateCcw size={16} />
      </button>
      <div className="version-badge">V 0.1.0</div>
    </header>
  );
}
