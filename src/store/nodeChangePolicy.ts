import type { EdgeChange, NodeChange } from '@xyflow/react';
import type { StudioEdge, StudioNode } from '../types';

/**
 * React Flow selection is transient UI state. Persisting `select` changes makes
 * every click or lasso selection compete for the shared project revision.
 */
export function persistentNodeChanges(changes: NodeChange<StudioNode>[]) {
  return changes.filter((change) => change.type !== 'select');
}

export function persistentEdgeChanges(changes: EdgeChange<StudioEdge>[]) {
  return changes.filter((change) => change.type !== 'select');
}
