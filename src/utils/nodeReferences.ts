import type { CanvasGroup, GeneratedFile, NodeReference, StudioNode } from '../types';

export function outputTypeFromNode(node: StudioNode): NodeReference['outputType'] {
  if (node.data.outputs?.videoUrl) return 'video';
  if (node.data.outputs?.audioUrl) return 'audio';
  if (node.data.outputs?.imageUrl) return 'image';
  if (node.data.outputs?.text) return 'text';
  if (node.data.kind === 'video') return 'video';
  if (node.data.kind === 'audio') return 'audio';
  if (node.data.kind === 'image' || node.data.kind === 'asset' || node.data.kind === 'upload') return 'image';
  if (node.data.kind === 'text' || node.data.kind === 'storyboard') return 'text';
  return 'other';
}

export function urlFromNode(node: StudioNode) {
  return node.data.outputs?.imageUrl || node.data.outputs?.videoUrl || node.data.outputs?.audioUrl || node.data.outputs?.fileUrl || '';
}

export function nodeToReference(node: StudioNode): NodeReference {
  const outputType = outputTypeFromNode(node);
  const url = urlFromNode(node);
  return {
    nodeId: node.id,
    title: node.data.title || node.data.outputs?.assetName || node.data.prompt || node.id,
    kind: node.data.kind,
    outputType,
    source: 'canvas',
    url,
    path: node.data.importedMedia?.path,
    thumbnailUrl: outputType === 'image' || outputType === 'video' ? url : undefined,
    content: outputType === 'text' ? node.data.outputs?.text?.trim() || undefined : undefined,
  };
}

export function nodeToGroupReference(node: StudioNode, group: CanvasGroup): NodeReference {
  return {
    ...nodeToReference(node),
    source: 'group',
    groupId: group.id,
    title: node.data.title || node.data.outputs?.assetName || node.data.prompt || node.id,
  };
}

export function fileToReference(file: GeneratedFile): NodeReference {
  return {
    nodeId: `file:${file.id}`,
    title: file.title,
    kind: file.type,
    outputType: file.type,
    source: 'output',
    url: file.url,
    path: file.path,
    thumbnailUrl: file.type === 'image' || file.type === 'video' ? file.url : undefined,
  };
}

export function mergeReferences(existing: NodeReference[] = [], additions: NodeReference[]) {
  const seen = new Set(existing.map(referenceKey));
  const next = [...existing];
  for (const reference of additions) {
    const key = referenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(reference);
  }
  return next;
}

export function referenceKey(reference: NodeReference) {
  return `${reference.source}:${reference.groupId ?? 'solo'}:${reference.nodeId}`;
}

export function appendReferenceMentions(prompt: string, references: NodeReference[]) {
  const additions = references
    .map((reference) => `@${reference.title}`)
    .filter((mention) => !prompt.includes(mention));
  if (!additions.length) return prompt;
  return `${prompt}${prompt.trim() ? ' ' : ''}${additions.join(' ')}`;
}
