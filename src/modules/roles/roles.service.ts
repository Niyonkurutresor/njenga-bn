import { asc, eq, sql } from 'drizzle-orm';
import { outerColumn } from '../../common/utils/sql.js';
import { db } from '../../db/client.js';
import { rolePermissions, roles, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { isPermission, type Permission } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schema.js';

/**
 * Role → permissions cache. Permissions are read on every authenticated request, so they are
 * cached in memory and invalidated whenever a role changes (single-instance deployment).
 */
const cache = new Map<number, { code: string; name: string; permissions: Permission[] }>();

async function loadRole(roleId: number) {
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
  if (!role) return null;
  const perms = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  const entry = {
    code: role.code,
    name: role.name,
    // Ignore keys that no longer exist in the catalogue.
    permissions: perms.map((p) => p.permission).filter(isPermission),
  };
  cache.set(roleId, entry);
  return entry;
}

export const rolesService = {
  async getRoleAccess(roleId: number) {
    return cache.get(roleId) ?? (await loadRole(roleId));
  },

  invalidate(roleId?: number): void {
    if (roleId === undefined) cache.clear();
    else cache.delete(roleId);
  },

  async list() {
    const rows = await db
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
        userCount: sql<number>`(SELECT COUNT(*) FROM users u WHERE u.role_id = ${outerColumn(roles.id)})`,
      })
      .from(roles)
      .orderBy(asc(roles.id));
    const perms = await db.select().from(rolePermissions);
    return rows.map((r) => ({
      ...r,
      userCount: Number(r.userCount),
      permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
    }));
  },

  async get(id: number) {
    const [role] = await db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw AppError.notFound('Role');
    const perms = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, id));
    return { ...role, permissions: perms.map((p) => p.permission) };
  },

  async create(input: CreateRoleInput) {
    const id = await db.transaction(async (tx) => {
      const [res] = await tx.insert(roles).values({
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
      });
      const roleId = res.insertId;
      if (input.permissions.length) {
        await tx
          .insert(rolePermissions)
          .values(input.permissions.map((permission) => ({ roleId, permission })));
      }
      await auditService.log(
        { action: 'create', entityType: 'role', entityId: roleId, newValues: input },
        tx,
      );
      return roleId;
    });
    return this.get(id);
  },

  /** Updates name/description and replaces the permission set (FR-USR-03). */
  async update(id: number, input: UpdateRoleInput) {
    const before = await this.get(id);
    await db.transaction(async (tx) => {
      if (input.name !== undefined || input.description !== undefined) {
        await tx
          .update(roles)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          })
          .where(eq(roles.id, id));
      }
      if (input.permissions) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        if (input.permissions.length) {
          await tx
            .insert(rolePermissions)
            .values(input.permissions.map((permission) => ({ roleId: id, permission })));
        }
      }
      await auditService.log(
        {
          action: 'update',
          entityType: 'role',
          entityId: id,
          oldValues: {
            name: before.name,
            description: before.description,
            permissions: before.permissions,
          },
          newValues: input,
        },
        tx,
      );
    });
    this.invalidate(id);
    return this.get(id);
  },

  async remove(id: number): Promise<void> {
    const role = await this.get(id);
    if (role.isSystem) throw AppError.rule('System roles cannot be deleted');
    const [inUse] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.roleId, id));
    if (Number(inUse?.n) > 0) throw AppError.rule('Reassign this role’s users before deleting it');
    await db.transaction(async (tx) => {
      await tx.delete(roles).where(eq(roles.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'role', entityId: id, oldValues: role },
        tx,
      );
    });
    this.invalidate(id);
  },
};
