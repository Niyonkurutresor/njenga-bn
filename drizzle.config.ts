import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

process.loadEnvFile?.('.env');

const ssl =
  process.env.DB_SSL === 'true'
    ? process.env.DB_SSL_CA
      ? { ca: readFileSync(process.env.DB_SSL_CA, 'utf8') }
      : { rejectUnauthorized: false }
    : undefined;

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'njenga',
    ...(ssl ? { ssl } : {}),
  },
  strict: true,
  verbose: true,
});
