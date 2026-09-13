import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canvasShortcutBlocked, saveCanvasFeedback } from '../src/services/canvasInteractionPolicy.ts';

test('canvas shortcuts never act through an editor, open dialog, selected text or IME', () => {
  assert.equal(canvasShortcutBlocked({}), false);
  for (const flag of ['defaultPrevented', 'composing', 'interactiveTarget', 'overlayOpen', 'textSelected']) {
    assert.equal(canvasShortcutBlocked({ [flag]: true }), true, flag);
  }
});

test('React Flow cannot bypass the guarded canvas deletion handler with its document-level Backspace listener', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const flow = app.match(/<ReactFlow\b[\s\S]*?selectionMode=/)?.[0] || '';
  assert.match(flow, /deleteKeyCode=\{null\}/);
  assert.match(app, /canvasShortcutBlocked\(/);
});

test('manual save reports success only after the server is synchronized', async () => {
  let finished = false;
  const feedback = await saveCanvasFeedback(async () => { finished = true; }, () => finished ? 'synced' : 'syncing');
  assert.equal(feedback.tone, 'success');
  for (const status of ['conflict', 'offline', 'local', 'syncing'] as const) {
    assert.notEqual((await saveCanvasFeedback(async () => {}, () => status)).tone, 'success', status);
  }
});

test('save failures are handled without a false success or exposing raw server errors', async () => {
  const result = await saveCanvasFeedback(async () => { throw new Error('sensitive diagnostic'); }, () => 'offline');
  assert.equal(result.tone, 'error');
  assert.doesNotMatch(result.message, /sensitive/);
});
