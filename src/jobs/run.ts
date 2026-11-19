import { logger } from '../config/logger.js';
import { closeDb } from '../db/client.js';
import { runJobNow } from './scheduler.js';

/** Usage: npm run job -- <job-name> */
const name = process.argv[2];
if (!name) {
  logger.error('Usage: npm run job -- <job-name>');
  process.exit(1);
}
runJobNow(name)
  .then(() => logger.info(`Job ${name} finished`))
  .catch((err: unknown) => {
    logger.fatal({ err }, `Job ${name} failed`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
