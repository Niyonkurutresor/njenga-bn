import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import { categories, projects, requestEvents, requests, users } from '../../db/schema/index.js';
import type { RequestEventAction, RequestStatus } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { nextReference } from '../../common/utils/sequence.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { wouldExceedBudget } from '../finance/finance.calc.js';
import { projectBudgetUsage, recordTransaction, referenceExists } from '../finance/ledger.js';
import { notificationService } from '../notifications/notifications.service.js';
import { advanceProjectStatus } from '../projects/project-lifecycle.js';
import type {
  CreateRequestInput,
  DisburseInput,
  RequestListQuery,
  ResubmitRequestInput,
} from './requests.schema.js';
import {
  availableActions,
  canPerform,
  nextStatus,
  type RequestAction,
} from './requests.workflow.js';

type RequestRow = typeof requests.$inferSelect;

const requester = alias(users, 'requester');
const decider = alias(users, 'decider');
const disburser = alias(users, 'disburser');

const listColumns = {
  id: requests.id,
  reference: requests.reference,
  type: requests.type,
  amount: requests.amount,
  purpose: requests.purpose,
  costCentreType: requests.costCentreType,
  neededBy: requests.neededBy,
  status: requests.status,
  exceedsBudget: requests.exceedsBudget,
  createdAt: requests.createdAt,
  updatedAt: requests.updatedAt,
  requester: { id: requester.id, name: requester.name },
  project: { id: projects.id, code: projects.code, name: projects.name },
};

const SORTS = {
  createdAt: requests.createdAt,
  amount: requests.amount,
  neededBy: requests.neededBy,
} as const;

/** Users who see every request, not just their own. */
function seesAll(user: AuthUser): boolean {
  // Finance viewers see every request: paid requests are part of the money records they audit.
  return [
    P.REQUESTS_VIEW_ALL,
    P.REQUESTS_REVIEW,
    P.REQUESTS_APPROVE,
    P.REQUESTS_DISBURSE,
    P.FINANCE_VIEW,
  ].some((p) => user.permissions.includes(p));
}

function link(id: number) {
  return `/requests/${id}`;
}

function money(n: number) {
  return `RWF ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

async function lockRequest(tx: Executor, id: number): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), isNull(requests.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Request');
  return row;
}

function assertCan(action: RequestAction, user: AuthUser, row: RequestRow) {
  if (!canPerform(action, user, row)) {
    throw AppError.rule(
      `This request cannot be ${actionLabel(action)} while it is ${row.status.replace('_', ' ')}`,
    );
  }
}

function actionLabel(action: RequestAction): string {
  return {
    resubmit: 'resubmitted',
    forward: 'forwarded',
    return: 'returned',
    approve: 'approved',
    reject: 'rejected',
    pay: 'paid',
    comment: 'commented on',
  }[action];
}

async function recordEvent(
  tx: Executor,
  requestId: number,
  actorId: number,
  action: RequestEventAction,
  fromStatus: RequestStatus | null,
  toStatus: RequestStatus | null,
  comment?: string | null,
) {
  await tx.insert(requestEvents).values({
    requestId,
    actorId,
    action,
    fromStatus,
    toStatus,
    comment: comment ?? null,
  });
}

/** Validates the cost centre and returns whether approving would exceed the project budget. */
async function checkCostCentre(
  tx: Executor,
  input: { costCentreType: string; projectId?: number | null | undefined },
  amount: number,
): Promise<boolean> {
  if (input.costCentreType !== 'project') return false;
  if (!input.projectId) throw AppError.rule('Select the project this request is for');
  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)));
  if (!project) throw AppError.rule('Project does not exist');
  if (project.status === 'closed')
    throw AppError.rule('Requests cannot be raised for a closed project');
  const usage = await projectBudgetUsage(tx, input.projectId);
  return wouldExceedBudget(usage.budget, usage.spent, amount);
}

const TRANSITION_EVENT = {
  forward: 'forwarded',
  return: 'returned',
  approve: 'approved',
  reject: 'rejected',
} as const satisfies Record<string, RequestEventAction>;

async function transition(
  user: AuthUser,
  id: number,
  action: Exclude<RequestAction, 'comment' | 'resubmit' | 'pay'>,
  comment: string | undefined,
  apply: (tx: Executor, row: RequestRow) => Promise<Partial<RequestRow>>,
  afterCommit: (tx: Executor, row: RequestRow) => Promise<void>,
) {
  await db.transaction(async (tx) => {
    const row = await lockRequest(tx, id);
    assertCan(action, user, row);
    const to = nextStatus(action);
    const patch = { ...(await apply(tx, row)), status: to };
    await tx.update(requests).set(patch).where(eq(requests.id, id));
    await recordEvent(tx, id, user.id, TRANSITION_EVENT[action], row.status, to, comment);
    await auditService.log(
      {
        action,
        entityType: 'request',
        entityId: id,
        oldValues: { status: row.status },
        newValues: patch,
      },
      tx,
    );
    await afterCommit(tx, { ...row, ...patch });
  });
}

export const requestService = {
  async canView(user: AuthUser, id: number): Promise<boolean> {
    if (seesAll(user)) return true;
    const [row] = await db
      .select({ requesterId: requests.requesterId })
      .from(requests)
      .where(and(eq(requests.id, id), isNull(requests.deletedAt)));
    return row?.requesterId === user.id;
  },

  /** Requester attaches while editable; Office Admin attaches receipts until paid. */
  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const [row] = await db
      .select({ requesterId: requests.requesterId, status: requests.status })
      .from(requests)
      .where(and(eq(requests.id, id), isNull(requests.deletedAt)));
    if (!row) return false;
    if (row.requesterId === user.id && ['submitted', 'returned'].includes(row.status)) return true;
    return (
      user.permissions.includes(P.REQUESTS_DISBURSE) && ['approved', 'paid'].includes(row.status)
    );
  },

  /** Request queue with filters and sorting (US-OA-001 AC1, AC2; FR-REQ-09). */
  async list(user: AuthUser, query: RequestListQuery) {
    const filters: SQL[] = [isNull(requests.deletedAt)];
    if (!seesAll(user) || query.mine) filters.push(eq(requests.requesterId, user.id));
    if (query.status?.length) filters.push(inArray(requests.status, query.status));
    if (query.type) filters.push(eq(requests.type, query.type));
    if (query.requesterId) filters.push(eq(requests.requesterId, query.requesterId));
    if (query.costCentreType) filters.push(eq(requests.costCentreType, query.costCentreType));
    if (query.projectId) filters.push(eq(requests.projectId, query.projectId));
    if (query.from) filters.push(gte(requests.createdAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) filters.push(lte(requests.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(requests.reference, term),
          like(requests.purpose, term),
          like(requester.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'createdAt'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(listColumns)
        .from(requests)
        .innerJoin(requester, eq(requester.id, requests.requesterId))
        .leftJoin(projects, eq(projects.id, requests.projectId))
        .where(where)
        .orderBy(order, desc(requests.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(requests)
        .innerJoin(requester, eq(requester.id, requests.requesterId))
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  /** Request with history, budget impact and the actions available to the viewer. */
  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select({
        ...listColumns,
        categoryId: requests.categoryId,
        projectId: requests.projectId,
        requesterId: requests.requesterId,
        rejectionReason: requests.rejectionReason,
        decidedAt: requests.decidedAt,
        paidAmount: requests.paidAmount,
        paidOn: requests.paidOn,
        paymentMethod: requests.paymentMethod,
        paymentReference: requests.paymentReference,
        transactionId: requests.transactionId,
        category: { id: categories.id, name: categories.name },
        decidedBy: { id: decider.id, name: decider.name },
        disbursedBy: { id: disburser.id, name: disburser.name },
      })
      .from(requests)
      .innerJoin(requester, eq(requester.id, requests.requesterId))
      .leftJoin(projects, eq(projects.id, requests.projectId))
      .leftJoin(categories, eq(categories.id, requests.categoryId))
      .leftJoin(decider, eq(decider.id, requests.decidedBy))
      .leftJoin(disburser, eq(disburser.id, requests.disbursedBy))
      .where(and(eq(requests.id, id), isNull(requests.deletedAt)));
    if (!row) throw AppError.notFound('Request');
    if (!seesAll(user) && row.requesterId !== user.id) throw AppError.forbidden();

    const events = await db
      .select({
        id: requestEvents.id,
        action: requestEvents.action,
        fromStatus: requestEvents.fromStatus,
        toStatus: requestEvents.toStatus,
        comment: requestEvents.comment,
        createdAt: requestEvents.createdAt,
        actor: { id: users.id, name: users.name },
      })
      .from(requestEvents)
      .innerJoin(users, eq(users.id, requestEvents.actorId))
      .where(eq(requestEvents.requestId, id))
      .orderBy(asc(requestEvents.createdAt), asc(requestEvents.id));

    // Budget impact for approvers (US-CEO-001 AC1, FR-REQ-10).
    let budgetImpact = null;
    if (row.projectId) {
      const usage = await projectBudgetUsage(db, row.projectId);
      const pending = row.status === 'paid' ? 0 : row.amount;
      budgetImpact = {
        ...usage,
        afterApproval: usage.spent + pending,
        exceedsBudget: wouldExceedBudget(usage.budget, usage.spent, pending),
      };
    }

    return { ...row, events, budgetImpact, actions: availableActions(user, row) };
  },

  /** Submit a request; it lands in the Office Administrator's queue (FR-REQ-01..03). */
  async create(user: AuthUser, input: CreateRequestInput) {
    const id = await db.transaction(async (tx) => {
      const exceedsBudget = await checkCostCentre(tx, input, input.amount);
      const reference = await nextReference(tx, 'REQ');
      const [res] = await tx.insert(requests).values({
        reference,
        type: input.type,
        requesterId: user.id,
        amount: input.amount,
        purpose: input.purpose,
        categoryId: input.categoryId ?? null,
        costCentreType: input.costCentreType,
        projectId: input.costCentreType === 'project' ? (input.projectId ?? null) : null,
        neededBy: input.neededBy ?? null,
        status: 'submitted',
        exceedsBudget,
      });
      const requestId = res.insertId;
      await recordEvent(tx, requestId, user.id, 'submitted', null, 'submitted');
      await auditService.log(
        {
          action: 'submit',
          entityType: 'request',
          entityId: requestId,
          newValues: { reference, ...input },
        },
        tx,
      );
      if (input.costCentreType === 'project' && input.projectId) {
        await advanceProjectStatus(
          tx,
          input.projectId,
          'funding_requested',
          user.id,
          `Request ${reference}`,
        );
      }
      // US-OA-001 AC3: in-app and email notification to reviewers.
      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.REQUESTS_REVIEW, tx),
          excludeUserId: user.id,
          type: 'request.submitted',
          title: `New ${input.type} request ${reference}`,
          body: `${user.name} requested ${money(input.amount)}: ${input.purpose}`,
          link: link(requestId),
          entityType: 'request',
          entityId: requestId,
          email: true,
        },
        tx,
      );
      return requestId;
    });
    return this.get(user, id);
  },

  /** Requester corrects a returned request and sends it back to the queue. */
  async resubmit(user: AuthUser, id: number, input: ResubmitRequestInput) {
    await db.transaction(async (tx) => {
      const row = await lockRequest(tx, id);
      assertCan('resubmit', user, row);
      const { comment, ...fields } = input;
      const merged = { ...row, ...fields };
      const exceedsBudget = await checkCostCentre(tx, merged, merged.amount);
      const patch = {
        ...fields,
        projectId: merged.costCentreType === 'project' ? (merged.projectId ?? null) : null,
        exceedsBudget,
        status: 'submitted' as const,
      };
      const changes = diff(row, patch);
      await tx.update(requests).set(patch).where(eq(requests.id, id));
      await recordEvent(tx, id, user.id, 'resubmitted', row.status, 'submitted', comment);
      await auditService.log(
        { action: 'update', entityType: 'request', entityId: id, ...(changes ?? {}) },
        tx,
      );
      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.REQUESTS_REVIEW, tx),
          excludeUserId: user.id,
          type: 'request.resubmitted',
          title: `Request ${row.reference} was corrected and resubmitted`,
          link: link(id),
          entityType: 'request',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** Office Administrator forwards to the Directors (FR-REQ-04, US-OA-002 AC1). */
  async forward(user: AuthUser, id: number, comment?: string) {
    await transition(
      user,
      id,
      'forward',
      comment,
      async (tx, row) => ({
        exceedsBudget: await checkCostCentre(tx, row, row.amount),
      }),
      async (tx, row) => {
        await notificationService.notify(
          {
            userIds: await notificationService.userIdsWithPermission(P.REQUESTS_APPROVE, tx),
            type: 'request.pending_approval',
            title: `Approval needed: ${row.reference}`,
            body: `${money(row.amount)} — ${row.purpose}${row.exceedsBudget ? ' (exceeds project budget)' : ''}`,
            link: link(id),
            entityType: 'request',
            entityId: id,
            email: true,
          },
          tx,
        );
        await notificationService.notify(
          {
            userIds: [row.requesterId],
            type: 'request.status',
            title: `Your request ${row.reference} was forwarded to the Directors`,
            link: link(id),
            entityType: 'request',
            entityId: id,
          },
          tx,
        );
      },
    );
    return this.get(user, id);
  },

  /** Office Administrator returns a request for correction (US-OA-002 AC2). */
  async returnForCorrection(user: AuthUser, id: number, comment: string) {
    await transition(
      user,
      id,
      'return',
      comment,
      async () => ({}),
      async (tx, row) => {
        await notificationService.notify(
          {
            userIds: [row.requesterId],
            type: 'request.returned',
            title: `Request ${row.reference} needs correction`,
            body: comment,
            link: link(id),
            entityType: 'request',
            entityId: id,
            email: true,
          },
          tx,
        );
      },
    );
    return this.get(user, id);
  },

  /** Director approves (FR-REQ-05, US-CEO-001 AC2). */
  async approve(user: AuthUser, id: number, comment?: string) {
    await transition(
      user,
      id,
      'approve',
      comment,
      async () => ({ decidedBy: user.id, decidedAt: new Date(), rejectionReason: null }),
      async (tx, row) => {
        if (row.projectId) {
          await advanceProjectStatus(
            tx,
            row.projectId,
            'funding_approved',
            user.id,
            `Request ${row.reference}`,
          );
        }
        await notificationService.notify(
          {
            userIds: [row.requesterId],
            type: 'request.approved',
            title: `Request ${row.reference} approved`,
            body: `${money(row.amount)} approved by ${user.name}`,
            link: link(id),
            entityType: 'request',
            entityId: id,
            email: true,
          },
          tx,
        );
        await notificationService.notify(
          {
            userIds: await notificationService.userIdsWithPermission(P.REQUESTS_DISBURSE, tx),
            excludeUserId: row.requesterId,
            type: 'request.ready_to_pay',
            title: `Ready to pay: ${row.reference}`,
            body: `${money(row.amount)} — ${row.purpose}`,
            link: link(id),
            entityType: 'request',
            entityId: id,
            email: true,
          },
          tx,
        );
      },
    );
    return this.get(user, id);
  },

  /** Director rejects with a mandatory reason (FR-REQ-05/06, BRL-02). */
  async reject(user: AuthUser, id: number, reason: string) {
    await transition(
      user,
      id,
      'reject',
      reason,
      async () => ({ decidedBy: user.id, decidedAt: new Date(), rejectionReason: reason }),
      async (tx, row) => {
        await notificationService.notify(
          {
            userIds: [
              row.requesterId,
              ...(await notificationService.userIdsWithPermission(P.REQUESTS_REVIEW, tx)),
            ],
            type: 'request.rejected',
            title: `Request ${row.reference} rejected`,
            body: `Reason: ${reason}`,
            link: link(id),
            entityType: 'request',
            entityId: id,
            email: true,
          },
          tx,
        );
      },
    );
    return this.get(user, id);
  },

  async comment(user: AuthUser, id: number, comment: string) {
    await db.transaction(async (tx) => {
      const row = await lockRequest(tx, id);
      assertCan('comment', user, row);
      await recordEvent(tx, id, user.id, 'commented', null, null, comment);
      const recipients =
        user.id === row.requesterId
          ? await notificationService.userIdsWithPermission(P.REQUESTS_REVIEW, tx)
          : [row.requesterId];
      await notificationService.notify(
        {
          userIds: recipients,
          excludeUserId: user.id,
          type: 'request.comment',
          title: `${user.name} commented on ${row.reference}`,
          body: comment,
          link: link(id),
          entityType: 'request',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /**
   * Records the disbursement of an approved request (FR-REQ-07, FR-REQ-08, FR-REQ-11):
   * the request becomes Paid and an expense is posted to its cost centre in the same transaction.
   */
  async disburse(user: AuthUser, id: number, input: DisburseInput) {
    await db.transaction(async (tx) => {
      const row = await lockRequest(tx, id);
      if (row.status !== 'approved') {
        // BRL-01 — explain why (US-OA-003 AC2)
        throw AppError.rule(
          `Only approved requests can be paid. This request is ${row.status.replace('_', ' ')}.`,
        );
      }
      assertCan('pay', user, row);
      if (!input.confirmDuplicate && (await referenceExists(tx, input.paymentReference))) {
        // US-OA-003 AC3: warn of a possible duplicate; the client may confirm and retry.
        throw AppError.conflict(
          `Payment reference "${input.paymentReference}" has already been used`,
          {
            duplicateReference: true,
          },
        );
      }

      const transactionId = await recordTransaction(tx, {
        direction: 'out',
        transactionDate: input.paidOn,
        amount: input.amount,
        categoryId: input.categoryId ?? row.categoryId,
        costCentreType: row.costCentreType,
        projectId: row.projectId,
        paymentMethod: input.paymentMethod,
        reference: input.paymentReference,
        description: `${row.reference}: ${row.purpose}`.slice(0, 1000),
        source: 'request',
        sourceId: row.id,
        recordedBy: user.id,
      });

      const patch = {
        status: 'paid' as const,
        paidAmount: input.amount,
        paidOn: input.paidOn,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        disbursedBy: user.id,
        transactionId,
      };
      await tx.update(requests).set(patch).where(eq(requests.id, id));
      await recordEvent(
        tx,
        id,
        user.id,
        'paid',
        row.status,
        'paid',
        `${money(input.amount)} paid by ${input.paymentMethod.replace('_', ' ')} (ref ${input.paymentReference})`,
      );
      await auditService.log(
        {
          action: 'pay',
          entityType: 'request',
          entityId: id,
          oldValues: { status: row.status },
          newValues: patch,
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.requesterId],
          type: 'request.paid',
          title: `Request ${row.reference} has been paid`,
          body: `${money(input.amount)} paid on ${input.paidOn}`,
          link: link(id),
          entityType: 'request',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** Counts per status for queue badges and dashboards. */
  async statusCounts(user: AuthUser) {
    const rows = await db
      .select({
        status: requests.status,
        n: sql<number>`count(*)`,
        total: sql<string>`SUM(${requests.amount})`,
      })
      .from(requests)
      .where(
        and(
          isNull(requests.deletedAt),
          seesAll(user) ? undefined : eq(requests.requesterId, user.id),
        ),
      )
      .groupBy(requests.status);
    return rows.map((r) => ({
      status: r.status,
      count: Number(r.n),
      amount: Number(r.total ?? 0),
    }));
  },
};
