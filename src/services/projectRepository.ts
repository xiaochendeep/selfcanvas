import type { StudioProject } from '../types';
import { browserApiFetch } from './browserSession';
import { hasNewerDurablePendingProject, projectsHaveSameDurableContent } from './projectSyncPolicy';

const STORAGE_KEY = 'canvaspro-ui-studio.project.v1';
const SYNC_META_KEY = 'selfcanvas.project-sync.v1';
const REMOTE_SAVE_DELAY_MS = 450;

export type ProjectSyncStatus = 'local' | 'syncing' | 'synced' | 'offline' | 'conflict';

export interface ProjectSnapshot {
  schemaVersion: number;
  revision: number;
  savedAt: string;
  project: StudioProject | null;
}

interface SyncMeta {
  revision: number;
  syncedUpdatedAt: string;
}

export interface ProjectRepository {
  hasLocalProject(): boolean;
  load(): StudioProject | null;
  loadRemote(): Promise<ProjectSnapshot>;
  bootstrap(localProject: StudioProject, hadLocalProject: boolean): Promise<StudioProject | null>;
  refresh(localProject: StudioProject): Promise<StudioProject | null>;
  adoptRemoteAfterConflict(localProject: StudioProject): Promise<StudioProject | null>;
  save(project: StudioProject): void;
  saveLocal(project: StudioProject): void;
  flush(): Promise<void>;
  clear(): void;
  getSyncStatus(): ProjectSyncStatus;
  getRevision(): number;
  subscribeStatus(listener: (status: ProjectSyncStatus) => void): () => void;
}

function validProject(value: unknown): value is StudioProject {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<StudioProject>;
  return Boolean(project.activeCanvasId && Array.isArray(project.canvases) && project.canvases.length);
}

const pristineStarterNodes = {
  text: { title: '生成文本', prompt: '写一段适合短视频开头的悬念文案' },
  image: { title: '生成图像', prompt: '暖色窗边，一只安静的小猫，电影感光影' },
  video: { title: '生成视频', prompt: '镜头缓慢推进，角色回头，背景光线柔和' },
  asset: { title: '素材节点', prompt: 'reference-pack.png' },
} as const;

function isPristineStarterProject(project: StudioProject | null | undefined) {
  if (!project || project.canvases.length !== 1) return false;
  const canvas = project.canvases[0];
  if (project.name !== '默认画布' || canvas.name !== '默认画布' || canvas.nodes.length !== 4) return false;
  const expectedKinds = Object.keys(pristineStarterNodes) as Array<keyof typeof pristineStarterNodes>;
  return expectedKinds.every((kind) => {
    const matching = canvas.nodes.filter((node) => node.data.kind === kind);
    if (matching.length !== 1) return false;
    const node = matching[0];
    const expected = pristineStarterNodes[kind];
    return (
      node.data.title === expected.title &&
      node.data.prompt === expected.prompt &&
      node.data.status === 'idle' &&
      !node.data.importedMedia &&
      !(node.data.references ?? []).length &&
      !Object.values(node.data.outputs ?? {}).some(Boolean)
    );
  });
}

function serializedEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Pull only server-owned generation state into a locally edited project.
 *
 * The job id is the compare-and-swap token here: a result from an older run
 * must never be allowed to replace the output of a newer run on the same node.
 * All user-editable node fields remain local when the projects have diverged.
 */
export function projectServerJobState(localProject: StudioProject, remoteProject: StudioProject) {
  const remoteCanvases = new Map(remoteProject.canvases.map((canvas) => [canvas.id, canvas]));
  const projectedAt = new Date().toISOString();
  let projectChanged = false;
  const canvases = localProject.canvases.map((localCanvas) => {
    const remoteCanvas = remoteCanvases.get(localCanvas.id);
    if (!remoteCanvas) return localCanvas;
    const remoteNodes = new Map(remoteCanvas.nodes.map((node) => [node.id, node]));
    let canvasChanged = false;
    const nodes = localCanvas.nodes.map((localNode) => {
      const remoteNode = remoteNodes.get(localNode.id);
      if (!remoteNode) return localNode;
      const localJobId = String(localNode.data.lastJobId || '');
      const remoteJobId = String(remoteNode.data.lastJobId || '');
      if (!localJobId || localJobId !== remoteJobId) return localNode;

      const localStatus = localNode.data.status;
      const remoteStatus = remoteNode.data.status;
      const localProgress = Number(localNode.data.progress || 0);
      const remoteProgress = Number(remoteNode.data.progress || 0);
      const remoteIsTerminal = remoteStatus === 'success' || remoteStatus === 'error';
      const shouldAdvanceRunning =
        remoteStatus === 'running' &&
        localStatus !== 'success' &&
        localStatus !== 'error' &&
        remoteProgress > localProgress;
      const terminalStateDiffers =
        remoteIsTerminal &&
        (localStatus !== remoteStatus ||
          localProgress !== remoteProgress ||
          String(localNode.data.error || '') !== String(remoteNode.data.error || '') ||
          !serializedEqual(localNode.data.outputs ?? {}, remoteNode.data.outputs ?? {}));
      if (!shouldAdvanceRunning && !terminalStateDiffers) return localNode;

      canvasChanged = true;
      projectChanged = true;
      return {
        ...localNode,
        data: {
          ...localNode.data,
          status: remoteStatus,
          progress: remoteProgress,
          outputs: remoteNode.data.outputs ?? {},
          error: String(remoteNode.data.error || ''),
          provider: remoteNode.data.provider || localNode.data.provider,
          model: remoteNode.data.model || localNode.data.model,
          lastJobId: localJobId,
        },
      };
    });
    return canvasChanged
      ? { ...localCanvas, nodes, updatedAt: projectedAt }
      : localCanvas;
  });
  if (!projectChanged) return null;
  return {
    ...localProject,
    canvases,
    // Keep this distinct from the remote snapshot timestamp: the result was
    // projected into a divergent local document, not accepted wholesale.
    updatedAt: projectedAt,
  };
}

class HybridProjectRepository implements ProjectRepository {
  private revision = 0;
  private status: ProjectSyncStatus = 'local';
  private listeners = new Set<(status: ProjectSyncStatus) => void>();
  private pendingProject: StudioProject | null = null;
  private saveTimer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private remoteReady = false;
  private durableDirty = false;

  constructor() {
    try {
      const meta = JSON.parse(window.localStorage.getItem(SYNC_META_KEY) || '{}') as Partial<SyncMeta>;
      this.revision = Number(meta.revision || 0);
    } catch {
      this.revision = 0;
    }
  }

  private readSyncMeta(): SyncMeta | null {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SYNC_META_KEY) || 'null') as Partial<SyncMeta> | null;
      if (!parsed || !Number.isFinite(Number(parsed.revision))) return null;
      return {
        revision: Number(parsed.revision),
        syncedUpdatedAt: String(parsed.syncedUpdatedAt || ''),
      };
    } catch {
      return null;
    }
  }

  hasLocalProject() {
    return Boolean(window.localStorage.getItem(STORAGE_KEY));
  }

  load() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as unknown;
      return validProject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  saveLocal(project: StudioProject) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  }

  save(project: StudioProject) {
    this.saveLocal(project);
    this.pendingProject = project;
    this.durableDirty = true;
    // A conflict is sticky until the browser explicitly refreshes/reconciles.
    // Advancing the local revision and then flushing the old full document
    // would make the next CAS succeed and silently overwrite the other writer.
    if (!this.remoteReady || this.status === 'conflict') return;
    this.scheduleRemoteSave();
  }

  clear() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(SYNC_META_KEY);
    this.pendingProject = null;
    this.durableDirty = false;
  }

  getSyncStatus() {
    return this.status;
  }

  getRevision() {
    return this.revision;
  }

  subscribeStatus(listener: (status: ProjectSyncStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: ProjectSyncStatus) {
    this.status = status;
    this.listeners.forEach((listener) => listener(status));
  }

  private rememberSync(project: StudioProject, snapshot: ProjectSnapshot) {
    this.revision = snapshot.revision;
    window.localStorage.setItem(
      SYNC_META_KEY,
      JSON.stringify({ revision: snapshot.revision, syncedUpdatedAt: project.updatedAt } satisfies SyncMeta),
    );
  }

  async loadRemote() {
    const response = await browserApiFetch('/api/project', { cache: 'no-store' });
    if (!response.ok) throw new Error(`画布记录读取失败 (${response.status})`);
    const snapshot = await response.json() as ProjectSnapshot;
    if (snapshot.project !== null && !validProject(snapshot.project)) throw new Error('服务器画布记录格式无效');
    return snapshot;
  }

  async bootstrap(localProject: StudioProject, hadLocalProject: boolean) {
    try {
      const snapshot = await this.loadRemote();
      const syncMeta = this.readSyncMeta();
      // The UI is already interactive while the initial remote snapshot is in
      // flight. Preserve edits made during that window instead of clearing the
      // pending project and silently replacing it with the startup snapshot.
      const pendingDuringBootstrap = this.pendingProject;
      this.revision = snapshot.revision;
      this.remoteReady = true;
      if (pendingDuringBootstrap) {
        const remoteProject = snapshot.project;
        const serverIsKnownBaseline = Boolean(
          !remoteProject ||
          (syncMeta && syncMeta.revision === snapshot.revision) ||
          (remoteProject && localProject.updatedAt === remoteProject.updatedAt) ||
          (remoteProject && projectsHaveSameDurableContent(localProject, remoteProject)) ||
          (remoteProject &&
            !syncMeta &&
            isPristineStarterProject(remoteProject) &&
            !isPristineStarterProject(localProject)),
        );
        if (serverIsKnownBaseline) {
          this.pendingProject = pendingDuringBootstrap;
          this.durableDirty = true;
          await this.flush();
          return pendingDuringBootstrap;
        }
        this.durableDirty = true;
        this.setStatus('conflict');
        return remoteProject
          ? projectServerJobState(pendingDuringBootstrap, remoteProject) ?? pendingDuringBootstrap
          : pendingDuringBootstrap;
      }
      this.pendingProject = null;
      if (snapshot.project) {
        const meaningfulLegacyLocalShouldReplaceStarter = Boolean(
          hadLocalProject &&
          !syncMeta &&
          isPristineStarterProject(snapshot.project) &&
          !isPristineStarterProject(localProject),
        );
        if (meaningfulLegacyLocalShouldReplaceStarter) {
          this.pendingProject = localProject;
          this.durableDirty = true;
          await this.flush();
          return localProject;
        }
        if (hadLocalProject && localProject.updatedAt === snapshot.project.updatedAt) {
          this.durableDirty = false;
          this.saveLocal(snapshot.project);
          this.rememberSync(snapshot.project, snapshot);
          this.setStatus('synced');
          return snapshot.project;
        }
        if (hadLocalProject && projectsHaveSameDurableContent(localProject, snapshot.project)) {
          this.durableDirty = false;
          this.saveLocal(snapshot.project);
          this.rememberSync(snapshot.project, snapshot);
          this.setStatus('synced');
          return snapshot.project;
        }
        const localChangedSinceSync = Boolean(
          hadLocalProject &&
          syncMeta &&
          syncMeta.revision === snapshot.revision &&
          localProject.updatedAt !== syncMeta.syncedUpdatedAt,
        );
        if (localChangedSinceSync) {
          this.pendingProject = localProject;
          this.durableDirty = true;
          await this.flush();
          return localProject;
        }
        const divergentUnsyncedLocal = Boolean(
          hadLocalProject &&
          syncMeta &&
          syncMeta.revision !== snapshot.revision &&
          localProject.updatedAt !== syncMeta.syncedUpdatedAt,
        );
        if (divergentUnsyncedLocal) {
          const projectedProject = projectServerJobState(localProject, snapshot.project);
          this.durableDirty = true;
          this.setStatus('conflict');
          return projectedProject;
        }
        this.saveLocal(snapshot.project);
        this.durableDirty = false;
        this.rememberSync(snapshot.project, snapshot);
        this.setStatus('synced');
        return snapshot.project;
      }
      if (hadLocalProject && !isPristineStarterProject(localProject)) {
        this.durableDirty = true;
        await this.writeRemote(localProject);
        return localProject;
      }
      this.setStatus('synced');
      this.durableDirty = false;
      return null;
    } catch {
      this.remoteReady = true;
      this.setStatus('offline');
      return null;
    }
  }

  async refresh(localProject: StudioProject) {
    try {
      const previousRevision = this.revision;
      const snapshot = await this.loadRemote();
      this.remoteReady = true;
      this.revision = snapshot.revision;
      if (!snapshot.project) return null;

      if (projectsHaveSameDurableContent(localProject, snapshot.project)) {
        this.pendingProject = null;
        this.durableDirty = false;
        this.saveLocal(snapshot.project);
        this.rememberSync(snapshot.project, snapshot);
        this.setStatus('synced');
        return snapshot.project;
      }

      const canAdoptWholeSnapshot = Boolean(
        snapshot.revision >= previousRevision &&
        !this.durableDirty &&
        !this.pendingProject &&
        !this.inFlight,
      );
      if (canAdoptWholeSnapshot) {
        this.durableDirty = false;
        this.saveLocal(snapshot.project);
        this.rememberSync(snapshot.project, snapshot);
        this.setStatus('synced');
        return snapshot.project;
      }

      const projectedProject = projectServerJobState(localProject, snapshot.project);
      if (snapshot.revision > previousRevision) this.setStatus('conflict');
      return projectedProject;
    } catch {
      if (this.status !== 'conflict') this.setStatus('offline');
      return null;
    }
  }

  async adoptRemoteAfterConflict(localProject: StudioProject) {
    if (this.status !== 'conflict') return null;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.inFlight) await this.inFlight;
    window.localStorage.setItem(
      `selfcanvas.project-conflict-backup.${Date.now()}`,
      JSON.stringify(localProject),
    );
    const snapshot = await this.loadRemote();
    if (!snapshot.project || !validProject(snapshot.project)) {
      throw new Error('服务器没有可恢复的画布记录');
    }
    this.pendingProject = null;
    this.remoteReady = true;
    this.durableDirty = false;
    this.saveLocal(snapshot.project);
    this.rememberSync(snapshot.project, snapshot);
    this.setStatus('synced');
    return snapshot.project;
  }

  private scheduleRemoteSave() {
    if (this.status === 'conflict') return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.setStatus('syncing');
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      // Background autosave reports its state through getSyncStatus(). Avoid
      // an unhandled rejection while keeping explicit flush() calls observable.
      void this.flush().catch(() => undefined);
    }, REMOTE_SAVE_DELAY_MS);
  }

  private async writeRemote(project: StudioProject): Promise<void> {
    this.setStatus('syncing');
    const response = await browserApiFetch('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: this.revision, project }),
    });
    const snapshot = await response.json() as ProjectSnapshot & { error?: string };
    if (response.status === 409) {
      this.revision = Number(snapshot.revision || this.revision);
      if (snapshot.project && projectsHaveSameDurableContent(project, snapshot.project)) {
        if (hasNewerDurablePendingProject(this.pendingProject, project)) {
          this.rememberSync(snapshot.project, snapshot);
          this.durableDirty = true;
          this.setStatus('syncing');
          return;
        }
        this.pendingProject = null;
        this.durableDirty = false;
        this.saveLocal(snapshot.project);
        this.rememberSync(snapshot.project, snapshot);
        this.setStatus('synced');
        return;
      }
      this.setStatus('conflict');
      return;
    }
    if (!response.ok) throw new Error(snapshot.error || `画布记录保存失败 (${response.status})`);
    this.rememberSync(project, snapshot);
    this.durableDirty = Boolean(this.pendingProject);
    this.setStatus('synced');
  }

  async flush() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.inFlight) await this.inFlight;
    const project = this.pendingProject;
    if (!project || !this.remoteReady || this.status === 'conflict') return;
    this.pendingProject = null;
    this.inFlight = this.writeRemote(project)
      .catch((error) => {
        // A later edit already contains this snapshot. Otherwise restore the
        // failed project so a retry cannot lose the node that the user just
        // created or edited.
        if (!this.pendingProject) this.pendingProject = project;
        this.durableDirty = true;
        if (this.status !== 'conflict') this.setStatus('offline');
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
    if (this.pendingProject) await this.flush();
  }
}

export const projectRepository = new HybridProjectRepository();
