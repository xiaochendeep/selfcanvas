import type { CreativeRunResult } from './creativeStudioClient';
import type { NodeKind, StudioCanvas, StudioEdge, StudioNode } from '../types';

export interface CreativeImportResult { nodeIds: string[]; imageNodeIds: string[] }
type NodeFactory = (kind: NodeKind, index: number, position: { x: number; y: number }) => StudioNode;

export function creativeDraftMarkdown(result: CreativeRunResult): string {
  const draft = result.draft;
  const footer = '\n\n---\n候选草稿 · 请审阅后使用\n创作规则：Serge Shima / smixs/visual-skills，CC BY 4.0；SelfCanvas 适配。';
  if (draft.kind === 'script') {
    return `# ${draft.title}\n\n${draft.logline}\n\n${draft.script}${footer}`;
  }
  if (draft.kind === 'video-analysis') {
    return [
      `# ${draft.title}`, draft.summary, `## 开头钩子\n${draft.openingHook}`,
      ...draft.segments.map((segment) => `## ${segment.startSeconds}–${segment.endSeconds} 秒\n观察：${segment.observation}\n\n吸引力推断：${segment.appeal}\n\n手法：${segment.technique}\n\n证据信心：${segment.confidence}`),
      `## 改编思路\n${draft.adaptationIdeas.join('\n\n')}`,
      `## 限制\n${draft.limitations.join('\n\n')}\n\n未提供平台表现数据时，不代表已验证的爆款效果。`, footer,
    ].join('\n\n');
  }
  return [
    `# ${draft.title}`, '图片分镜提示词 · 图片尚未生成',
    ...draft.shots.map((shot) => `## 镜头 ${shot.shotNumber} · ${shot.durationSeconds} 秒\n${shot.visualDescription}\n\n功能：${shot.function}\n构图：${shot.composition}\n运镜：${shot.cameraMovement}（${shot.movementReason}）\n灯光：${shot.lighting}\n声音：${shot.sound}\n连续性：${shot.continuity}\n结束状态：${shot.finalFrame}\n\n### 图片提示词\n${shot.imagePrompt}\n\n### 视频提示词\n${shot.videoPrompt}`),
    `## 审阅提醒\n${draft.reviewNotes.join('\n\n')}`, footer,
  ].join('\n\n');
}

/** Build append-only nodes. Generated model text never becomes executable canvas operations. */
export function buildCreativeCanvasImport(result: CreativeRunResult, canvas: StudioCanvas, factory: NodeFactory) {
  if (result.canvasId !== canvas.id) throw new Error('创作草稿与目标画布不匹配');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result.runId)) throw new Error('创作任务 ID 无效');
  if (result.kind !== result.draft.kind || result.draft.version !== 1) throw new Error('创作草稿版本或类型无效');
  if (!result.draft.title?.trim()) throw new Error('草稿标题不能为空');
  const documentId = `creative_${result.runId}_document`;
  const known = canvas.nodes.find((node) => node.id === documentId);
  if (known) {
    const nodeIds = canvas.nodes.filter((node) => (node.data.creativeWorkflow as { runId?: string } | undefined)?.runId === result.runId).map((node) => node.id);
    if (!nodeIds.includes(documentId)) throw new Error('节点 ID 冲突，未覆盖已有内容');
    return { nodes: [] as StudioNode[], edges: [] as StudioEdge[], nodeIds, imageNodeIds: nodeIds.filter((nodeId) => canvas.nodes.find((node) => node.id === nodeId)?.data.kind === 'image') };
  }
  const draft = result.draft;
  if (draft.kind === 'script' && !draft.script?.trim()) throw new Error('剧本正文不能为空');
  if (draft.kind === 'storyboard' && (draft.shots.length < 1 || draft.shots.length > 20 || draft.shotCount !== draft.shots.length)) throw new Error('分镜数量无效');
  if (draft.kind === 'storyboard' && draft.shots.some((shot, index) => shot.shotNumber !== index + 1 || !shot.imagePrompt.trim() || !shot.videoPrompt.trim())) throw new Error('镜号或提示词不完整');
  if (draft.kind === 'video-analysis' && (!result.sourceNodeId || !canvas.nodes.some((node) => node.id === result.sourceNodeId))) throw new Error('原视频节点不存在，未导入分析');

  const x = canvas.nodes.length ? Math.max(...canvas.nodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? 320))) + 120 : 120;
  const y = canvas.nodes.length ? Math.min(...canvas.nodes.map((node) => node.position.y)) : 120;
  const document = factory(draft.kind === 'storyboard' ? 'storyboard' : 'text', canvas.nodes.length, { x, y });
  const provenance = { runId: result.runId, sourceRevision: result.sourceRevision, skillSources: result.skillSources, reviewState: 'candidate', kind: result.kind };
  document.id = documentId;
  document.data = {
    ...document.data, title: draft.title.slice(0, 200), prompt: creativeDraftMarkdown(result),
    provider: 'Creative Gateway', model: result.model, status: 'success', progress: 100,
    // Existing text generation remains separate; the draft itself was generated through the skill API.
    providerOptions: undefined,
    outputs: { text: creativeDraftMarkdown(result), ...(draft.kind === 'storyboard' ? { storyboard: { version: 1 as const, shotCount: draft.shotCount, shots: draft.shots } } : {}) },
    creativeWorkflow: provenance,
  };
  const nodes = [document];
  const edges: StudioEdge[] = [];
  if (result.sourceNodeId && canvas.nodes.some((node) => node.id === result.sourceNodeId)) {
    edges.push({ id: `${documentId}_source`, source: result.sourceNodeId, target: documentId });
  }
  if (draft.kind === 'storyboard') {
    draft.shots.forEach((shot, index) => {
      const imageNode = factory('image', canvas.nodes.length + nodes.length, { x: x + 900 + (index % 3) * 380, y: y + Math.floor(index / 3) * 340 });
      imageNode.id = `creative_${result.runId}_image_${shot.shotNumber}`;
      if (canvas.nodes.some((node) => node.id === imageNode.id)) throw new Error('节点 ID 冲突，未覆盖已有内容');
      const model = result.imageModel || 'nano-banana-2';
      imageNode.data = {
        ...imageNode.data, title: `镜头 ${String(shot.shotNumber).padStart(2, '0')} · 图片`,
        prompt: shot.imagePrompt, model, provider: 'AnyCap', status: 'idle', progress: 0, outputs: {}, references: [],
        providerOptions: { providerTool: 'anycap', model, mode: 'text-to-image', aspectRatio: result.aspectRatio || '16:9', resolutionTier: '1K', outputFormat: 'png', count: 1 },
        creativeWorkflow: { ...provenance, shotNumber: shot.shotNumber, videoPrompt: shot.videoPrompt, videoModel: result.videoModel, durationSeconds: shot.durationSeconds },
      };
      nodes.push(imageNode);
      edges.push({ id: `${imageNode.id}_source`, source: documentId, target: imageNode.id });
    });
  }
  return { nodes, edges, nodeIds: nodes.map((node) => node.id), imageNodeIds: nodes.filter((node) => node.data.kind === 'image').map((node) => node.id) };
}
