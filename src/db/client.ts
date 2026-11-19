import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type PoolOptions } from 'mysql2/promise';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as schema from './schema/index.js';

function sslOptions(): PoolOptions['ssl'] {
  if (!env.DB_SSL) return undefined;
  if (env.DB_SSL_CA) return { ca: readFileSync(env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  logger.warn('DB_SSL_CA is not set: the database TLS certificate will not be verified');
  return { rejectUnauthorized: false };
}

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: sslOptions(),
  connectionLimit: env.DB_POOL_SIZE,
  waitForConnections: true,
  // Store and read DATETIME values as UTC.
  timezone: 'Z',
  dateStrings: ['DATE'],
  decimalNumbers: false,
});

export const db = drizzle(pool, {
  schema,
  mode: 'default',
  logger: env.DB_LOG
    ? { logQuery: (query, params) => logger.debug({ query, params }, 'sql') }
    : false,
});

export type Database = typeof db;
/** A transaction handle — services accept `Executor` so they work inside or outside a transaction. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export async function closeDb(): Promise<void> {
  await pool.end();
}
