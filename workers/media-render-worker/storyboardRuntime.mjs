const shotFields = ['shotSize', 'visualDescription', 'cameraMovement', 'imagePrompt', 'videoPrompt'];

function unwrapJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

export function normalizeStoryboardDocument(value, expectedCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('分镜响应必须是 JSON 对象。');
  }
  const count = Number(expectedCount);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('镜头数量必须是 1–20 的整数。');
  }
  if (!Array.isArray(value.shots)) throw new Error('分镜响应缺少 shots 数组。');
  if (value.shots.length !== count) {
    throw new Error(`模型返回了 ${value.shots.length} 个镜头，需要严格返回 ${count} 个。`);
  }
  const shots = value.shots.map((rawShot, index) => {
    if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
      throw new Error(`第 ${index + 1} 个镜头不是对象。`);
    }
    const shotNumber = Number(rawShot.shotNumber);
    if (shotNumber !== index + 1) throw new Error(`镜头编号必须从 1 开始连续排列，第 ${index + 1} 项编号错误。`);
    const shot = { shotNumber };
    for (const field of shotFields) {
      const content = typeof rawShot[field] === 'string' ? rawShot[field].trim() : '';
      if (!content) throw new Error(`镜头 ${shotNumber} 缺少 ${field}。`);
      shot[field] = content;
    }
    return shot;
  });
  return { version: 1, shotCount: count, shots };
}

export function parseStoryboardResponse(raw, expectedCount) {
  let value;
  try {
    value = JSON.parse(unwrapJson(raw));
  } catch (error) {
    throw new Error(`分镜响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeStoryboardDocument(value, expectedCount);
}

export function storyboardToMarkdown(document) {
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return [
    '# 分镜脚本',
    '',
    '| 镜号 | 景别 | 画面 | 运镜 | 图像提示词 | 视频提示词 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...document.shots.map((shot) =>
      `| ${String(shot.shotNumber).padStart(2, '0')} | ${escape(shot.shotSize)} | ${escape(shot.visualDescription)} | ${escape(shot.cameraMovement)} | ${escape(shot.imagePrompt)} | ${escape(shot.videoPrompt)} |`,
    ),
  ].join('\n');
}

export function buildStoryboardSystemPrompt(expectedCount, supplemental = '') {
  return [
    '你是专业影视分镜师。只输出一个合法 JSON 对象，不要 Markdown、解释或代码块。',
    `必须严格生成 ${expectedCount} 个镜头，镜头编号从 1 连续到 ${expectedCount}。`,
    'JSON 结构必须是：{"version":1,"shotCount":数量,"shots":[{"shotNumber":1,"shotSize":"景别","visualDescription":"可拍摄的画面描述","cameraMovement":"运镜","imagePrompt":"完整图像生成提示词","videoPrompt":"完整视频生成提示词"}]}。',
    '每个字符串字段都必须非空。图像提示词与视频提示词都必须生成，且保持人物、场景、时间和视觉风格连续。',
    supplemental ? `额外要求：${supplemental}` : '',
  ].filter(Boolean).join('\n');
}

export function buildStoryboardUserPrompt(payload) {
  const prompt = String(payload?.prompt || '').trim();
  const references = Array.isArray(payload?.references) ? payload.references : [];
  const textReferences = references.filter((reference) => reference?.outputType === 'text');
  for (const reference of textReferences) {
    if (!String(reference.content || '').trim()) {
      throw new Error(`引用的文本节点“${reference.title || reference.nodeId || '未命名'}”尚未生成正文。`);
    }
  }
  const referenceText = textReferences.map((reference, index) => [
    `【文本引用 ${index + 1}：${reference.title || reference.nodeId || '未命名'}】`,
    String(reference.content).trim(),
  ].join('\n')).join('\n\n');
  return [prompt || '请根据引用正文生成分镜脚本。', referenceText].filter(Boolean).join('\n\n');
}

export function buildStoryboardRepairPrompt(raw, expectedCount, reason) {
  return [
    `上一份结果不合格：${reason}`,
    `请修复为严格包含 ${expectedCount} 个镜头的 JSON 对象，只返回 JSON。`,
    '不要删减原剧情信息，所有字段必须非空，shotNumber 必须从 1 连续编号。',
    '待修复内容：',
    String(raw || ''),
  ].join('\n\n');
}
