import { UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadDotEnv } from '../media-render-worker/providerRuntime.mjs';
import { videoEditCancelKey, videoEditQueueName } from './queueContract.mjs';
import {
  discardPublishedArtifact,
  runVideoEditJob,
  VideoEditAbortError,
  VideoEditShutdownError,
} from './runtime.mjs';

await loadDotEnv();

const queueName = videoEditQueueName();
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const activeControllers = new Map();

function envNumber(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(value) ? Math.trunc(value) : fallback);
}

const worker = new Worker(
  queueName,
  async (job) => {
    await loadDotEnv();
    const controller = new AbortController();
    activeControllers.set(String(job.id), controller);
    const timeoutMs = envNumber('VIDEO_EDIT_JOB_TIMEOUT_MS', 2 * 60 * 60 * 1000, 30_000);
    const timeout = setTimeout(() => controller.abort(new VideoEditAbortError('视频处理超时，已终止 ffmpeg/AnyCap 进程')), timeoutMs);
    const cancelPoll = setInterval(async () => {
      try {
        if (await connection.get(videoEditCancelKey(job.id, queueName))) {
          controller.abort(new VideoEditAbortError());
        }
      } catch (error) {
        console.error(`[video-edit-worker] cancel poll failed for ${job.id}: ${error.message}`);
      }
    }, 500);
    try {
      const checkCanceled = async () => Boolean(await connection.get(videoEditCancelKey(job.id, queueName)));
      const result = await runVideoEditJob(job, { signal: controller.signal, checkCanceled });
      if (await checkCanceled()) {
        await discardPublishedArtifact(result);
        throw new VideoEditAbortError();
      }
      return result;
    } catch (error) {
      if (error instanceof VideoEditShutdownError || controller.signal.reason instanceof VideoEditShutdownError) {
        throw error;
      }
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new UnrecoverableError(error instanceof Error ? error.message : '视频处理已取消');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      activeControllers.delete(String(job.id));
      await connection.del(videoEditCancelKey(job.id, queueName)).catch(() => undefined);
    }
  },
  {
    connection,
    concurrency: envNumber('VIDEO_EDIT_WORKER_CONCURRENCY', 1, 1),
    lockDuration: envNumber('VIDEO_EDIT_LOCK_DURATION_MS', 120_000, 30_000),
    maxStalledCount: 1,
  },
);

worker.on('completed', (job) => console.log(`[video-edit-worker] completed ${job.id}`));
worker.on('failed', (job, error) => console.error(`[video-edit-worker] failed ${job?.id ?? 'unknown'}: ${error.message}`));
worker.on('error', (error) => console.error(`[video-edit-worker] worker error: ${error.message}`));

console.log(`[video-edit-worker] listening on ${queueName} (${redisUrl})`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of activeControllers.values()) {
    controller.abort(new VideoEditShutdownError());
  }
  await worker.close(false);
  await connection.quit();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
