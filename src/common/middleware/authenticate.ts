import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { setContextUser } from '../http/request-context.js';
import { authService } from '../../modules/auth/auth.service.js';

/** Verifies the Bearer token and attaches `req.user` with the role's current permissions. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();

  req.user = await authService.verifyToken(header.slice('Bearer '.length).trim());
  setContextUser(req.user.id);
  next();
};
