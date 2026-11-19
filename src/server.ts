import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDb } from './db/client.js';
import { startJobs, stopJobs } from './jobs/scheduler.js';

function bootstrap() {
  const server = createApp().listen(env.PORT, () => {
    logger.info(`API listening on ${env.APP_URL}/api/v1 (${env.NODE_ENV})`);
  });
  startJobs();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await stopJobs();
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  bootstrap();
} catch (err) {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
}
