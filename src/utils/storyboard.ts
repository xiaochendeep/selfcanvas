import type { StoryboardDocument, StoryboardShot } from '../types';

export function storyboardShotToText(shot: StoryboardShot) {
  return [
    `镜头 ${String(shot.shotNumber).padStart(2, '0')}`,
    `景别：${shot.shotSize}`,
    `画面：${shot.visualDescription}`,
    `运镜：${shot.cameraMovement}`,
    `图像提示词：${shot.imagePrompt}`,
    `视频提示词：${shot.videoPrompt}`,
  ].join('\n');
}

export function storyboardToMarkdown(document: StoryboardDocument) {
  const rows = document.shots.map((shot) =>
    `| ${String(shot.shotNumber).padStart(2, '0')} | ${escapeCell(shot.shotSize)} | ${escapeCell(shot.visualDescription)} | ${escapeCell(shot.cameraMovement)} | ${escapeCell(shot.imagePrompt)} | ${escapeCell(shot.videoPrompt)} |`,
  );
  return [
    '# 分镜脚本',
    '',
    '| 镜号 | 景别 | 画面 | 运镜 | 图像提示词 | 视频提示词 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function isStoryboardDocument(value: unknown): value is StoryboardDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<StoryboardDocument>;
  if (document.version !== 1 || !Number.isInteger(document.shotCount) || !Array.isArray(document.shots)) return false;
  if (document.shots.length !== document.shotCount) return false;
  return document.shots.every((shot, index) => isStoryboardShot(shot, index + 1));
}

function isStoryboardShot(value: unknown, expectedNumber: number): value is StoryboardShot {
  if (!value || typeof value !== 'object') return false;
  const shot = value as Partial<StoryboardShot>;
  return shot.shotNumber === expectedNumber && [
    shot.shotSize,
    shot.visualDescription,
    shot.cameraMovement,
    shot.imagePrompt,
    shot.videoPrompt,
  ].every((field) => typeof field === 'string' && field.trim().length > 0);
}

function escapeCell(value: string) {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
