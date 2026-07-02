import type { StudioProject } from '../types';

const STORAGE_KEY = 'canvaspro-ui-studio.project.v1';

export interface ProjectRepository {
  load(): StudioProject | null;
  save(project: StudioProject): void;
  clear(): void;
}

export class LocalStorageProjectRepository implements ProjectRepository {
  load(): StudioProject | null {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StudioProject;
      if (!parsed || !Array.isArray(parsed.canvases) || !parsed.activeCanvasId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(project: StudioProject): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  }

  clear(): void {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export const projectRepository = new LocalStorageProjectRepository();

