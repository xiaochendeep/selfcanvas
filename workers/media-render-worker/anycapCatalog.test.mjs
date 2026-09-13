import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anyCapDescriptor, anyCapModel, validateAnyCapReferences } from './anycapCatalog.mjs';
import { runAnyCapAudio, runAnyCapImage, runAnyCapVideo } from './providerRuntime.mjs';

test('verified catalog preserves mode-specific H3 and Seedance 2.5 constraints', () => {
  const seedance = anyCapDescriptor('seedance-2.5');
  assert.deepEqual(seedance.durations, Array.from({ length: 26 }, (_, index) => index + 5));
  assert.equal(seedance.referencesByMode['image-to-video'].video, 3);
  assert.throws(() => validateAnyCapReferences('seedance-2.5', 'first-last-frame-to-video', { image: 1 }), /2–2/);
  assert.doesNotThrow(() => validateAnyCapReferences('seedance-2.5', 'first-last-frame-to-video', { image: 2 }));
  const h3 = anyCapDescriptor('minimax-h3');
  assert.deepEqual(h3.resolutions, ['2k']);
  assert.equal(h3.modeOptions['text-to-video'].supportsGenerateAudio, false);
  assert.equal(h3.modeOptions['text-to-video'].supportsAdaptive, false);
  assert.equal(h3.modeOptions['multi-modal-reference'].supportsAdaptive, true);
  assert.equal(h3.modeOptions['image-to-video'].supportsGenerateAudio, true);
  assert.equal(anyCapModel('suno-v5-5').id, 'suno-v5.5');
});

test('workers emit native, schema-safe CLI requests without paid generation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-anycap-catalog-'));
  const bin = path.join(directory, 'fake-anycap');
  const log = path.join(directory, 'args.json');
  await fs.writeFile(bin, '#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);fs.writeFileSync(process.env.TEST_ANYCAP_ARGS,JSON.stringify(args));const output=args[args.indexOf("-o")+1];fs.writeFileSync(output,"test media");console.log(JSON.stringify({local_path:output}));\n', { mode: 0o700 });
  const previous = Object.fromEntries(['ANYCAP_BIN', 'SELF_CANVAS_STORAGE_ROOT', 'TEST_ANYCAP_ARGS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ANYCAP_BIN: bin, SELF_CANVAS_STORAGE_ROOT: directory, TEST_ANYCAP_ARGS: log });
  const job = { id: 'catalog-test', updateProgress: async () => {} };
  const readArgs = async () => JSON.parse(await fs.readFile(log, 'utf8'));
  const params = (args) => Object.fromEntries(args.flatMap((value, index) => value === '--param' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  try {
    await runAnyCapAudio(job, { prompt: '雨声', options: { model: 'doubao-seed-audio-1-0', speechRate: 18, sampleRate: 48000, format: 'wav', enableSubtitle: true } });
    let args = await readArgs();
    assert.deepEqual(args.slice(0, 2), ['audio', 'generate']);
    assert.equal(params(args).speech_rate, '18');
    assert.equal(params(args).enable_subtitle, 'true');
    assert.match(args[args.indexOf('-o') + 1], /\.wav$/);

    await runAnyCapAudio(job, { prompt: '电影配乐', options: { model: 'suno-v5-5', duration: 30, style: 'cinematic', makeInstrumental: true, speechRate: 99 } });
    args = await readArgs();
    assert.deepEqual(args.slice(0, 2), ['music', 'generate']);
    assert.equal(args[args.indexOf('--model') + 1], 'suno-v5.5');
    assert.equal(params(args).duration, '30000');
    assert.equal(params(args).tags, 'cinematic');
    assert.equal(params(args).make_instrumental, 'true');
    assert.equal(params(args).speech_rate, undefined);
    assert.equal(params(args).style, undefined);

    await runAnyCapVideo(job, { prompt: '雨夜街道', options: { model: 'minimax-h3', mode: 'text-to-video', duration: 15, resolution: '720p', aspectRatio: 'adaptive', generateAudio: true } });
    args = await readArgs();
    assert.equal(params(args).resolution, '2k');
    assert.equal(params(args).duration, '15');
    assert.notEqual(params(args).aspect_ratio, 'adaptive');
    assert.equal(params(args).generate_audio, undefined);
    assert.equal(params(args).format, undefined);

    await runAnyCapVideo(job, { prompt: '慢镜头', options: { model: 'seedance-2.5', mode: 'multi-modal-reference', duration: 30, generateAudio: false } });
    args = await readArgs();
    assert.equal(params(args).duration, '30');
    assert.equal(params(args).generate_audio, 'false');
    assert.equal(params(args).format, undefined);

    const first = path.join(directory, 'first.png');
    const last = path.join(directory, 'last.png');
    await fs.writeFile(first, 'first');
    await fs.writeFile(last, 'last');
    await runAnyCapVideo(job, { prompt: '转场', options: { model: 'seedance-2.5', mode: 'first-last-frame-to-video', duration: 12 }, references: [{ outputType: 'image', path: first }, { outputType: 'image', path: last }] });
    args = await readArgs();
    assert.equal(params(args).first_frame, first);
    assert.equal(params(args).last_frame, last);
    assert.equal(params(args).images, undefined);

    await runAnyCapImage(job, { prompt: '参考图', options: { model: 'gpt-image-2', resolutionTier: '4K', outputFormat: 'webp', aspectRatio: '16:9' } });
    args = await readArgs();
    assert.equal(params(args).resolution, '4k');
    assert.equal(params(args).format, 'webp');
    assert.match(args[args.indexOf('-o') + 1], /\.webp$/);
    await assert.rejects(() => runAnyCapImage(job, { prompt: '纯文本模式', options: { model: 'gpt-image-2', mode: 'text-to-image' }, references: [{ outputType: 'image', path: first }] }), /0–0/);
    await assert.rejects(() => runAnyCapAudio(job, { prompt: '不允许的视频参考', options: { model: 'suno-v5.5' }, references: [{ outputType: 'video', path: first }] }), /0–0/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
