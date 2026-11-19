import { hash } from 'bcryptjs';
import { outerColumn } from '../../common/utils/sql.js';
import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rolePermissions, roles, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { auditService } from '../audit/audit.service.js';
import { BCRYPT_ROUNDS } from '../auth/password-policy.js';
import type { CreateUserInput, UpdateUserInput, UserListQuery } from './users.schema.js';

/** Public user shape — never exposes the password hash. */
const publicColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  status: users.status,
  jobTitle: users.jobTitle,
  department: users.department,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  role: { id: roles.id, code: roles.code, name: roles.name },
};

const SORTS = {
  name: users.name,
  email: users.email,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
} as const;

async function assertRoleExists(roleId: number) {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
  if (!role) throw AppError.validation({ fields: { roleId: ['Role does not exist'] } });
}

export const usersService = {
  async list(query: UserListQuery) {
    const filters: SQL[] = [];
    if (query.roleId) filters.push(eq(users.roleId, query.roleId));
    if (query.status) filters.push(eq(users.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(users.name, term), like(users.email, term), like(users.phone, term))!);
    }
    const where = filters.length ? and(...filters) : undefined;
    const sortCol = SORTS[query.sortBy ?? 'name'];
    const order = query.sortDir === 'asc' || !query.sortBy ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(publicColumns)
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(where)
        .orderBy(order)
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(users)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async get(id: number) {
    const [row] = await db
      .select(publicColumns)
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, id));
    if (!row) throw AppError.notFound('User');
    return row;
  },

  /** Lightweight list of active users for pickers (assignees, participants, team members). */
  async options(filter: {
    permission?: string | undefined;
    roleCode?: string | undefined;
    search?: string | undefined;
  }) {
    const filters: SQL[] = [eq(users.status, 'active')];
    if (filter.roleCode) filters.push(eq(roles.code, filter.roleCode));
    if (filter.search) filters.push(like(users.name, `%${filter.search}%`));
    if (filter.permission) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${rolePermissions} rp WHERE rp.role_id = ${outerColumn(users.roleId)} AND rp.permission = ${filter.permission})`,
      );
    }
    return db
      .select({ id: users.id, name: users.name, roleCode: roles.code, roleName: roles.name })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(...filters))
      .orderBy(asc(users.name))
      .limit(500);
  },

  /** Directors create accounts and assign exactly one role (FR-USR-01, FR-USR-02). */
  async create(input: CreateUserInput) {
    await assertRoleExists(input.roleId);
    const id = await db.transaction(async (tx) => {
      const [res] = await tx.insert(users).values({
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        roleId: input.roleId,
        jobTitle: input.jobTitle ?? null,
        department: input.department ?? null,
        passwordHash: await hash(input.password, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
      });
      const { password: _password, ...logged } = input;
      await auditService.log(
        { action: 'create', entityType: 'user', entityId: res.insertId, newValues: logged },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateUserInput) {
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw AppError.notFound('User');
    if (input.roleId) await assertRoleExists(input.roleId);

    const changes = diff(before, input);
    if (changes) {
      await db.transaction(async (tx) => {
        await tx.update(users).set(changes.newValues).where(eq(users.id, id));
        await auditService.log(
          { action: 'update', entityType: 'user', entityId: id, ...changes },
          tx,
        );
      });
    }
    return this.get(id);
  },

  /**
   * Deactivated users cannot log in but all their records stay linked (FR-USR-08).
   * Users are never hard-deleted.
   */
  async setStatus(id: number, status: 'active' | 'inactive', actorId: number) {
    if (id === actorId && status === 'inactive') {
      throw AppError.rule('You cannot deactivate your own account');
    }
    const [before] = await db.select({ status: users.status }).from(users).where(eq(users.id, id));
    if (!before) throw AppError.notFound('User');
    if (before.status !== status) {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ status }).where(eq(users.id, id));
        await auditService.log(
          {
            action: status === 'inactive' ? 'deactivate' : 'reactivate',
            entityType: 'user',
            entityId: id,
            oldValues: before,
            newValues: { status },
          },
          tx,
        );
      });
    }
    return this.get(id);
  },

  /** Director sets a new password for a user (e.g. first login or lost access). */
  async setPassword(id: number, password: string): Promise<void> {
    await this.get(id);
    await db
      .update(users)
      .set({
        passwordHash: await hash(password, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, id));
    await auditService.log({ action: 'password_reset', entityType: 'user', entityId: id });
  },
};
