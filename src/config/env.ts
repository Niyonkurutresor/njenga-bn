import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(9019),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_NAME: z.string().default('NGL Management System'),
  APP_URL: z.url().default('http://localhost:9019'),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  CORS_ORIGINS: csv,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  TIMEZONE: z.string().default('Africa/Kigali'),
  CURRENCY: z.string().default('RWF'),

  // Database
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  DB_SSL: bool,
  /** Path to the CA certificate. When empty with DB_SSL=true the server cert is NOT verified. */
  DB_SSL_CA: z.string().default(''),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_LOG: bool,

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  RESET_TOKEN_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  // Seed
  SEED_DIRECTOR_NAME: z.string().default('Director'),
  SEED_DIRECTOR_EMAIL: z.email().default('director@njengagreens.local'),
  SEED_DIRECTOR_PASSWORD: z.string().min(8).default('Director@2026'),

  // Email (log = print to console, smtp = send)
  MAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  MAIL_SERVICE: z.string().default(''),
  MAIL_HOST: z.string().default(''),
  MAIL_PORT: z.coerce.number().int().positive().default(587),
  MAIL_USER: z.string().default(''),
  MAIL_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('NGL Management System <no-reply@njengagreens.local>'),

  // SMS (log = print to console, pindo = send)
  SMS_PROVIDER: z.enum(['log', 'pindo']).default('log'),
  SMS_API_TOKEN: z.string().default(''),
  SMS_SENDER_ID: z.string().default('NGL'),

  // File storage (local = ./uploads, cloudinary = Cloudinary)
  STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_FOLDER: z.string().default('ngl'),

  // Background jobs
  DISABLE_JOBS: bool,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on env, so report with plain stderr.
  process.stderr.write(`Invalid environment variables:\n${z.prettifyError(parsed.error)}\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Allowed browser origins: FRONTEND_URL plus any extra CORS_ORIGINS. */
export const corsOrigins = [...new Set([env.FRONTEND_URL, ...env.CORS_ORIGINS])];
