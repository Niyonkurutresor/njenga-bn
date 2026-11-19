import type { Permission } from '../../rbac/permissions.js';

/** Identity attached to `req.user` by `authenticate`. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  roleId: number;
  roleCode: string;
  roleName: string;
  permissions: readonly Permission[];
}

export interface JwtPayload {
  sub: string;
  /** Issued-at (seconds), compared with password_changed_at to revoke old tokens. */
  iat: number;
}

/** Profile returned to the client after login and from GET /auth/me. */
export interface SessionUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  role: { id: number; code: string; name: string };
  permissions: readonly Permission[];
  lastLoginAt: Date | null;
}
