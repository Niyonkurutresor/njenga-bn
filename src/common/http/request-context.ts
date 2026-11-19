import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  userId?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Makes request metadata (actor, IP) available anywhere, e.g. to the audit log. */
export const requestContextMiddleware: RequestHandler = (req, _res, next) => {
  const ctx: RequestContext = { requestId: randomUUID() };
  if (req.ip) ctx.ip = req.ip;
  const ua = req.headers['user-agent'];
  if (ua) ctx.userAgent = ua.slice(0, 255);
  storage.run(ctx, next);
};

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setContextUser(userId: number): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}
