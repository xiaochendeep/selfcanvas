import type { StudioNode, StudioProject } from '../types';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function durableNode(node: StudioNode) {
  const {
    selected: _selected,
    dragging: _dragging,
    measured: _measured,
    ...durable
  } = node;
  return durable;
}

function durableProject(project: StudioProject) {
  const { updatedAt: _projectUpdatedAt, ...durable } = project;
  return {
    ...durable,
    canvases: project.canvases.map((canvas) => {
      const { updatedAt: _canvasUpdatedAt, ...durableCanvas } = canvas;
      return {
        ...durableCanvas,
        nodes: canvas.nodes.map(durableNode),
        edges: canvas.edges.map(({ selected: _selected, ...edge }) => edge),
      };
    }),
  };
}

/**
 * Selection/measurement state and timestamps do not represent user content.
 * This lets old selection-only saves reconcile safely without hiding real
 * concurrent edits to positions, prompts, references, outputs, or settings.
 */
export function projectsHaveSameDurableContent(left: StudioProject, right: StudioProject) {
  return JSON.stringify(stableValue(durableProject(left))) === JSON.stringify(stableValue(durableProject(right)));
}

export function hasNewerDurablePendingProject(pending: StudioProject | null, sent: StudioProject) {
  return Boolean(pending && !projectsHaveSameDurableContent(pending, sent));
}
