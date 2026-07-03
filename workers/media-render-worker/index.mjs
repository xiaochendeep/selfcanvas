import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadDotEnv, runProviderJob } from './providerRuntime.mjs';

await loadDotEnv();

const queueName = process.env.GENERATION_QUEUE_NAME || 'selfcanvas-generation';
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker(
  queueName,
  async (job) => {
    await job.updateProgress(10);
    const result = await runProviderJob(job);
    await job.updateProgress(100);
    return result;
  },
  { connection, concurrency: Number(process.env.GENERATION_WORKER_CONCURRENCY || 1) },
);

worker.on('completed', (job) => {
  console.log(`[generation-worker] completed ${job.id}`);
});

worker.on('failed', (job, error) => {
  console.error(`[generation-worker] failed ${job?.id ?? 'unknown'}: ${error.message}`);
});

console.log(`[generation-worker] listening on ${queueName} (${redisUrl})`);

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
