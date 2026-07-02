import type { NodeKind, NodeOutput, StudioNodeData } from '../types';

export interface GenerationAdapter {
  run(input: StudioNodeData, onProgress: (progress: number) => void): Promise<NodeOutput>;
}

const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function mockImageUrl(prompt: string, index: number) {
  const palette = [
    ['#101522', '#4f7bff', '#70e1c8', '#f3bf6a'],
    ['#11101a', '#8173ff', '#d1c5ff', '#70e1c8'],
    ['#0c1518', '#70e1c8', '#4f7bff', '#f3bf6a'],
  ][index % 3];
  const title = escapeXml((prompt.trim() || 'CanvasPro mock result').slice(0, 46));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${palette[0]}"/>
          <stop offset="1" stop-color="#06070a"/>
        </linearGradient>
        <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${palette[1]}"/>
          <stop offset="1" stop-color="${palette[2]}"/>
        </linearGradient>
      </defs>
      <rect width="640" height="420" fill="url(#bg)"/>
      <rect x="48" y="48" width="544" height="324" rx="28" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)"/>
      <circle cx="180" cy="158" r="72" fill="url(#a)" opacity="0.94"/>
      <rect x="282" y="112" width="216" height="34" rx="17" fill="${palette[3]}" opacity="0.92"/>
      <rect x="282" y="168" width="156" height="22" rx="11" fill="rgba(255,255,255,0.64)"/>
      <path d="M82 332 C178 236 251 346 338 258 C430 164 498 297 578 218" fill="none" stroke="${palette[2]}" stroke-width="8" stroke-linecap="round" opacity="0.76"/>
      <text x="64" y="386" fill="#f6f7fb" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">${title}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function outputForKind(kind: NodeKind, prompt: string): NodeOutput {
  if (kind === 'text') {
    return {
      text: `模拟文本结果：已根据「${prompt || '默认创意提示'}」生成一段可继续编辑的内容。`,
    };
  }
  if (kind === 'image') {
    return {
      imageUrl: mockImageUrl(prompt, 1),
      text: '模拟图片已生成，可作为下游节点引用。',
    };
  }
  if (kind === 'video') {
    return {
      videoUrl: mockImageUrl(prompt, 2),
      text: '模拟视频任务完成：5s / 720p / 9:16。',
    };
  }
  return {
    assetName: prompt || 'local-reference.asset',
    text: '素材已进入画布，可连接到生成节点。',
  };
}

export const mockGenerationAdapter: GenerationAdapter = {
  async run(input, onProgress) {
    for (const progress of [12, 28, 43, 61, 78, 92]) {
      await pause(180);
      onProgress(progress);
    }
    await pause(220);
    onProgress(100);
    return outputForKind(input.kind, input.prompt);
  },
};
