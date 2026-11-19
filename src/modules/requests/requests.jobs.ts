import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { requests } from '../../db/schema/index.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';

const DAY_MS = 24 * 3_600_000;

/** SMS + email to Directors for approvals waiting more than 24 hours (FR-NTF-03, BO-06). */
async function escalatePendingApprovals(): Promise<void> {
  const cutoff = new Date(Date.now() - DAY_MS);
  const stale = await db
    .select({ id: requests.id, reference: requests.reference, amount: requests.amount })
    .from(requests)
    .where(
      and(
        eq(requests.status, 'pending_approval'),
        isNull(requests.deletedAt),
        lt(requests.updatedAt, cutoff),
        or(isNull(requests.escalatedAt), lt(requests.escalatedAt, cutoff)),
      ),
    );
  if (!stale.length) return;

  const approvers = await notificationService.userIdsWithPermission(P.REQUESTS_APPROVE);
  for (const r of stale) {
    await db.transaction(async (tx) => {
      await notificationService.notify(
        {
          userIds: approvers,
          type: 'request.approval_overdue',
          title: `Approval waiting over 24h: ${r.reference}`,
          body: `RWF ${r.amount.toLocaleString('en-US')} is awaiting your decision`,
          link: `/requests/${r.id}`,
          entityType: 'request',
          entityId: r.id,
          email: true,
          sms: true,
          critical: true,
        },
        tx,
      );
      await tx.update(requests).set({ escalatedAt: new Date() }).where(eq(requests.id, r.id));
    });
  }
}

export const requestJobs: JobDefinition[] = [
  { name: 'requests:escalate-pending', schedule: '0 * * * *', run: escalatePendingApprovals },
];
