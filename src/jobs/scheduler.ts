import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { JobDefinition } from './job.types.js';
import { ALL_JOBS } from './registry.js';

const running = new Set<string>();
const tasks: ScheduledTask[] = [];

async function execute(job: JobDefinition): Promise<void> {
  // Skip overlapping runs of the same job.
  if (running.has(job.name)) return;
  running.add(job.name);
  const started = Date.now();
  try {
    await job.run();
    logger.debug({ job: job.name, ms: Date.now() - started }, 'Job finished');
  } catch (err) {
    logger.error({ err, job: job.name }, 'Job failed');
  } finally {
    running.delete(job.name);
  }
}

export function startJobs(): void {
  if (env.DISABLE_JOBS) {
    logger.info('Background jobs disabled (DISABLE_JOBS=true)');
    return;
  }
  for (const job of ALL_JOBS) {
    tasks.push(
      cron.schedule(job.schedule, () => void execute(job), {
        timezone: env.TIMEZONE,
        name: job.name,
      }),
    );
  }
  logger.info({ jobs: ALL_JOBS.map((j) => j.name) }, 'Background jobs scheduled');
}

export async function stopJobs(): Promise<void> {
  await Promise.all(tasks.map((t) => t.stop()));
}

/** Runs a job immediately by name (used by `npm run job -- <name>`). */
export async function runJobNow(name: string): Promise<void> {
  const job = ALL_JOBS.find((j) => j.name === name);
  if (!job)
    throw new Error(`Unknown job "${name}". Known: ${ALL_JOBS.map((j) => j.name).join(', ')}`);
  await job.run();
}
