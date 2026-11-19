import { and, desc, eq, gte, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { auditLogs, users } from '../../db/schema/index.js';
import { getRequestContext } from '../../common/http/request-context.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { redact } from '../../common/utils/diff.js';
import type { AuditListQuery } from './audit.schema.js';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'password_change'
  | 'password_reset'
  | 'submit'
  | 'forward'
  | 'return'
  | 'approve'
  | 'reject'
  | 'pay'
  | 'verify'
  | 'status_change'
  | (string & {});

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | number | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  /** Defaults to the authenticated user of the current request. */
  userId?: number | null;
}

export const auditService = {
  /**
   * Appends an audit entry (FR-AUD-01). Pass the transaction handle so the entry is
   * committed or rolled back together with the change it describes.
   */
  async log(entry: AuditEntry, tx: Executor = db): Promise<void> {
    const ctx = getRequestContext();
    await tx.insert(auditLogs).values({
      userId: entry.userId === undefined ? (ctx?.userId ?? null) : entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      oldValues: entry.oldValues ? redact(entry.oldValues) : null,
      newValues: entry.newValues ? redact(entry.newValues) : null,
      ipAddress: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });
  },

  /** Read-only, filterable audit log for Directors (FR-AUD-02, FR-AUD-03). */
  async list(query: AuditListQuery) {
    const filters: SQL[] = [];
    if (query.userId) filters.push(eq(auditLogs.userId, query.userId));
    if (query.entityType) filters.push(eq(auditLogs.entityType, query.entityType));
    if (query.entityId) filters.push(eq(auditLogs.entityId, query.entityId));
    if (query.action) filters.push(eq(auditLogs.action, query.action));
    if (query.from) filters.push(gte(auditLogs.createdAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) filters.push(lte(auditLogs.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(auditLogs.entityType, term), like(users.name, term))!);
    }
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          oldValues: auditLogs.oldValues,
          newValues: auditLogs.newValues,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
          user: { id: users.id, name: users.name },
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(where)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },
};
