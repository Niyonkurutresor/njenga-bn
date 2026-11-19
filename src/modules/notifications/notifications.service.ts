import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  notificationPreferences,
  notifications,
  rolePermissions,
  users,
} from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { offsetOf, paginated, type ListQuery } from '../../common/http/pagination.js';
import { AppError } from '../../common/errors/app-error.js';
import { renderEmail, sendMail } from '../../lib/mailer.js';
import { sendSms } from '../../lib/sms.js';
import type { Permission } from '../../rbac/permissions.js';

export interface NotifyInput {
  /** Recipients; duplicates and the acting user (`excludeUserId`) are removed. */
  userIds: readonly number[];
  type: string;
  title: string;
  body?: string;
  /** Frontend path, e.g. `/requests/12`. */
  link?: string;
  entityType?: string;
  entityId?: string | number;
  /** Also send an email (FR-NTF-02). */
  email?: boolean;
  /** Also send an SMS — urgent items only (FR-NTF-03). */
  sms?: boolean;
  /** Critical notifications ignore user opt-outs (FR-NTF-04). */
  critical?: boolean;
  excludeUserId?: number;
}

/** Fire-and-forget delivery so a slow mail/SMS provider never blocks a request. */
function deliverExternally(
  recipients: { id: number; email: string; phone: string | null }[],
  input: NotifyInput,
  optOut: Map<number, { email: boolean; sms: boolean }>,
): void {
  const url = input.link ? `${env.FRONTEND_URL}${input.link}` : undefined;
  for (const r of recipients) {
    const pref = input.critical ? undefined : optOut.get(r.id);
    if (input.email && pref?.email !== false) {
      sendMail({
        to: r.email,
        subject: input.title,
        text: `${input.body ?? input.title}${url ? `\n\n${url}` : ''}`,
        html: renderEmail(input.title, input.body ?? '', url),
      }).catch((err: unknown) => logger.error({ err, to: r.email }, 'Email delivery failed'));
    }
    if (input.sms && r.phone && pref?.sms !== false) {
      sendSms(r.phone, `${input.title}${input.body ? `: ${input.body}` : ''}`).catch(
        (err: unknown) => logger.error({ err, to: r.phone }, 'SMS delivery failed'),
      );
    }
  }
}

export const notificationService = {
  /**
   * Notifies users in-app and optionally by email / SMS (FR-NTF-01..03, BR-13).
   * In-app rows are written with `tx` so they commit with the business change.
   */
  async notify(input: NotifyInput, tx: Executor = db): Promise<void> {
    const ids = [...new Set(input.userIds)].filter((id) => id !== input.excludeUserId);
    if (!ids.length) return;

    const recipients = await tx
      .select({ id: users.id, email: users.email, phone: users.phone })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.status, 'active')));
    if (!recipients.length) return;

    await tx.insert(notifications).values(
      recipients.map((r) => ({
        userId: r.id,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId == null ? null : String(input.entityId),
      })),
    );

    if (input.email || input.sms) {
      const prefs = await tx
        .select()
        .from(notificationPreferences)
        .where(
          and(
            inArray(
              notificationPreferences.userId,
              recipients.map((r) => r.id),
            ),
            eq(notificationPreferences.type, input.type),
          ),
        );
      const optOut = new Map(
        prefs.map((p) => [p.userId, { email: p.emailEnabled, sms: p.smsEnabled }]),
      );
      deliverExternally(recipients, input, optOut);
    }
  },

  /** Active users whose role grants `permission` (e.g. all approvers). */
  async userIdsWithPermission(permission: Permission, tx: Executor = db): Promise<number[]> {
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, users.roleId))
      .where(and(eq(rolePermissions.permission, permission), eq(users.status, 'active')));
    return rows.map((r) => r.id);
  },

  async list(userId: number, query: ListQuery & { unread?: boolean | undefined }) {
    const where = and(
      eq(notifications.userId, userId),
      query.unread ? isNull(notifications.readAt) : undefined,
    );
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(notifications)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async unreadCount(userId: number): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Number(row?.n ?? 0);
  },

  async markRead(userId: number, id: number): Promise<void> {
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
    if (result[0].affectedRows === 0) throw AppError.notFound('Notification');
  },

  async markAllRead(userId: number): Promise<void> {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  },

  async getPreferences(userId: number) {
    return db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
  },

  async setPreference(
    userId: number,
    pref: { type: string; emailEnabled: boolean; smsEnabled: boolean },
  ): Promise<void> {
    await db
      .insert(notificationPreferences)
      .values({ userId, ...pref })
      .onDuplicateKeyUpdate({
        set: { emailEnabled: pref.emailEnabled, smsEnabled: pref.smsEnabled },
      });
  },
};
