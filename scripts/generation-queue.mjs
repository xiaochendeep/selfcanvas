import fs from 'node:fs/promises';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { loadDotEnv } from '../workers/media-render-worker/providerRuntime.mjs';

await loadDotEnv();

const queueName = process.env.GENERATION_QUEUE_NAME || 'selfcanvas-generation';
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

async function toGenerationJob(job) {
  const state = await job.getState();
  const payload = job.data || {};
  const status =
    state === 'completed' ? 'success' :
    state === 'failed' ? 'error' :
    state === 'active' ? 'running' :
    state === 'delayed' || state === 'waiting' || state === 'waiting-children' ? 'queued' :
    'canceled';
  const now = new Date().toISOString();
  return {
    id: String(job.id),
    nodeId: payload.nodeId || '',
    kind: payload.kind || 'text',
    provider: payload.provider || '',
    model: payload.model || '',
    status,
    progress: status === 'success' ? 100 : progressValue(job.progress),
    prompt: payload.prompt || '',
    inputs: Array.isArray(payload.inputs) ? payload.inputs : [],
    result: job.returnvalue || undefined,
    error: job.failedReason || undefined,
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
    const job = await queue.add('generate', payload, {
      jobId: payload.id,
      removeOnComplete: false,
      removeOnFail: false,
      attempts: Number(process.env.GENERATION_JOB_ATTEMPTS || 1),
    });
    json(await toGenerationJob(job));
  } else if (command === 'get') {
    const job = await queue.getJob(process.argv[3]);
    if (!job) {
      process.exitCode = 2;
      json({ error: '任务不存在' });
    } else {
      json(await toGenerationJob(job));
    }
  } else if (command === 'list') {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 80, false);
    const items = await Promise.all(jobs.map(toGenerationJob));
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    json(items);
  } else if (command === 'health') {
    const workers = await queue.getWorkersCount();
    json({ redis: true, workers, available: workers > 0 });
  } else if (command === 'cancel') {
    const job = await queue.getJob(process.argv[3]);
    if (!job) {
      process.exitCode = 2;
      json({ error: '任务不存在' });
    } else {
      await job.remove();
      json({ ok: true });
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
