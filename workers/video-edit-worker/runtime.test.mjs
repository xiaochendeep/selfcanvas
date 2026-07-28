import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { redactVideoEditError } from './queueContract.mjs';
import {
  buildTransitionFilter,
  createSequentialPlan,
  normalizeEditPlan,
  probeVideo,
  renderEditPlan,
  resolveVideoSources,
  runProcess,
  runVideoEditJob,
  VideoEditAbortError,
} from './runtime.mjs';

const probeFixtures = [
  { path: '/tmp/a.mp4', duration: 5, width: 1920, height: 1080, fps: 29.97, hasAudio: true, size: 100 },
  { path: '/tmp/b.mp4', duration: 8, width: 720, height: 1280, fps: 25, hasAudio: false, size: 100 },
];

test('external job errors redact local paths and provider URLs', () => {
  const redacted = redactVideoEditError(
    'ffprobe /tmp/private/bad.mp4 failed; C:\\Users\\secret\\clip.mp4; https://provider.example/v1/task/abc',
  );
  assert.doesNotMatch(redacted, /\/tmp|C:\\Users|provider\.example/);
  assert.match(redacted, /\[local-path\]/);
  assert.match(redacted, /\[remote-service\]/);
});

test('normalizeEditPlan clamps trims and crossfade to safe source bounds', () => {
  const plan = normalizeEditPlan({
    clips: [
      { sourceIndex: 1, in: -3, out: 99, transition: { type: 'crossfade', duration: 4 } },
      { sourceIndex: 0, in: 1, out: 2, transition: 'crossfade' },
    ],
    audio: { policy: 'keep' },
    output: { fps: 120 },
  }, probeFixtures, { audioPolicy: 'normalize', resolution: '720p', aspectRatio: '9:16' });

  assert.deepEqual(plan.clips[0], {
    sourceIndex: 1,
    in: 0,
    out: 8,
    duration: 8,
    transition: { type: 'crossfade', duration: 0.5 },
  });
  assert.deepEqual(plan.clips[1].transition, { type: 'cut', duration: 0 });
  assert.deepEqual(plan.audio, { policy: 'normalize' });
  assert.equal(plan.output.width, 720);
  assert.equal(plan.output.height, 1280);
  assert.equal(plan.output.fps, 60);
  assert.equal(plan.output.videoCodec, 'h264');
  assert.equal(plan.output.audioCodec, 'aac');
});

test('normalizeEditPlan rejects invalid source indexes and tiny clips', () => {
  assert.throws(
    () => normalizeEditPlan({ clips: [{ sourceIndex: 2 }] }, probeFixtures),
    /sourceIndex/,
  );
  assert.throws(
    () => normalizeEditPlan({ clips: [{ sourceIndex: 0, in: 1, out: 1.05 }] }, probeFixtures),
    /0.1/,
  );
});

test('normalization caps 8K output and rejects hostile aspect ratios', () => {
  const source = [{ ...probeFixtures[0], width: 7680, height: 4320 }];
  const capped = normalizeEditPlan({ clips: [{ sourceIndex: 0 }] }, source);
  assert.equal(capped.output.width, 3840);
  assert.equal(capped.output.height, 2160);
  assert.throws(
    () => normalizeEditPlan(
      { clips: [{ sourceIndex: 0 }] },
      source,
      { resolution: '4k', aspectRatio: '1000000:1' },
    ),
    /比例超出安全范围/,
  );
});

test('source resolution rejects a symlink escaping allowed media roots', { skip: process.platform === 'win32' }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-source-root-test-'));
  const allowed = path.join(tempDir, 'allowed');
  const outside = path.join(tempDir, 'outside.mp4');
  const previousOutput = process.env.OUTPUT_DIR;
  const previousAllowed = process.env.VIDEO_EDIT_ALLOWED_ROOTS;
  await fs.mkdir(allowed);
  await fs.writeFile(outside, 'not a video');
  await fs.symlink(outside, path.join(allowed, 'escaped.mp4'));
  process.env.OUTPUT_DIR = allowed;
  delete process.env.VIDEO_EDIT_ALLOWED_ROOTS;
  try {
    await assert.rejects(
      resolveVideoSources({ references: [{ outputType: 'video', path: path.join(allowed, 'escaped.mp4') }] }),
      /不在允许的媒体目录/,
    );
  } finally {
    if (previousOutput === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = previousOutput;
    if (previousAllowed === undefined) delete process.env.VIDEO_EDIT_ALLOWED_ROOTS;
    else process.env.VIDEO_EDIT_ALLOWED_ROOTS = previousAllowed;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('sequential fallback preserves source ordering and full durations', () => {
  const plan = createSequentialPlan(probeFixtures, {
    audioPolicy: 'mute',
    transition: 'crossfade',
    transitionDuration: 0.25,
  });
  assert.deepEqual(plan.clips.map(({ sourceIndex, in: start, out }) => [sourceIndex, start, out]), [
    [0, 0, 5],
    [1, 0, 8],
  ]);
  assert.equal(plan.audio.policy, 'mute');
  assert.deepEqual(plan.clips[0].transition, { type: 'crossfade', duration: 0.25 });
});

test('transition graph combines hard cuts and crossfades deterministically', () => {
  const plan = normalizeEditPlan({
    clips: [
      { sourceIndex: 0, in: 0, out: 2, transition: 'cut' },
      { sourceIndex: 1, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.25 } },
      { sourceIndex: 0, in: 2, out: 4, transition: 'cut' },
    ],
  }, probeFixtures);
  const built = buildTransitionFilter(plan);
  assert.match(built.graph, /concat=n=2:v=1:a=0/);
  assert.match(built.graph, /xfade=transition=fade:duration=0.25:offset=3.750/);
  assert.match(built.graph, /acrossfade=d=0.25/);
  assert.equal(built.duration, 5.75);
});

test('runProcess aborts a running child process', async () => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new VideoEditAbortError('cancel-test')), 30);
  await assert.rejects(pending, (error) => error?.name === 'AbortError' && error.message === 'cancel-test');
});

function hasFfmpeg() {
  try {
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('ffmpeg integration trims, normalizes silent audio, and concatenates to H264/AAC MP4', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-video-test-'));
  const previousPreset = process.env.VIDEO_EDIT_X264_PRESET;
  process.env.VIDEO_EDIT_X264_PRESET = 'ultrafast';
  try {
    const inputs = [path.join(tempDir, 'one.mp4'), path.join(tempDir, 'two.mp4')];
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=0.8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputs[0],
    ]);
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=0.8',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', inputs[1],
    ]);
    const probes = await Promise.all(inputs.map((filePath) => probeVideo(filePath)));
    const plan = normalizeEditPlan({
      clips: [
        { sourceIndex: 0, in: 0.1, out: 0.7, transition: 'cut' },
        { sourceIndex: 1, in: 0.1, out: 0.7, transition: 'cut' },
      ],
      audio: { policy: 'normalize' },
    }, probes, { resolution: '720p', aspectRatio: '16:9', fps: 24 });
    const progress = [];
    const output = await renderEditPlan(
      { updateProgress: async (value) => progress.push(value) },
      inputs,
      probes,
      plan,
      tempDir,
      { progressStart: 10, progressEnd: 98 },
    );
    const result = await probeVideo(output);
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.hasAudio, true);
    assert.ok(result.duration > 1 && result.duration < 1.5, `duration=${result.duration}`);
    assert.ok(progress.some((value) => value > 10 && value < 98));
    assert.ok(progress.at(-1) >= 97);
  } finally {
    if (previousPreset === undefined) delete process.env.VIDEO_EDIT_X264_PRESET;
    else process.env.VIDEO_EDIT_X264_PRESET = previousPreset;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ffmpeg pads short audio to the clip duration and tolerates progress-store failures', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-audio-pad-test-'));
  const previousPreset = process.env.VIDEO_EDIT_X264_PRESET;
  const originalConsoleError = console.error;
  process.env.VIDEO_EDIT_X264_PRESET = 'ultrafast';
  console.error = () => undefined;
  try {
    const input = path.join(tempDir, 'short-audio.mp4');
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=24:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
      '-map', '0:v:0', '-map', '1:a:0', '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input,
    ]);
    const source = await probeVideo(input);
    const plan = normalizeEditPlan({
      clips: [{ sourceIndex: 0, in: 0, out: 0.95, transition: 'cut' }],
      audio: { policy: 'keep' },
    }, [source], { fps: 24 });
    const output = await renderEditPlan(
      { updateProgress: async () => { throw new Error('redis unavailable'); } },
      [input],
      [source],
      plan,
      tempDir,
    );
    const result = await probeVideo(output);
    assert.ok(result.duration > 0.9 && result.duration < 1.05, `duration=${result.duration}`);
    assert.equal(result.hasAudio, true);
  } finally {
    console.error = originalConsoleError;
    if (previousPreset === undefined) delete process.env.VIDEO_EDIT_X264_PRESET;
    else process.env.VIDEO_EDIT_X264_PRESET = previousPreset;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ffprobe planning uses video-stream duration instead of a longer audio/container duration', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-video-duration-test-'));
  try {
    const input = path.join(tempDir, 'long-audio.mp4');
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=yellow:s=320x180:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input,
    ]);
    const result = await probeVideo(input);
    assert.ok(result.duration > 0.45 && result.duration < 0.6, `duration=${result.duration}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ffmpeg integration renders a real crossfade with mixed source dimensions', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-xfade-test-'));
  const previousPreset = process.env.VIDEO_EDIT_X264_PRESET;
  process.env.VIDEO_EDIT_X264_PRESET = 'ultrafast';
  try {
    const inputs = [path.join(tempDir, 'one.mp4'), path.join(tempDir, 'two.mp4')];
    for (const [index, dimensions] of ['320x180', '180x320'].entries()) {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${index ? 'blue' : 'red'}:s=${dimensions}:r=24:d=0.9`,
        '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 440}:duration=0.9`,
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputs[index],
      ]);
    }
    const probes = await Promise.all(inputs.map((filePath) => probeVideo(filePath)));
    const plan = normalizeEditPlan({
      clips: [
        { sourceIndex: 0, in: 0, out: 0.8, transition: { type: 'crossfade', duration: 0.2 } },
        { sourceIndex: 1, in: 0, out: 0.8, transition: 'cut' },
      ],
      audio: { policy: 'keep' },
    }, probes, { resolution: '720p', aspectRatio: '16:9', fps: 24 });
    const output = await renderEditPlan({ updateProgress: async () => undefined }, inputs, probes, plan, tempDir);
    const result = await probeVideo(output);
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.hasAudio, true);
    assert.ok(result.duration > 1.3 && result.duration < 1.55, `duration=${result.duration}`);
  } finally {
    if (previousPreset === undefined) delete process.env.VIDEO_EDIT_X264_PRESET;
    else process.env.VIDEO_EDIT_X264_PRESET = previousPreset;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ai-edit safely falls back to ordered concat when video analysis is unavailable', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-ai-fallback-test-'));
  const previous = {
    anycap: process.env.ANYCAP_BIN,
    output: process.env.OUTPUT_DIR,
    preset: process.env.VIDEO_EDIT_X264_PRESET,
    allowedRoots: process.env.VIDEO_EDIT_ALLOWED_ROOTS,
  };
  process.env.ANYCAP_BIN = path.join(tempDir, 'missing-anycap');
  process.env.OUTPUT_DIR = path.join(tempDir, 'output');
  process.env.VIDEO_EDIT_X264_PRESET = 'ultrafast';
  process.env.VIDEO_EDIT_ALLOWED_ROOTS = tempDir;
  try {
    const inputs = [path.join(tempDir, 'one.mp4'), path.join(tempDir, 'two.mp4')];
    for (const [index, color] of ['red', 'blue'].entries()) {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=0.5`,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', inputs[index],
      ]);
    }
    const result = await runVideoEditJob({
      id: 'ai-fallback',
      data: {
        operation: 'ai-edit',
        prompt: 'make a short edit',
        references: inputs.map((filePath) => ({ outputType: 'video', path: filePath })),
        options: { audioPolicy: 'mute', resolution: '720p', aspectRatio: '16:9' },
      },
      updateProgress: async () => undefined,
    });
    assert.equal(result.operation, 'ai-edit');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /回退到顺序合并/);
    assert.deepEqual(result.editPlan.clips.map((clip) => clip.sourceIndex), [0, 1]);
    assert.match(result.videoUrl, /^\/output\//);
    const outputPath = path.join(process.env.OUTPUT_DIR, result.fileName);
    const outputProbe = await probeVideo(outputPath);
    assert.equal(outputProbe.hasAudio, true);
  } finally {
    for (const [name, value] of Object.entries({
      ANYCAP_BIN: previous.anycap,
      OUTPUT_DIR: previous.output,
      VIDEO_EDIT_X264_PRESET: previous.preset,
      VIDEO_EDIT_ALLOWED_ROOTS: previous.allowedRoots,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ai-edit calls video-read and validates a Sub2API plan before preview', { skip: !hasFfmpeg() || process.platform === 'win32' }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-ai-plan-test-'));
  const fakeAnyCap = path.join(tempDir, 'fake-anycap.mjs');
  await fs.writeFile(fakeAnyCap, [
    '#!/usr/bin/env node',
    "if (process.argv[2] !== 'actions' || process.argv[3] !== 'video-read') process.exit(9);",
    "process.stdout.write(JSON.stringify({data:{text:'0.0-0.4 seconds: usable shot'}}));",
  ].join('\n'), 'utf8');
  await fs.chmod(fakeAnyCap, 0o755);
  let requestedPath = '';
  const server = createServer((request, response) => {
    requestedPath = request.url || '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        version: 1,
        clips: [
          { sourceIndex: 0, in: 0.05, out: 0.35, transition: { type: 'crossfade', duration: 0.1 } },
          { sourceIndex: 1, in: 0.1, out: 0.4, transition: 'cut' },
        ],
        audio: { policy: 'keep' },
        output: { fps: 24 },
      }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const previous = {
    anycap: process.env.ANYCAP_BIN,
    base: process.env.SUB2API_BASE_URL,
    key: process.env.SUB2API_API_KEY,
    output: process.env.OUTPUT_DIR,
    analysisBytes: process.env.VIDEO_EDIT_ANALYSIS_MAX_BYTES,
    allowedRoots: process.env.VIDEO_EDIT_ALLOWED_ROOTS,
  };
  process.env.ANYCAP_BIN = fakeAnyCap;
  process.env.SUB2API_BASE_URL = `http://127.0.0.1:${address.port}/prefix/`;
  process.env.SUB2API_API_KEY = '';
  process.env.OUTPUT_DIR = path.join(tempDir, 'output');
  process.env.VIDEO_EDIT_ANALYSIS_MAX_BYTES = '1';
  process.env.VIDEO_EDIT_ALLOWED_ROOTS = tempDir;
  try {
    const inputs = [path.join(tempDir, 'one.mp4'), path.join(tempDir, 'two.mp4')];
    for (const [index, color] of ['red', 'blue'].entries()) {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=0.5`,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', inputs[index],
      ]);
    }
    const result = await runVideoEditJob({
      id: 'ai-plan-preview',
      data: {
        operation: 'ai-edit',
        prompt: 'choose highlights',
        references: inputs.map((filePath) => ({ outputType: 'video', path: filePath })),
        options: { planOnly: true, audioPolicy: 'mute' },
      },
      updateProgress: async () => undefined,
    });
    assert.equal(requestedPath, '/prefix/v1/chat/completions');
    assert.equal(result.planOnly, true);
    assert.deepEqual(result.editPlan.clips.map((clip) => clip.sourceIndex), [0, 1]);
    assert.equal(result.editPlan.audio.policy, 'mute');
    assert.equal(result.editPlan.clips[0].transition.type, 'crossfade');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.videoUrl, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries({
      ANYCAP_BIN: previous.anycap,
      SUB2API_BASE_URL: previous.base,
      SUB2API_API_KEY: previous.key,
      OUTPUT_DIR: previous.output,
      VIDEO_EDIT_ANALYSIS_MAX_BYTES: previous.analysisBytes,
      VIDEO_EDIT_ALLOWED_ROOTS: previous.allowedRoots,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('creative-edit rejects parameters outside the AnyCap model schema before upload', { skip: !hasFfmpeg() }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcanvas-creative-schema-test-'));
  const previousOutput = process.env.OUTPUT_DIR;
  process.env.OUTPUT_DIR = tempDir;
  try {
    const input = path.join(tempDir, 'source.mp4');
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=0.4',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
    ]);
    await assert.rejects(
      runVideoEditJob({
        id: 'creative-schema',
        data: {
          operation: 'creative-edit',
          references: [{ outputType: 'video', path: input }],
          options: { model: 'gemini-omni-flash-preview', resolution: '1080p' },
        },
        updateProgress: async () => undefined,
      }),
      /仅支持 720p/,
    );
  } finally {
    if (previousOutput === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = previousOutput;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
