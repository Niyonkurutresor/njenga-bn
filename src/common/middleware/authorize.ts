import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { hasPermissions, type Permission } from '../../rbac/permissions.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';

/**
 * Requires the authenticated user to hold the permission(s). Must run after `authenticate`.
 * Server-side enforcement on every request (NFR-05).
 *
 * @example router.get('/', authorize(P.FINANCE_VIEW), handler)
 * @example authorize([P.PROJECTS_VIEW, P.PROJECTS_VIEW_ASSIGNED], 'any')
 */
export function authorize(
  required: Permission | readonly Permission[],
  mode: 'all' | 'any' = 'all',
): RequestHandler {
  const list: readonly Permission[] = typeof required === 'string' ? [required] : required;
  return (req, _res, next) => {
    if (!req.user) throw AppError.unauthorized();
    if (!hasPermissions(req.user.permissions, list, mode)) throw AppError.forbidden();
    next();
  };
}

/** Imperative check for use inside services (e.g. "own records only" rules). */
export function can(user: AuthUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function assertCan(user: AuthUser, permission: Permission): void {
  if (!can(user, permission)) throw AppError.forbidden();
}
