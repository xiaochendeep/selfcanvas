import fs from 'node:fs/promises';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { loadDotEnv, outputDir } from '../workers/media-render-worker/providerRuntime.mjs';
import {
  redactVideoEditError,
  videoEditCancelKey,
  videoEditQueueName,
} from '../workers/video-edit-worker/queueContract.mjs';

await loadDotEnv();

const queueName = videoEditQueueName();
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';
const command = process.argv[2];
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection });

function json(data) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function progressValue(value) {
  if (typeof value === 'number') return Math.round(value);
  if (value && typeof value === 'object' && 'progress' in value) return Number(value.progress) || 0;
  return 0;
}

function isCanceledFailure(reason) {
  return /已取消|AbortError|cancel(?:ed|led)/i.test(String(reason || ''));
}

function attemptsValue() {
  const value = Number(process.env.VIDEO_EDIT_JOB_ATTEMPTS);
  return Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1);
}

function publicReferences(references) {
  if (!Array.isArray(references)) return [];
  return references.map((reference) => {
    if (!reference || typeof reference !== 'object') return {};
    const { path: _path, localPath: _localPath, ...safe } = reference;
    return safe;
  });
}

function publicErrorMessage(error) {
  let message = String(error || '');
  const roots = [process.cwd(), outputDir(), process.env.HOME, ...(String(process.env.VIDEO_EDIT_ALLOWED_ROOTS || '').split(path.delimiter))]
    .filter(Boolean)
    .sort((left, right) => String(right).length - String(left).length);
  for (const root of roots) message = message.replaceAll(String(root), '[local-path]');
  return redactVideoEditError(message);
}

async function toVideoEditJob(job) {
  const state = await job.getState();
  const payload = job.data || {};
  const operation = String(payload.operation || payload.options?.operation || 'concat');
  const status =
    state === 'completed' ? 'success' :
    state === 'failed' && isCanceledFailure(job.failedReason) ? 'canceled' :
    state === 'failed' ? 'error' :
    state === 'active' ? 'running' :
    state === 'delayed' || state === 'waiting' || state === 'waiting-children' ? 'queued' :
    'canceled';
  const now = new Date().toISOString();
  return {
    id: String(job.id),
    nodeId: payload.nodeId || '',
    targetNodeId: payload.targetNodeId || payload.nodeId || '',
    kind: 'video',
    operation,
    provider: operation === 'creative-edit' ? 'AnyCap' : operation === 'ai-edit' ? 'AnyCap + Sub2API + FFmpeg' : 'FFmpeg',
    model: payload.options?.model || '',
    status,
    progress: status === 'success' ? 100 : progressValue(job.progress),
    prompt: payload.prompt || '',
    inputs: Array.isArray(payload.inputs) ? payload.inputs : [],
    references: publicReferences(payload.references),
    options: payload.options && typeof payload.options === 'object' ? payload.options : {},
    result: job.returnvalue || undefined,
    error: status === 'canceled' ? undefined : publicErrorMessage(job.failedReason) || undefined,
    createdAt: payload.createdAt || new Date(job.timestamp || Date.now()).toISOString(),
    updatedAt: job.finishedOn || job.processedOn ? new Date(job.finishedOn || job.processedOn).toISOString() : now,
  };
}

async function close() {
  await queue.close();
  await connection.quit();
}

try {
  if (command === 'enqueue') {
    const payloadPath = process.argv[3];
    const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8'));
    const operation = String(payload.operation || payload.options?.operation || '').toLowerCase();
    if (!['ai-edit', 'concat', 'creative-edit'].includes(operation)) {
      throw new Error(`Unsupported video edit operation: ${operation || 'missing'}`);
    }
    payload.operation = operation;
    const job = await queue.add(operation, payload, {
      jobId: payload.id,
      removeOnComplete: false,
      removeOnFail: false,
      attempts: attemptsValue(),
    });
    json(await toVideoEditJob(job));
  } else if (command === 'get') {
    const job = await queue.getJob(process.argv[3]);
    if (!job) {
      process.exitCode = 2;
      json({ error: '任务不存在' });
    } else {
      json(await toVideoEditJob(job));
    }
  } else if (command === 'list') {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 80, false);
    const items = await Promise.all(jobs.map(toVideoEditJob));
    items.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    json(items);
  } else if (command === 'health') {
    const workers = await queue.getWorkersCount();
    json({ redis: true, workers, available: workers > 0, queue: queueName });
  } else if (command === 'cancel') {
    const job = await queue.getJob(process.argv[3]);
    if (!job) {
      process.exitCode = 2;
      json({ error: '任务不存在' });
    } else {
      const cancelKey = videoEditCancelKey(job.id, queueName);
      await connection.set(cancelKey, '1', 'EX', 3600);
      const state = await job.getState();
      if (state === 'active') {
        json({ ok: true, id: String(job.id), status: 'canceling' });
      } else if (state === 'waiting' || state === 'delayed' || state === 'waiting-children') {
        try {
          await job.remove();
          await connection.del(cancelKey);
          json({ ok: true, id: String(job.id), status: 'canceled' });
        } catch {
          // The worker may have locked the job between getState() and remove().
          // Keep the marker so the active processor aborts at its next checkpoint.
          json({ ok: true, id: String(job.id), status: 'canceling' });
        }
      } else {
        await connection.del(cancelKey);
        json({ ok: true, id: String(job.id), status: (await toVideoEditJob(job)).status });
      }
    }
  } else {
    process.exitCode = 1;
    json({ error: `Unknown command: ${command || ''}` });
  }
} catch (error) {
  process.exitCode = process.exitCode || 1;
  json({ error: error instanceof Error ? error.message : String(error) });
} finally {
  await close();
}
