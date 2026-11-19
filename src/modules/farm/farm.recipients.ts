import { and, eq } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { roles, users } from '../../db/schema/index.js';
import { ROLE_CODES } from '../../rbac/default-roles.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { notificationService } from '../notifications/notifications.service.js';

/** Active users holding the Director role (role code `director`). */
export async function directorIds(tx: Executor = db): Promise<number[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.code, ROLE_CODES.DIRECTOR), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}

export async function farmManagerIds(tx: Executor = db): Promise<number[]> {
  return notificationService.userIdsWithPermission(P.FARM_MANAGE, tx);
}

export async function agronomistIds(tx: Executor = db): Promise<number[]> {
  return notificationService.userIdsWithPermission(P.INSPECTIONS_CREATE, tx);
}
