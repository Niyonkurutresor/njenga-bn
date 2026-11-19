import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { requests, users } from '../../../db/schema/index.js';
import { REQUEST_STATUSES, type RequestStatus } from '../../../db/enums.js';
import { toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import type { DashboardContext, Kpi, SectionBuilder } from '../dashboard.types.js';

export interface RequestItem {
  id: number;
  reference: string;
  purpose: string;
  amount: number;
  requester: string;
  createdAt: Date;
  exceedsBudget: boolean;
  link: string;
}

export interface ApprovalsSection {
  kpis: Kpi[];
  lists: { key: string; title: string; link: string; items: RequestItem[] }[];
  myRequests: { status: RequestStatus; count: number; amount: number; link: string }[] | null;
}

async function oldest(status: RequestStatus, limit = 5): Promise<RequestItem[]> {
  const rows = await db
    .select({
      id: requests.id,
      reference: requests.reference,
      purpose: requests.purpose,
      amount: requests.amount,
      requester: users.name,
      createdAt: requests.createdAt,
      exceedsBudget: requests.exceedsBudget,
    })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.requesterId))
    .where(and(isNull(requests.deletedAt), eq(requests.status, status)))
    .orderBy(asc(requests.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    amount: toNumber(r.amount),
    link: `/requests/${r.id}`,
  }));
}

/** Per-status count/amount, optionally limited to one requester. */
async function byStatus(requesterId?: number) {
  const rows = await db
    .select({
      status: requests.status,
      n: sql<number>`count(*)`,
      total: sql<string>`COALESCE(SUM(${requests.amount}), 0)`,
    })
    .from(requests)
    .where(
      and(
        isNull(requests.deletedAt),
        requesterId ? eq(requests.requesterId, requesterId) : undefined,
      ),
    )
    .groupBy(requests.status);
  const map = new Map(
    rows.map((r) => [r.status, { count: Number(r.n), amount: toNumber(r.total) }]),
  );
  return (s: RequestStatus) => map.get(s) ?? { count: 0, amount: 0 };
}

const QUEUES = [
  {
    permission: P.REQUESTS_APPROVE,
    status: 'pending_approval',
    key: 'approvals',
    label: 'Pending approvals',
    title: 'Awaiting your approval',
    view: 'approvals',
  },
  {
    permission: P.REQUESTS_REVIEW,
    status: 'submitted',
    key: 'review',
    label: 'Review queue',
    title: 'Requests to review',
    view: 'queue',
  },
  {
    permission: P.REQUESTS_DISBURSE,
    status: 'approved',
    key: 'toPay',
    label: 'Approved, to pay',
    title: 'Approved requests to pay',
    view: 'to_pay',
  },
] as const;

/** Pending approvals (Director), review queue / to pay (Office Admin), own requests (everyone). */
export const approvalsSection: SectionBuilder<ApprovalsSection> = {
  key: 'approvals',
  visible: (ctx) =>
    ctx.canAny(P.REQUESTS_APPROVE, P.REQUESTS_REVIEW, P.REQUESTS_DISBURSE, P.REQUESTS_CREATE),
  async build(ctx: DashboardContext) {
    const queues = QUEUES.filter((q) => ctx.can(q.permission));
    const [all, lists, mine] = await Promise.all([
      queues.length ? byStatus() : null,
      Promise.all(queues.map((q) => oldest(q.status))),
      ctx.can(P.REQUESTS_CREATE) ? byStatus(ctx.user.id) : null,
    ]);

    const kpis: Kpi[] = queues.map((q) => {
      const s = all!(q.status);
      return {
        key: q.key,
        label: q.label,
        value: s.count,
        format: 'number',
        tone: s.count ? 'amber' : 'green',
        hint: `RWF ${s.amount.toLocaleString('en-US')}`,
        link: `/requests?view=${q.view}`,
      };
    });

    let myRequests: ApprovalsSection['myRequests'] = null;
    if (mine) {
      myRequests = REQUEST_STATUSES.map((status) => ({
        status,
        ...mine(status),
        link: `/requests?view=mine&status=${status}`,
      }));
      const open = ['submitted', 'returned', 'pending_approval', 'approved'] as const;
      kpis.push({
        key: 'myOpen',
        label: 'My open requests',
        value: open.reduce((acc, s) => acc + mine(s).count, 0),
        format: 'number',
        tone: mine('returned').count ? 'amber' : 'neutral',
        hint: mine('returned').count
          ? `${mine('returned').count} returned for correction`
          : undefined,
        link: '/requests?view=mine',
      });
    }

    return {
      kpis,
      lists: queues.map((q, i) => ({
        key: q.key,
        title: q.title,
        link: `/requests?view=${q.view}`,
        items: lists[i] ?? [],
      })),
      myRequests,
    };
  },
};
