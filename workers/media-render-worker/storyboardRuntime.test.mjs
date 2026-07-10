import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoryboardUserPrompt,
  parseStoryboardResponse,
  storyboardToMarkdown,
} from './storyboardRuntime.mjs';
import { runStructuredStoryboard } from './providerRuntime.mjs';

function document(count = 2) {
  return {
    version: 1,
    shotCount: count,
    shots: Array.from({ length: count }, (_, index) => ({
      shotNumber: index + 1,
      shotSize: '中景',
      visualDescription: `画面 ${index + 1}`,
      cameraMovement: '缓慢推进',
      imagePrompt: `图像提示 ${index + 1}`,
      videoPrompt: `视频提示 ${index + 1}`,
    })),
  };
}

test('parses pure and fenced JSON', () => {
  const raw = JSON.stringify(document());
  assert.equal(parseStoryboardResponse(raw, 2).shots.length, 2);
  assert.equal(parseStoryboardResponse('```json\n' + raw + '\n```', 2).shotCount, 2);
});

test('rejects missing fields, wrong count and non-sequential numbers', () => {
  const missing = document();
  delete missing.shots[0].imagePrompt;
  assert.throws(() => parseStoryboardResponse(JSON.stringify(missing), 2), /imagePrompt/);
  assert.throws(() => parseStoryboardResponse(JSON.stringify(document()), 1), /严格返回 1/);
  const unordered = document();
  unordered.shots[1].shotNumber = 3;
  assert.throws(() => parseStoryboardResponse(JSON.stringify(unordered), 2), /连续排列/);
});

test('markdown and user prompt preserve structured content', () => {
  assert.match(storyboardToMarkdown(document()), /图像提示词/);
  const prompt = buildStoryboardUserPrompt({
    prompt: '拆成两镜',
    references: [{ title: '生成文本', outputType: 'text', content: '这里是真实正文' }],
  });
  assert.match(prompt, /这里是真实正文/);
  assert.throws(
    () => buildStoryboardUserPrompt({ references: [{ title: '空节点', outputType: 'text' }] }),
    /尚未生成正文/,
  );
});

test('structured runner repairs one invalid response and then succeeds', async () => {
  const replies = ['不是 JSON', JSON.stringify(document())];
  const fetcher = async () => ({ choices: [{ message: { content: replies.shift() } }] });
  const result = await runStructuredStoryboard(
    { updateProgress: async () => undefined },
    { prompt: '拆成两镜', model: 'test', options: { model: 'test', shotCount: 2 } },
    fetcher,
    'Test Provider',
  );
  assert.equal(result.storyboard.shotCount, 2);
  assert.equal(replies.length, 0);
});

test('structured runner fails after one repair attempt', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { choices: [{ message: { content: '仍然不是 JSON' } }] };
  };
  await assert.rejects(
    runStructuredStoryboard(
      { updateProgress: async () => undefined },
      { prompt: '拆成两镜', model: 'test', options: { model: 'test', shotCount: 2 } },
      fetcher,
      'Test Provider',
    ),
    /自动修复失败/,
  );
  assert.equal(calls, 2);
});
