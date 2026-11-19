import { rateLimit } from 'express-rate-limit';
import { isTest } from '../../config/env.js';

const json = (message: string) => ({ error: { code: 'TOO_MANY_REQUESTS', message } });

/** Brute-force protection for credential endpoints (in addition to account lockout, NFR-06). */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many attempts, please try again later'),
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 10_000 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many requests, please slow down'),
});
