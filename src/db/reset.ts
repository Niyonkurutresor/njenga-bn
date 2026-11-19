import { sql } from 'drizzle-orm';
import { env, isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';
import { closeDb, db } from './client.js';

/**
 * DESTRUCTIVE: drops every table in DB_NAME. Development only; requires `--yes`.
 * Usage: npm run db:reset -- --yes
 */
async function main() {
  if (isProduction) throw new Error('db:reset is disabled in production');
  if (!process.argv.includes('--yes')) {
    throw new Error(`This drops ALL tables in "${env.DB_NAME}". Re-run with --yes to confirm.`);
  }

  const [rows] = (await db.execute(
    sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${env.DB_NAME}`,
  )) as unknown as [{ name: string }[]];

  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const { name } of rows) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS \`${name.replace(/`/g, '')}\``));
    logger.info(`Dropped ${name}`);
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  logger.info(`Dropped ${rows.length} tables from ${env.DB_NAME}`);
}

main()
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Reset failed');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
