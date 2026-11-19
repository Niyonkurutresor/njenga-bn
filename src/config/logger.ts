import { pino } from 'pino';
import { env, isProduction, isTest } from './env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  ...(isProduction ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
