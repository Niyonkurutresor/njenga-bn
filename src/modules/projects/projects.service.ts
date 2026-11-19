import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { outerColumn } from '../../common/utils/sql.js';
import { db, type Executor } from '../../db/client.js';
import {
  budgetLines,
  budgets,
  categories,
  customers,
  fieldIssues,
  progressReports,
  projectMembers,
  projectStatusHistory,
  projects,
  requests,
  roles,
  siteVisits,
  tasks,
  transactions,
  users,
  type ProfitLossSnapshot,
} from '../../db/schema/index.js';
import type { ProjectStatus } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { round2, sum, toNumber } from '../../common/utils/money.js';
import { can } from '../../common/middleware/authorize.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { budgetUsage, projectProfit, type BudgetUsage } from '../finance/finance.calc.js';
import { projectBudgetUsage } from '../finance/ledger.js';
import { notificationService } from '../notifications/notifications.service.js';
import { createProjectRecord } from './project-lifecycle.js';
import {
  availableLifecycleActions,
  FINISHED_STATUSES,
  isProjectDelayed,
  projectPercentComplete,
  transitionError,
  type ManualStatus,
} from './projects.rules.js';
import type {
  CreateProjectInput,
  ProfitabilityQuery,
  ProjectListQuery,
  UpdateProjectInput,
} from './projects.schema.js';

type ProjectRow = typeof projects.$inferSelect;

const lead = alias(users, 'lead');
const creator = alias(users, 'creator');

const SORTS = {
  createdAt: projects.createdAt,
  endDate: projects.endDate,
  name: projects.name,
  code: projects.code,
  contractValue: projects.contractValue,
} as const;

const listColumns = {
  id: projects.id,
  code: projects.code,
  name: projects.name,
  clientName: projects.clientName,
  location: projects.location,
  contractValue: projects.contractValue,
  startDate: projects.startDate,
  endDate: projects.endDate,
  status: projects.status,
  completedAt: projects.completedAt,
  createdAt: projects.createdAt,
  customer: { id: customers.id, name: customers.name },
  lead: { id: lead.id, name: lead.name },
};

export function projectLink(id: number) {
  return `/projects/${id}`;
}

function seesAll(user: AuthUser): boolean {
  return can(user, P.PROJECTS_VIEW);
}

/** Project ids the user leads or is a team member of (as a subquery). */
function memberProjectIds(userId: number) {
  return db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
}

/** "Own records only" visibility (projects:view_assigned). */
export function projectVisibility(user: AuthUser): SQL | undefined {
  if (seesAll(user)) return undefined;
  if (can(user, P.PROJECTS_VIEW_ASSIGNED)) {
    return or(eq(projects.projectLeadId, user.id), inArray(projects.id, memberProjectIds(user.id)));
  }
  return sql`FALSE`;
}

/** True when the user leads or belongs to the project's team. */
export async function isTeamMember(
  ex: Executor,
  projectId: number,
  userId: number,
): Promise<boolean> {
  const [row] = await ex
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
        or(
          eq(projects.projectLeadId, userId),
          inArray(
            projects.id,
            ex
              .select({ id: projectMembers.projectId })
              .from(projectMembers)
              .where(
                and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
              ),
          ),
        ),
      ),
    );
  return Boolean(row);
}

/** Lead + team members, for notifications. */
export async function teamUserIds(ex: Executor, projectId: number): Promise<number[]> {
  const [members, [project]] = await Promise.all([
    ex
      .select({ id: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId)),
    ex.select({ leadId: projects.projectLeadId }).from(projects).where(eq(projects.id, projectId)),
  ]);
  const ids = members.map((m) => m.id);
  if (project?.leadId) ids.push(project.leadId);
  return [...new Set(ids)];
}

async function lockProject(tx: Executor, id: number): Promise<ProjectRow> {
  const [row] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Project');
  return row;
}

async function assertActiveUsers(ex: Executor, ids: number[], what: string) {
  if (!ids.length) return;
  const rows = await ex
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'active')));
  if (rows.length !== new Set(ids).size) throw AppError.rule(`${what} must be an active user`);
}

async function customerName(ex: Executor, customerId: number): Promise<string> {
  const [row] = await ex
    .select({ name: customers.name })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
  if (!row) throw AppError.rule('Customer does not exist');
  return row.name;
}

/**
 * Bulk metrics for a set of projects: % complete, budget usage (BRL-04) and profit (BRL-03).
 * Mirrors `projectBudgetUsage` (budgets vs P&L-affecting project outflows) in two grouped
 * queries instead of two per project, so lists stay fast (NFR-01).
 */
export async function projectMetrics(
  ex: Executor,
  rows: readonly { id: number; status: ProjectStatus; contractValue: number }[],
) {
  const ids = rows.map((r) => r.id);
  const result = new Map<
    number,
    {
      percentComplete: number | null;
      budget: BudgetUsage;
      profit: ReturnType<typeof projectProfit>;
      openTasks: number;
    }
  >();
  if (!ids.length) return result;

  const [budgetRows, spentRows, taskRows, verifiedRows] = await Promise.all([
    ex
      .select({ projectId: budgets.projectId, total: sql<string>`SUM(${budgets.amount})` })
      .from(budgets)
      .where(
        and(
          eq(budgets.costCentreType, 'project'),
          inArray(budgets.projectId, ids),
          isNull(budgets.deletedAt),
        ),
      )
      .groupBy(budgets.projectId),
    ex
      .select({
        projectId: transactions.projectId,
        total: sql<string>`SUM(${transactions.amount})`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.projectId, ids),
          eq(transactions.direction, 'out'),
          eq(transactions.affectsPnl, true),
          isNull(transactions.deletedAt),
        ),
      )
      .groupBy(transactions.projectId),
    ex
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)`,
        done: sql<string>`SUM(${tasks.status} = 'done')`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId),
    // Latest verified progress report per project.
    ex
      .select({ projectId: progressReports.projectId, percent: progressReports.percentComplete })
      .from(progressReports)
      .where(
        and(
          inArray(progressReports.projectId, ids),
          eq(progressReports.status, 'verified'),
          eq(
            progressReports.id,
            sql`(SELECT pr2.id FROM progress_reports pr2
                 WHERE pr2.project_id = ${outerColumn(progressReports.projectId)} AND pr2.status = 'verified'
                 ORDER BY pr2.report_date DESC, pr2.id DESC LIMIT 1)`,
          ),
        ),
      ),
  ]);

  const budgetBy = new Map(budgetRows.map((r) => [r.projectId, toNumber(r.total)]));
  const spentBy = new Map(spentRows.map((r) => [r.projectId, toNumber(r.total)]));
  const tasksBy = new Map(
    taskRows.map((r) => [r.projectId, { total: Number(r.total), done: toNumber(r.done) }]),
  );
  const verifiedBy = new Map(verifiedRows.map((r) => [r.projectId, r.percent]));

  for (const row of rows) {
    const t = tasksBy.get(row.id) ?? { total: 0, done: 0 };
    const spent = spentBy.get(row.id) ?? 0;
    result.set(row.id, {
      percentComplete: projectPercentComplete({
        status: row.status,
        latestVerifiedPercent: verifiedBy.get(row.id),
        doneTasks: t.done,
        totalTasks: t.total,
      }),
      budget: budgetUsage(budgetBy.get(row.id) ?? 0, spent),
      profit: projectProfit(row.contractValue, spent),
      openTasks: t.total - t.done,
    });
  }
  return result;
}

/** Budgeted vs actual cost per category (FR-PRJ-08, US-OA-004). */
async function budgetVsActual(
  ex: Executor,
  projectId: number,
): Promise<ProfitLossSnapshot['byCategory']> {
  const [budgetTotalRows, lineRows, actualRows] = await Promise.all([
    ex
      .select({ total: sql<string>`COALESCE(SUM(${budgets.amount}), 0)` })
      .from(budgets)
      .where(
        and(
          eq(budgets.costCentreType, 'project'),
          eq(budgets.projectId, projectId),
          isNull(budgets.deletedAt),
        ),
      ),
    ex
      .select({
        categoryId: budgetLines.categoryId,
        category: categories.name,
        total: sql<string>`SUM(${budgetLines.amount})`,
      })
      .from(budgetLines)
      .innerJoin(budgets, eq(budgets.id, budgetLines.budgetId))
      .innerJoin(categories, eq(categories.id, budgetLines.categoryId))
      .where(
        and(
          eq(budgets.costCentreType, 'project'),
          eq(budgets.projectId, projectId),
          isNull(budgets.deletedAt),
        ),
      )
      .groupBy(budgetLines.categoryId, categories.name),
    ex
      .select({
        categoryId: transactions.categoryId,
        category: categories.name,
        total: sql<string>`SUM(${transactions.amount})`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          eq(transactions.projectId, projectId),
          eq(transactions.direction, 'out'),
          eq(transactions.affectsPnl, true),
          isNull(transactions.deletedAt),
        ),
      )
      .groupBy(transactions.categoryId, categories.name),
  ]);

  const byKey = new Map<string, ProfitLossSnapshot['byCategory'][number]>();
  const entry = (categoryId: number | null, category: string | null) => {
    const key = String(categoryId ?? 'none');
    let e = byKey.get(key);
    if (!e) {
      e = {
        categoryId,
        category: category ?? 'Unallocated / uncategorised',
        budgeted: 0,
        actual: 0,
      };
      byKey.set(key, e);
    }
    return e;
  };
  for (const l of lineRows) entry(l.categoryId, l.category).budgeted += toNumber(l.total);
  for (const a of actualRows) entry(a.categoryId, a.category).actual += toNumber(a.total);

  // Budget not broken down by category is shown as "unallocated".
  const allocated = sum(lineRows.map((l) => toNumber(l.total)));
  const unallocated = round2(toNumber(budgetTotalRows[0]?.total) - allocated);
  if (unallocated > 0) entry(null, null).budgeted += unallocated;

  return [...byKey.values()]
    .map((e) => ({ ...e, budgeted: round2(e.budgeted), actual: round2(e.actual) }))
    .sort((a, b) =>
      a.categoryId === null ? 1 : b.categoryId === null ? -1 : a.category.localeCompare(b.category),
    );
}

async function recordHistory(
  tx: Executor,
  projectId: number,
  from: ProjectStatus,
  to: ProjectStatus,
  changedBy: number,
  note?: string | null,
) {
  await tx.insert(projectStatusHistory).values({
    projectId,
    fromStatus: from,
    toStatus: to,
    changedBy,
    note: note ?? null,
  });
  await auditService.log(
    {
      action: 'status_change',
      entityType: 'project',
      entityId: projectId,
      oldValues: { status: from },
      newValues: { status: to, note: note ?? null },
    },
    tx,
  );
}

async function notifyTeam(
  tx: Executor,
  project: { id: number; code: string; name: string },
  actor: AuthUser,
  type: string,
  title: string,
  body?: string,
  email = false,
) {
  await notificationService.notify(
    {
      userIds: await teamUserIds(tx, project.id),
      excludeUserId: actor.id,
      type,
      title,
      ...(body ? { body } : {}),
      link: projectLink(project.id),
      entityType: 'project',
      entityId: project.id,
      email,
    },
    tx,
  );
}

const STATUS_LABEL: Record<ManualStatus | 'pl_analysed', string> = {
  in_execution: 'is now in execution',
  completed: 'was completed',
  pl_analysed: 'profit/loss analysis is ready',
  closed: 'was closed',
};

export const projectService = {
  async canView(user: AuthUser, id: number): Promise<boolean> {
    if (seesAll(user)) return true;
    if (!can(user, P.PROJECTS_VIEW_ASSIGNED)) return false;
    return isTeamMember(db, id, user.id);
  },

  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    if (!can(user, P.PROJECTS_MANAGE)) return false;
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
    return Boolean(row);
  },

  /** Picker contract used by the request form: `{ id, code, name, status }[]`. */
  async options(user: AuthUser, open?: boolean) {
    const visibility = projectVisibility(user);
    return db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        status: projects.status,
      })
      .from(projects)
      .where(
        and(
          isNull(projects.deletedAt),
          visibility,
          open ? ne(projects.status, 'closed') : undefined,
        ),
      )
      .orderBy(desc(projects.createdAt), desc(projects.id));
  },

  /** Project list with % complete, Delayed flag, budget use and profit (US-BD-003, FR-PRJ-05/06). */
  async list(user: AuthUser, query: ProjectListQuery) {
    const filters: (SQL | undefined)[] = [isNull(projects.deletedAt), projectVisibility(user)];
    if (query.status?.length) filters.push(inArray(projects.status, query.status));
    if (query.open) filters.push(ne(projects.status, 'closed'));
    if (query.delayed !== undefined) {
      const delayed = and(
        isNotNull(projects.endDate),
        lt(projects.endDate, today()),
        notInArray(projects.status, [...FINISHED_STATUSES]),
      )!;
      filters.push(query.delayed ? delayed : sql`NOT (${delayed})`);
    }
    if (query.leadId) filters.push(eq(projects.projectLeadId, query.leadId));
    if (query.customerId) filters.push(eq(projects.customerId, query.customerId));
    if (query.memberId) filters.push(inArray(projects.id, memberProjectIds(query.memberId)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(projects.code, term),
          like(projects.name, term),
          like(projects.clientName, term),
          like(projects.location, term),
        ),
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'createdAt'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(listColumns)
        .from(projects)
        .leftJoin(customers, eq(customers.id, projects.customerId))
        .leftJoin(lead, eq(lead.id, projects.projectLeadId))
        .where(where)
        .orderBy(order, desc(projects.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(projects)
        .where(where),
    ]);

    const metrics = await projectMetrics(db, rows);
    const now = today();
    const data = rows.map((r) => {
      const m = metrics.get(r.id)!;
      return {
        ...r,
        customer: r.customer?.id ? r.customer : null,
        lead: r.lead?.id ? r.lead : null,
        percentComplete: m.percentComplete,
        delayed: isProjectDelayed(r.endDate, r.status, now),
        budget: m.budget,
        profit: m.profit,
        openTasks: m.openTasks,
      };
    });
    return paginated(data, Number(total), query);
  },

  /** Project with team, history, budget vs actual and field activity (FR-PRJ-01..08). */
  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select({
        ...listColumns,
        customerId: projects.customerId,
        projectLeadId: projects.projectLeadId,
        description: projects.description,
        closedAt: projects.closedAt,
        plSnapshot: projects.plSnapshot,
        updatedAt: projects.updatedAt,
        createdBy: { id: creator.id, name: creator.name },
      })
      .from(projects)
      .leftJoin(customers, eq(customers.id, projects.customerId))
      .leftJoin(lead, eq(lead.id, projects.projectLeadId))
      .leftJoin(creator, eq(creator.id, projects.createdBy))
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
    if (!row) throw AppError.notFound('Project');
    if (!(await this.canView(user, id))) throw AppError.forbidden();

    const technician = alias(users, 'technician');
    const visitor = alias(users, 'visitor');
    const raiser = alias(users, 'raiser');
    const changer = alias(users, 'changer');
    const requester = alias(users, 'requester');
    const now = today();

    const [
      team,
      history,
      usage,
      byCategory,
      recentCosts,
      linkedRequests,
      reports,
      visits,
      openIssues,
      taskCounts,
      metrics,
    ] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          phone: users.phone,
          jobTitle: users.jobTitle,
          roleName: roles.name,
          addedAt: projectMembers.createdAt,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(eq(projectMembers.projectId, id))
        .orderBy(asc(users.name)),
      db
        .select({
          id: projectStatusHistory.id,
          fromStatus: projectStatusHistory.fromStatus,
          toStatus: projectStatusHistory.toStatus,
          note: projectStatusHistory.note,
          createdAt: projectStatusHistory.createdAt,
          changedBy: { id: changer.id, name: changer.name },
        })
        .from(projectStatusHistory)
        .leftJoin(changer, eq(changer.id, projectStatusHistory.changedBy))
        .where(eq(projectStatusHistory.projectId, id))
        .orderBy(asc(projectStatusHistory.createdAt), asc(projectStatusHistory.id)),
      projectBudgetUsage(db, id),
      budgetVsActual(db, id),
      db
        .select({
          id: transactions.id,
          transactionDate: transactions.transactionDate,
          amount: transactions.amount,
          description: transactions.description,
          reference: transactions.reference,
          source: transactions.source,
          category: categories.name,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(
          and(
            eq(transactions.projectId, id),
            eq(transactions.direction, 'out'),
            eq(transactions.affectsPnl, true),
            isNull(transactions.deletedAt),
          ),
        )
        .orderBy(desc(transactions.transactionDate), desc(transactions.id))
        .limit(15),
      db
        .select({
          id: requests.id,
          reference: requests.reference,
          type: requests.type,
          amount: requests.amount,
          purpose: requests.purpose,
          status: requests.status,
          createdAt: requests.createdAt,
          requester: { id: requester.id, name: requester.name },
        })
        .from(requests)
        .innerJoin(requester, eq(requester.id, requests.requesterId))
        .where(and(eq(requests.projectId, id), isNull(requests.deletedAt)))
        .orderBy(desc(requests.createdAt))
        .limit(25),
      db
        .select({
          id: progressReports.id,
          reportDate: progressReports.reportDate,
          workCompleted: progressReports.workCompleted,
          percentComplete: progressReports.percentComplete,
          status: progressReports.status,
          createdAt: progressReports.createdAt,
          technician: { id: technician.id, name: technician.name },
        })
        .from(progressReports)
        .innerJoin(technician, eq(technician.id, progressReports.technicianId))
        .where(eq(progressReports.projectId, id))
        .orderBy(desc(progressReports.reportDate), desc(progressReports.id))
        .limit(20),
      db
        .select({
          id: siteVisits.id,
          visitDate: siteVisits.visitDate,
          findings: siteVisits.findings,
          visitedBy: { id: visitor.id, name: visitor.name },
        })
        .from(siteVisits)
        .innerJoin(visitor, eq(visitor.id, siteVisits.visitedBy))
        .where(eq(siteVisits.projectId, id))
        .orderBy(desc(siteVisits.visitDate), desc(siteVisits.id))
        .limit(20),
      db
        .select({
          id: fieldIssues.id,
          title: fieldIssues.title,
          severity: fieldIssues.severity,
          status: fieldIssues.status,
          createdAt: fieldIssues.createdAt,
          raisedBy: { id: raiser.id, name: raiser.name },
        })
        .from(fieldIssues)
        .innerJoin(raiser, eq(raiser.id, fieldIssues.raisedBy))
        .where(and(eq(fieldIssues.projectId, id), eq(fieldIssues.status, 'open')))
        .orderBy(desc(fieldIssues.createdAt)),
      db
        .select({
          total: sql<number>`count(*)`,
          done: sql<string>`COALESCE(SUM(${tasks.status} = 'done'), 0)`,
          overdue: sql<string>`COALESCE(SUM(${tasks.status} <> 'done' AND ${tasks.deadline} < ${now}), 0)`,
        })
        .from(tasks)
        .where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt))),
      projectMetrics(db, [row]),
    ]);

    const leadInTeam = row.lead?.id && team.some((m) => m.id === row.lead?.id);
    const isMember = team.some((m) => m.id === user.id) || row.projectLeadId === user.id;
    const canManage = can(user, P.PROJECTS_MANAGE);
    const t = taskCounts[0];

    return {
      ...row,
      customer: row.customer?.id ? row.customer : null,
      lead: row.lead?.id ? row.lead : null,
      createdBy: row.createdBy?.id ? row.createdBy : null,
      percentComplete: metrics.get(id)?.percentComplete ?? null,
      delayed: isProjectDelayed(row.endDate, row.status, now),
      budget: usage,
      profit: projectProfit(row.contractValue, usage.spent),
      budgetByCategory: byCategory,
      team: team.map((m) => ({ ...m, isLead: m.id === row.projectLeadId })),
      leadInTeam: Boolean(leadInTeam),
      history,
      recentCosts,
      linkedRequests,
      progressReports: reports,
      siteVisits: visits,
      openIssues,
      taskSummary: {
        total: Number(t?.total ?? 0),
        done: toNumber(t?.done),
        overdue: toNumber(t?.overdue),
      },
      permissions: {
        canManage,
        isMember,
        canSubmitReport: isMember && can(user, P.FIELD_REPORTS_SUBMIT) && row.status !== 'closed',
        canRequestFunds:
          can(user, P.REQUESTS_CREATE) && row.status !== 'closed' && (isMember || canManage),
      },
      lifecycleActions: canManage ? availableLifecycleActions(row.status) : [],
    };
  },

  /** FR-PRJ-01 — always through createProjectRecord (shared with CRM lead conversion). */
  async create(user: AuthUser, input: CreateProjectInput) {
    const id = await db.transaction(async (tx) => {
      const { memberIds = [], ...fields } = input;
      if (fields.projectLeadId) await assertActiveUsers(tx, [fields.projectLeadId], 'Project lead');
      await assertActiveUsers(tx, memberIds, 'Each team member');
      let clientName = fields.clientName ?? null;
      if (fields.customerId) {
        const name = await customerName(tx, fields.customerId);
        clientName ||= name;
      }
      const created = await createProjectRecord(tx, { ...fields, clientName }, user.id);

      const extra = [...new Set(memberIds)].filter((m) => m !== fields.projectLeadId);
      if (extra.length) {
        await tx
          .insert(projectMembers)
          .values(extra.map((userId) => ({ projectId: created.id, userId, assignedBy: user.id })));
      }
      // US-BD-001 AC1: team members are notified.
      await notificationService.notify(
        {
          userIds: [...extra, ...(fields.projectLeadId ? [fields.projectLeadId] : [])],
          excludeUserId: user.id,
          type: 'project.assigned',
          title: `You were added to project ${created.code}`,
          body: `${fields.name} — added by ${user.name}`,
          link: projectLink(created.id),
          entityType: 'project',
          entityId: created.id,
          email: true,
        },
        tx,
      );
      return created.id;
    });
    return this.get(user, id);
  },

  async update(user: AuthUser, id: number, input: UpdateProjectInput) {
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      if (row.status === 'closed') throw AppError.rule('A closed project cannot be edited');
      const merged = { ...row, ...input };
      if (merged.startDate && merged.endDate && merged.endDate < merged.startDate) {
        throw AppError.rule('End date must be on or after the start date');
      }
      const patch: Partial<ProjectRow> = { ...input };
      if (input.customerId) {
        const name = await customerName(tx, input.customerId);
        if (!merged.clientName) patch.clientName = name;
      }
      const changes = diff(row, patch);
      if (!changes) return;
      if (input.projectLeadId && input.projectLeadId !== row.projectLeadId) {
        await assertActiveUsers(tx, [input.projectLeadId], 'Project lead');
        if (!(await isTeamMember(tx, id, input.projectLeadId))) {
          await tx
            .insert(projectMembers)
            .values({ projectId: id, userId: input.projectLeadId, assignedBy: user.id });
        }
        await notificationService.notify(
          {
            userIds: [input.projectLeadId],
            excludeUserId: user.id,
            type: 'project.assigned',
            title: `You are now the lead of project ${row.code}`,
            body: row.name,
            link: projectLink(id),
            entityType: 'project',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
      await tx.update(projects).set(patch).where(eq(projects.id, id));
      await auditService.log(
        { action: 'update', entityType: 'project', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** Soft delete (BRL-10) — only a project that has not started spending. */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      if (row.status !== 'created') {
        throw AppError.rule('Only a project that is still in Created status can be deleted');
      }
      const [[tx1], [req1], [field1]] = await Promise.all([
        tx
          .select({ n: sql<number>`count(*)` })
          .from(transactions)
          .where(and(eq(transactions.projectId, id), isNull(transactions.deletedAt))),
        tx
          .select({ n: sql<number>`count(*)` })
          .from(requests)
          .where(and(eq(requests.projectId, id), isNull(requests.deletedAt))),
        tx
          .select({
            n: sql<number>`(SELECT COUNT(*) FROM progress_reports WHERE project_id = ${id})
              + (SELECT COUNT(*) FROM field_issues WHERE project_id = ${id})
              + (SELECT COUNT(*) FROM site_visits WHERE project_id = ${id})`,
          })
          .from(projects)
          .where(eq(projects.id, id)),
      ]);
      if (Number(tx1?.n) > 0 || Number(req1?.n) > 0) {
        throw AppError.rule('This project has requests or transactions and cannot be deleted');
      }
      if (Number(field1?.n) > 0) {
        throw AppError.rule(
          'This project has field reports, issues or site visits and cannot be deleted',
        );
      }
      const deletedAt = new Date();
      await tx.update(projects).set({ deletedAt }).where(eq(projects.id, id));
      // Its tasks go with it so they do not linger in people's task lists.
      await tx
        .update(tasks)
        .set({ deletedAt })
        .where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt)));
      await auditService.log(
        { action: 'delete', entityType: 'project', entityId: id, oldValues: { code: row.code } },
        tx,
      );
    });
  },

  /** FR-PRJ-04, US-BD-001 AC1: add people to the team and notify them. */
  async addMembers(user: AuthUser, id: number, userIds: number[]) {
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      if (row.status === 'closed') throw AppError.rule('A closed project cannot be changed');
      const unique = [...new Set(userIds)];
      await assertActiveUsers(tx, unique, 'Each team member');
      const existing = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), inArray(projectMembers.userId, unique)));
      const added = unique.filter((u) => !existing.some((e) => e.userId === u));
      if (!added.length) return;
      await tx
        .insert(projectMembers)
        .values(added.map((userId) => ({ projectId: id, userId, assignedBy: user.id })));
      await auditService.log(
        {
          action: 'update',
          entityType: 'project',
          entityId: id,
          newValues: { addedMembers: added },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: added,
          excludeUserId: user.id,
          type: 'project.assigned',
          title: `You were added to project ${row.code}`,
          body: `${row.name} — added by ${user.name}`,
          link: projectLink(id),
          entityType: 'project',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  async removeMember(user: AuthUser, id: number, userId: number) {
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      if (row.projectLeadId === userId) {
        throw AppError.rule('Choose another project lead before removing this person');
      }
      const [res] = await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
      if (res.affectedRows === 0) throw AppError.notFound('Team member');
      await auditService.log(
        {
          action: 'update',
          entityType: 'project',
          entityId: id,
          oldValues: { removedMember: userId },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [userId],
          excludeUserId: user.id,
          type: 'project.unassigned',
          title: `You were removed from project ${row.code}`,
          body: row.name,
          entityType: 'project',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /**
   * Manual lifecycle step (FR-PRJ-02/03, BRL-07): start execution, complete or close.
   * Other statuses are reached automatically (budget, first task, request workflow) or through
   * the profit/loss analysis action; `transitionError` explains why.
   */
  async changeStatus(user: AuthUser, id: number, to: ProjectStatus, note?: string) {
    if (to === 'pl_analysed') {
      throw AppError.rule('Use "Produce P/L analysis" to analyse a completed project');
    }
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      const error = transitionError(row.status, to);
      if (error) throw AppError.rule(error);
      const patch: Partial<ProjectRow> = { status: to };
      if (to === 'completed') patch.completedAt = new Date();
      if (to === 'closed') patch.closedAt = new Date();
      await tx.update(projects).set(patch).where(eq(projects.id, id));
      await recordHistory(tx, id, row.status, to, user.id, note);
      await notifyTeam(
        tx,
        row,
        user,
        'project.status',
        `Project ${row.code} ${STATUS_LABEL[to as ManualStatus]}`,
        note ? `${row.name} — ${note}` : row.name,
        to === 'completed' || to === 'closed',
      );
    });
    return this.get(user, id);
  },

  /**
   * FR-PRJ-08: freezes budgeted vs actual cost by category, profit and margin into
   * `plSnapshot` and moves the project to Profit/Loss Analysed (prerequisite of closing, BRL-07).
   * Can be re-run until the project is closed.
   */
  async produceProfitLoss(user: AuthUser, id: number, note?: string) {
    await db.transaction(async (tx) => {
      const row = await lockProject(tx, id);
      const error =
        row.status === 'pl_analysed' ? null : transitionError(row.status, 'pl_analysed');
      if (error) throw AppError.rule(error);
      const [usage, byCategory] = await Promise.all([
        projectBudgetUsage(tx, id),
        budgetVsActual(tx, id),
      ]);
      const profit = projectProfit(row.contractValue, usage.spent);
      const snapshot: ProfitLossSnapshot = {
        contractValue: profit.contractValue,
        budgetTotal: usage.budget,
        actualCost: usage.spent,
        profit: profit.profit,
        marginPct: profit.marginPct,
        byCategory,
        generatedAt: new Date().toISOString(),
      };
      await tx
        .update(projects)
        .set({ plSnapshot: snapshot, status: 'pl_analysed' })
        .where(eq(projects.id, id));
      if (row.status !== 'pl_analysed') {
        await recordHistory(tx, id, row.status, 'pl_analysed', user.id, note ?? 'P/L analysis');
      } else {
        await auditService.log(
          {
            action: 'update',
            entityType: 'project',
            entityId: id,
            newValues: { plSnapshot: snapshot },
          },
          tx,
        );
      }
      await notifyTeam(
        tx,
        row,
        user,
        'project.status',
        `Project ${row.code} ${STATUS_LABEL.pl_analysed}`,
        `Profit RWF ${profit.profit.toLocaleString('en-US')}${profit.marginPct === null ? '' : ` (${profit.marginPct}% margin)`}`,
      );
    });
    return this.get(user, id);
  },

  /** US-BD-001 AC2: each active employee's current projects and open tasks. */
  async workload(search?: string) {
    const now = today();
    const [people, projectCounts, taskCounts] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          jobTitle: users.jobTitle,
          roleCode: roles.code,
          roleName: roles.name,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(
          and(eq(users.status, 'active'), search ? like(users.name, `%${search}%`) : undefined),
        )
        .orderBy(asc(users.name)),
      db
        .select({ userId: projectMembers.userId, n: sql<number>`count(*)` })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(and(isNull(projects.deletedAt), notInArray(projects.status, [...FINISHED_STATUSES])))
        .groupBy(projectMembers.userId),
      db
        .select({
          userId: tasks.assigneeId,
          open: sql<number>`count(*)`,
          overdue: sql<string>`COALESCE(SUM(${tasks.deadline} < ${now}), 0)`,
        })
        .from(tasks)
        .where(and(isNull(tasks.deletedAt), ne(tasks.status, 'done')))
        .groupBy(tasks.assigneeId),
    ]);
    const pBy = new Map(projectCounts.map((r) => [r.userId, Number(r.n)]));
    const tBy = new Map(
      taskCounts.map((r) => [r.userId, { open: Number(r.open), overdue: toNumber(r.overdue) }]),
    );
    return people.map((p) => ({
      ...p,
      currentProjects: pBy.get(p.id) ?? 0,
      openTasks: tBy.get(p.id)?.open ?? 0,
      overdueTasks: tBy.get(p.id)?.overdue ?? 0,
    }));
  },

  /**
   * Project profitability ranked by profit (US-OA-005, US-CEO-004, BRL-03).
   * `from`/`to` select projects whose period (start → end date) overlaps the range;
   * profit always uses all recorded project costs.
   */
  async profitability(query: ProfitabilityQuery) {
    const filters: (SQL | undefined)[] = [isNull(projects.deletedAt)];
    if (query.status?.length) filters.push(inArray(projects.status, query.status));
    if (query.from) filters.push(or(isNull(projects.endDate), gte(projects.endDate, query.from)));
    if (query.to) filters.push(or(isNull(projects.startDate), lte(projects.startDate, query.to)));

    const rows = await db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        clientName: projects.clientName,
        status: projects.status,
        contractValue: projects.contractValue,
        startDate: projects.startDate,
        endDate: projects.endDate,
        completedAt: projects.completedAt,
        hasPlAnalysis: sql<number>`${projects.plSnapshot} IS NOT NULL`,
      })
      .from(projects)
      .where(and(...filters));
    const metrics = await projectMetrics(db, rows);
    const data = rows
      .map((r) => {
        const m = metrics.get(r.id)!;
        return {
          ...r,
          hasPlAnalysis: Boolean(Number(r.hasPlAnalysis)),
          budget: m.budget.budget,
          cost: m.profit.cost,
          profit: m.profit.profit,
          marginPct: m.profit.marginPct,
          budgetUsedPct: m.budget.usedPct,
          budgetLevel: m.budget.level,
        };
      })
      .sort((a, b) => b.profit - a.profit || a.code.localeCompare(b.code));

    const totals = projectProfit(
      sum(data.map((d) => d.contractValue)),
      sum(data.map((d) => d.cost)),
    );
    return {
      projects: data,
      totals: {
        count: data.length,
        contractValue: totals.contractValue,
        budget: sum(data.map((d) => d.budget)),
        cost: totals.cost,
        profit: totals.profit,
        marginPct: totals.marginPct,
        lossMaking: data.filter((d) => d.profit < 0).length,
      },
    };
  },
};
