import { and, asc, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import { documents, reportRequests, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { richTextToPlain } from '../../common/utils/rich-text.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { isReportRequestOverdue, reportRequestActions } from './report-requests.rules.js';
import type {
  CreateReportRequestInput,
  DeliverReportRequestInput,
  ReportRequestListQuery,
} from './reports.schema.js';

type Row = typeof reportRequests.$inferSelect;

const requester = alias(users, 'requester');
const assignee = alias(users, 'assignee');

const columns = {
  id: reportRequests.id,
  title: reportRequests.title,
  description: reportRequests.description,
  dueDate: reportRequests.dueDate,
  status: reportRequests.status,
  response: reportRequests.response,
  deliveredAt: reportRequests.deliveredAt,
  createdAt: reportRequests.createdAt,
  updatedAt: reportRequests.updatedAt,
  requestedBy: { id: requester.id, name: requester.name },
  assignee: { id: assignee.id, name: assignee.name },
};

const link = (id: number) => `/reports/requests/${id}`;

/** Files attached to the request (documents with entity type `report_request`). */
async function attachmentCount(tx: Executor, id: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(
      and(
        eq(documents.entityType, 'report_request'),
        eq(documents.entityId, String(id)),
        isNull(documents.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

async function lock(tx: Executor, id: number): Promise<Row> {
  const [row] = await tx
    .select()
    .from(reportRequests)
    .where(eq(reportRequests.id, id))
    .for('update');
  if (!row) throw AppError.notFound('Report request');
  return row;
}

async function load(id: number): Promise<Row | undefined> {
  const [row] = await db.select().from(reportRequests).where(eq(reportRequests.id, id));
  return row;
}

/** Director report requests to departments, tracked until delivered (FR-RPT-04, US-CEO-006). */
export const reportRequestService = {
  /** Requester, assignee or anyone who can request reports may read it (and its files). */
  async canView(user: AuthUser, id: number): Promise<boolean> {
    const row = await load(id);
    if (!row) return false;
    return (
      row.requestedBy === user.id ||
      row.assigneeId === user.id ||
      user.permissions.includes(P.REPORT_REQUESTS_CREATE)
    );
  },

  /** Only the assignee attaches the delivered report, while the request is not cancelled. */
  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const row = await load(id);
    return Boolean(row && row.assigneeId === user.id && row.status !== 'cancelled');
  },

  async list(user: AuthUser, query: ReportRequestListQuery) {
    const on = today();
    const filters: SQL[] = [
      query.box === 'sent'
        ? eq(reportRequests.requestedBy, user.id)
        : eq(reportRequests.assigneeId, user.id),
    ];
    if (query.status) filters.push(eq(reportRequests.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(reportRequests.title, term),
          like(assignee.name, term),
          like(requester.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortCol = query.sortBy === 'dueDate' ? reportRequests.dueDate : reportRequests.createdAt;
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(columns)
        .from(reportRequests)
        .innerJoin(requester, eq(requester.id, reportRequests.requestedBy))
        .innerJoin(assignee, eq(assignee.id, reportRequests.assigneeId))
        .where(where)
        .orderBy(order, desc(reportRequests.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(reportRequests)
        .innerJoin(requester, eq(requester.id, reportRequests.requestedBy))
        .innerJoin(assignee, eq(assignee.id, reportRequests.assigneeId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({ ...r, overdue: isReportRequestOverdue(r, on) })),
      Number(total),
      query,
    );
  },

  /** Open counts for the tab badges. */
  async counts(user: AuthUser) {
    const on = today();
    const [row] = await db
      .select({
        assignedOpen: sql<number>`SUM(CASE WHEN ${reportRequests.assigneeId} = ${user.id} AND ${reportRequests.status} = 'open' THEN 1 ELSE 0 END)`,
        assignedOverdue: sql<number>`SUM(CASE WHEN ${reportRequests.assigneeId} = ${user.id} AND ${reportRequests.status} = 'open' AND ${reportRequests.dueDate} < ${on} THEN 1 ELSE 0 END)`,
        sentOpen: sql<number>`SUM(CASE WHEN ${reportRequests.requestedBy} = ${user.id} AND ${reportRequests.status} = 'open' THEN 1 ELSE 0 END)`,
        sentOverdue: sql<number>`SUM(CASE WHEN ${reportRequests.requestedBy} = ${user.id} AND ${reportRequests.status} = 'open' AND ${reportRequests.dueDate} < ${on} THEN 1 ELSE 0 END)`,
      })
      .from(reportRequests)
      .where(or(eq(reportRequests.assigneeId, user.id), eq(reportRequests.requestedBy, user.id)));
    return {
      assignedOpen: Number(row?.assignedOpen ?? 0),
      assignedOverdue: Number(row?.assignedOverdue ?? 0),
      sentOpen: Number(row?.sentOpen ?? 0),
      sentOverdue: Number(row?.sentOverdue ?? 0),
    };
  },

  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select({
        ...columns,
        requestedById: reportRequests.requestedBy,
        assigneeId: reportRequests.assigneeId,
      })
      .from(reportRequests)
      .innerJoin(requester, eq(requester.id, reportRequests.requestedBy))
      .innerJoin(assignee, eq(assignee.id, reportRequests.assigneeId))
      .where(eq(reportRequests.id, id));
    if (!row) throw AppError.notFound('Report request');
    const { requestedById, assigneeId, ...rest } = row;
    if (
      requestedById !== user.id &&
      assigneeId !== user.id &&
      !user.permissions.includes(P.REPORT_REQUESTS_CREATE)
    ) {
      throw AppError.forbidden();
    }
    return {
      ...rest,
      overdue: isReportRequestOverdue(row, today()),
      actions: reportRequestActions(user, {
        status: row.status,
        requestedBy: requestedById,
        assigneeId,
      }),
    };
  },

  /** Director sends a report request; the assignee is notified in-app and by email. */
  async create(user: AuthUser, input: CreateReportRequestInput) {
    const id = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, input.assigneeId));
      if (!target || target.status !== 'active')
        throw AppError.rule('Choose an active user to deliver the report');
      const [res] = await tx.insert(reportRequests).values({
        requestedBy: user.id,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description ?? null,
        dueDate: input.dueDate ?? null,
        status: 'open',
      });
      const requestId = res.insertId;
      await auditService.log(
        {
          action: 'create',
          entityType: 'report_request',
          entityId: requestId,
          newValues: { ...input },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [input.assigneeId],
          excludeUserId: user.id,
          type: 'report_request.created',
          title: `Report requested: ${input.title}`,
          body: `${user.name} asked you for a report${input.dueDate ? ` by ${input.dueDate}` : ''}.${input.description ? ` ${richTextToPlain(input.description).slice(0, 500)}` : ''}`,
          link: link(requestId),
          entityType: 'report_request',
          entityId: requestId,
          email: true,
        },
        tx,
      );
      return requestId;
    });
    return this.get(user, id);
  },

  /** Assignee delivers the report (response + attachments); the requester is notified. */
  async deliver(user: AuthUser, id: number, input: DeliverReportRequestInput) {
    await db.transaction(async (tx) => {
      const row = await lock(tx, id);
      if (row.assigneeId !== user.id)
        throw AppError.forbidden('Only the assignee can deliver this report');
      if (row.status !== 'open') throw AppError.rule(`This request is already ${row.status}`);
      // The report is written in the editor, attached as files (Word/PDF/Excel), or both.
      const response = input.response ?? null;
      if (!response && (await attachmentCount(tx, id)) === 0) {
        throw AppError.rule('Write the report or attach at least one file before delivering');
      }
      const patch = {
        status: 'delivered' as const,
        response,
        deliveredAt: new Date(),
      };
      await tx.update(reportRequests).set(patch).where(eq(reportRequests.id, id));
      await auditService.log(
        {
          action: 'deliver',
          entityType: 'report_request',
          entityId: id,
          oldValues: { status: row.status },
          newValues: patch,
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.requestedBy],
          excludeUserId: user.id,
          type: 'report_request.delivered',
          title: `Report delivered: ${row.title}`,
          body: `${user.name} delivered the report you requested.`,
          link: link(id),
          entityType: 'report_request',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** Requester withdraws an open request; the assignee is told. */
  async cancel(user: AuthUser, id: number) {
    await db.transaction(async (tx) => {
      const row = await lock(tx, id);
      if (row.requestedBy !== user.id)
        throw AppError.forbidden('Only the requester can cancel this request');
      if (row.status !== 'open') throw AppError.rule(`This request is already ${row.status}`);
      await tx.update(reportRequests).set({ status: 'cancelled' }).where(eq(reportRequests.id, id));
      await auditService.log(
        {
          action: 'cancel',
          entityType: 'report_request',
          entityId: id,
          oldValues: { status: row.status },
          newValues: { status: 'cancelled' },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.assigneeId],
          excludeUserId: user.id,
          type: 'report_request.cancelled',
          title: `Report request cancelled: ${row.title}`,
          link: link(id),
          entityType: 'report_request',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },
};
