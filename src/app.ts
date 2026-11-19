import path from 'node:path';
import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestContextMiddleware } from './common/http/request-context.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { apiRateLimit } from './common/middleware/rate-limit.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || corsOrigins.includes(origin)),
      credentials: true,
      // Lets the web app read export file names when it is served from another origin.
      exposedHeaders: ['Content-Disposition'],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }));
  app.use(requestContextMiddleware);

  // Local-disk uploads (STORAGE_DRIVER=local). File names are random UUIDs.
  if (env.STORAGE_DRIVER === 'local') {
    app.use(
      '/uploads',
      express.static(path.resolve(env.UPLOAD_DIR), { maxAge: '7d', index: false }),
    );
  }

  app.use('/api/v1', apiRateLimit, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
