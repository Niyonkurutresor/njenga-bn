import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { USER_STATUSES } from '../enums.js';
import { createdAt, dateTime, id, ref, timestamps } from './_columns.js';

/** Roles are data, so Directors can configure them without code changes (NFR-13). */
export const roles = mysqlTable(
  'roles',
  {
    id: id(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    /** System roles (the seven NGL roles) cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('roles_code_uq').on(t.code)],
);

/** Permission keys granted to a role (`module:action`, see src/rbac/permissions.ts). */
export const rolePermissions = mysqlTable(
  'role_permissions',
  {
    roleId: ref('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: varchar('permission', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const users = mysqlTable(
  'users',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    roleId: ref('role_id')
      .notNull()
      .references(() => roles.id),
    status: mysqlEnum('status', USER_STATUSES).notNull().default('active'),
    jobTitle: varchar('job_title', { length: 100 }),
    department: varchar('department', { length: 100 }),
    failedLoginAttempts: int('failed_login_attempts').notNull().default(0),
    lockedUntil: dateTime('locked_until'),
    lastLoginAt: dateTime('last_login_at'),
    passwordChangedAt: dateTime('password_changed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_phone_uq').on(t.phone),
    index('users_role_idx').on(t.roleId),
  ],
);

export const passwordResetTokens = mysqlTable(
  'password_reset_tokens',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token; the raw token is only ever sent to the user. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: dateTime('expires_at').notNull(),
    usedAt: dateTime('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('prt_token_uq').on(t.tokenHash)],
);
