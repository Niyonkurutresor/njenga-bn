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
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import {
  dailyOpsReports,
  farmReports,
  inspections,
  progressReports,
  projectMembers,
  projects,
  roles,
  tasks,
  users,
} from '../../db/schema/index.js';
import type { TaskStatus } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { can } from '../../common/middleware/authorize.js';
import { monthRange, today, toLocalDate } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { percent } from '../../common/utils/money.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { advanceProjectStatus } from '../projects/project-lifecycle.js';
import type {
  CreateTaskInput,
  PerformanceQuery,
  TaskListQuery,
  UpdateTaskInput,
} from './tasks.schema.js';
import { compareByDeadline, completedOnTime, isTaskOverdue } from './tasks.rules.js';

type TaskRow = typeof tasks.$inferSelect;

const assignee = alias(users, 'assignee');
const creator = alias(users, 'creator');

const columns = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  projectId: tasks.projectId,
  assigneeId: tasks.assigneeId,
  createdById: tasks.createdBy,
  priority: tasks.priority,
  deadline: tasks.deadline,
  status: tasks.status,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  project: { id: projects.id, code: projects.code, name: projects.name, status: projects.status },
  assignee: { id: assignee.id, name: assignee.name },
  createdBy: { id: creator.id, name: creator.name },
};

const PRIORITY_ORDER = sql`FIELD(${tasks.priority}, 'low', 'medium', 'high', 'urgent')`;

const SORTS = {
  deadline: tasks.deadline,
  createdAt: tasks.createdAt,
  priority: PRIORITY_ORDER,
  title: tasks.title,
} as const;

function link(id: number) {
  return `/tasks?taskId=${id}`;
}

/** Managers see every task; others their own (assigned, or created when they can assign). */
function visibility(user: AuthUser): SQL | undefined {
  if (can(user, P.TASKS_VIEW)) return undefined;
  if (can(user, P.TASKS_MANAGE)) {
    return or(eq(tasks.assigneeId, user.id), eq(tasks.createdBy, user.id));
  }
  return eq(tasks.assigneeId, user.id);
}

function canManageTask(user: AuthUser, row: Pick<TaskRow, 'createdBy'>): boolean {
  return can(user, P.TASKS_MANAGE) && (can(user, P.TASKS_VIEW) || row.createdBy === user.id);
}

/** FR-TSK-02: the assignee or a manager updates the status. */
function canUpdateStatus(user: AuthUser, row: Pick<TaskRow, 'createdBy' | 'assigneeId'>) {
  return row.assigneeId === user.id || canManageTask(user, row);
}

function selectTasks() {
  return db
    .select(columns)
    .from(tasks)
    .innerJoin(assignee, eq(assignee.id, tasks.assigneeId))
    .innerJoin(creator, eq(creator.id, tasks.createdBy))
    .leftJoin(projects, eq(projects.id, tasks.projectId));
}

type SelectedTask = Awaited<ReturnType<ReturnType<typeof selectTasks>['execute']>>[number];

function present(user: AuthUser, row: SelectedTask, now = today()) {
  const { createdById, ...rest } = row;
  const ref = { createdBy: createdById, assigneeId: row.assigneeId };
  return {
    ...rest,
    project: row.project?.id ? row.project : null,
    overdue: isTaskOverdue(row.deadline, row.status, now),
    canEdit: canManageTask(user, ref),
    canUpdateStatus: canUpdateStatus(user, ref),
  };
}

async function lockTask(tx: Executor, id: number): Promise<TaskRow> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Task');
  return row;
}

async function assertAssignee(tx: Executor, userId: number) {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active')));
  if (!row) throw AppError.rule('The assignee must be an active user');
}

/**
 * Validates the project and makes sure the assignee is on its team, so a technician given
 * a task can see the project and report on it (FR-PRJ-04, FR-OPS-01).
 */
async function prepareProject(tx: Executor, projectId: number, assigneeId: number, by: number) {
  const [project] = await tx
    .select({ id: projects.id, status: projects.status, leadId: projects.projectLeadId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!project) throw AppError.rule('Project does not exist');
  if (project.status === 'closed') throw AppError.rule('Tasks cannot be added to a closed project');
  if (project.leadId === assigneeId) return;
  const [member] = await tx
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, assigneeId)));
  if (!member) {
    await tx.insert(projectMembers).values({ projectId, userId: assigneeId, assignedBy: by });
  }
}

async function notifyAssignee(
  tx: Executor,
  user: AuthUser,
  task: { id: number; title: string; deadline: string | null | undefined; assigneeId: number },
) {
  await notificationService.notify(
    {
      userIds: [task.assigneeId],
      excludeUserId: user.id,
      type: 'task.assigned',
      title: `New task: ${task.title}`,
      body: `Assigned by ${user.name}${task.deadline ? ` · due ${task.deadline}` : ''}`,
      link: link(task.id),
      entityType: 'task',
      entityId: task.id,
      email: true,
    },
    tx,
  );
}

export const taskService = {
  /** FR-TSK-03: task list with filters (status, assignee, project, overdue, priority). */
  async list(user: AuthUser, query: TaskListQuery) {
    const now = today();
    const filters: (SQL | undefined)[] = [isNull(tasks.deletedAt), visibility(user)];
    if (query.mine) filters.push(eq(tasks.assigneeId, user.id));
    if (query.status?.length) filters.push(inArray(tasks.status, query.status));
    if (query.priority?.length) filters.push(inArray(tasks.priority, query.priority));
    if (query.assigneeId) filters.push(eq(tasks.assigneeId, query.assigneeId));
    if (query.projectId) filters.push(eq(tasks.projectId, query.projectId));
    if (query.overdue !== undefined) {
      const overdue = and(
        isNotNull(tasks.deadline),
        lt(tasks.deadline, now),
        ne(tasks.status, 'done'),
      )!;
      filters.push(query.overdue ? overdue : sql`NOT (${overdue})`);
    }
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(tasks.title, term), like(tasks.description, term), like(assignee.name, term)),
      );
    }
    const where = and(...filters);
    const sortKey = query.sortBy ?? 'deadline';
    const dir = query.sortBy ? query.sortDir : 'asc';
    const order = dir === 'asc' ? asc(SORTS[sortKey]) : desc(SORTS[sortKey]);
    // Tasks without a deadline go last when sorting by deadline.
    const nullsLast = sortKey === 'deadline' ? [sql`${tasks.deadline} IS NULL`] : [];

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      selectTasks()
        .where(where)
        .orderBy(...nullsLast, order, desc(tasks.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(tasks)
        .innerJoin(assignee, eq(assignee.id, tasks.assigneeId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => present(user, r, now)),
      Number(total),
      query,
    );
  },

  /** US-TECH-004: my tasks sorted by deadline with overdue highlighted. */
  async mine(user: AuthUser, includeDone?: boolean) {
    const recent = new Date(Date.now() - 7 * 24 * 3_600_000);
    const rows = await selectTasks().where(
      and(
        isNull(tasks.deletedAt),
        eq(tasks.assigneeId, user.id),
        includeDone
          ? or(ne(tasks.status, 'done'), gte(tasks.completedAt, recent))
          : ne(tasks.status, 'done'),
      ),
    );
    const now = today();
    return rows
      .map((r) => present(user, r, now))
      .sort((a, b) => {
        if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
        return compareByDeadline(a, b);
      });
  },

  async get(user: AuthUser, id: number) {
    const [row] = await selectTasks().where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
    if (!row) throw AppError.notFound('Task');
    const visible =
      can(user, P.TASKS_VIEW) ||
      row.assigneeId === user.id ||
      (can(user, P.TASKS_MANAGE) && row.createdById === user.id);
    if (!visible) throw AppError.forbidden();
    return present(user, row);
  },

  /** FR-TSK-01; the first task on a project moves it to Tasks Assigned (FR-PRJ-02). */
  async create(user: AuthUser, input: CreateTaskInput) {
    const id = await db.transaction(async (tx) => {
      await assertAssignee(tx, input.assigneeId);
      if (input.projectId) await prepareProject(tx, input.projectId, input.assigneeId, user.id);
      const [res] = await tx.insert(tasks).values({
        title: input.title,
        description: input.description ?? null,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId,
        createdBy: user.id,
        priority: input.priority,
        deadline: input.deadline ?? null,
        status: 'not_started',
      });
      const taskId = res.insertId;
      await auditService.log(
        { action: 'create', entityType: 'task', entityId: taskId, newValues: { ...input } },
        tx,
      );
      if (input.projectId) {
        await advanceProjectStatus(
          tx,
          input.projectId,
          'tasks_assigned',
          user.id,
          `Task assigned: ${input.title}`,
        );
      }
      await notifyAssignee(tx, user, {
        id: taskId,
        title: input.title,
        deadline: input.deadline,
        assigneeId: input.assigneeId,
      });
      return taskId;
    });
    return this.get(user, id);
  },

  async update(user: AuthUser, id: number, input: UpdateTaskInput) {
    await db.transaction(async (tx) => {
      const row = await lockTask(tx, id);
      if (!canManageTask(user, row)) throw AppError.forbidden();
      const patch: Partial<TaskRow> = { ...input };
      if (input.status && input.status !== row.status) {
        patch.completedAt = input.status === 'done' ? new Date() : null;
      }
      const assigneeChanged = input.assigneeId && input.assigneeId !== row.assigneeId;
      const projectId = input.projectId === undefined ? row.projectId : input.projectId;
      if (assigneeChanged) await assertAssignee(tx, input.assigneeId!);
      if (projectId && (assigneeChanged || input.projectId)) {
        await prepareProject(tx, projectId, input.assigneeId ?? row.assigneeId, user.id);
      }
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(tasks).set(patch).where(eq(tasks.id, id));
      await auditService.log(
        { action: 'update', entityType: 'task', entityId: id, ...changes },
        tx,
      );
      if (projectId) {
        await advanceProjectStatus(
          tx,
          projectId,
          'tasks_assigned',
          user.id,
          `Task assigned: ${row.title}`,
        );
      }
      if (assigneeChanged) {
        await notifyAssignee(tx, user, {
          id,
          title: input.title ?? row.title,
          deadline: input.deadline === undefined ? row.deadline : input.deadline,
          assigneeId: input.assigneeId!,
        });
      } else if (input.deadline !== undefined && input.deadline !== row.deadline) {
        await notificationService.notify(
          {
            userIds: [row.assigneeId],
            excludeUserId: user.id,
            type: 'task.updated',
            title: `Deadline changed: ${row.title}`,
            body: input.deadline ? `Now due ${input.deadline}` : 'The deadline was removed',
            link: link(id),
            entityType: 'task',
            entityId: id,
          },
          tx,
        );
      }
    });
    return this.get(user, id);
  },

  /** FR-TSK-02: assignee (or a manager) moves the task along; completedAt is set on Done. */
  async setStatus(user: AuthUser, id: number, status: TaskStatus) {
    await db.transaction(async (tx) => {
      const row = await lockTask(tx, id);
      if (!canUpdateStatus(user, row)) throw AppError.forbidden();
      if (row.status === status) return;
      const patch = { status, completedAt: status === 'done' ? new Date() : null };
      await tx.update(tasks).set(patch).where(eq(tasks.id, id));
      await auditService.log(
        {
          action: 'status_change',
          entityType: 'task',
          entityId: id,
          oldValues: { status: row.status },
          newValues: patch,
        },
        tx,
      );
      // Tell whoever assigned it when work finishes or gets stuck.
      if (status === 'done' || status === 'blocked') {
        await notificationService.notify(
          {
            userIds: [row.createdBy],
            excludeUserId: user.id,
            type: `task.${status}`,
            title: `${status === 'done' ? 'Task done' : 'Task blocked'}: ${row.title}`,
            body: `${user.name} marked it ${status}`,
            link: link(id),
            entityType: 'task',
            entityId: id,
          },
          tx,
        );
      }
    });
    return this.get(user, id);
  },

  /** Soft delete (BRL-10). */
  async remove(user: AuthUser, id: number) {
    await db.transaction(async (tx) => {
      const row = await lockTask(tx, id);
      if (!canManageTask(user, row)) throw AppError.forbidden();
      await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'task', entityId: id, oldValues: { title: row.title } },
        tx,
      );
    });
  },

  /**
   * FR-TSK-04, US-BD-005: per employee for a period —
   *  assigned  = tasks created (assigned) in the period,
   *  completed = tasks completed in the period, on time = completed on/before the deadline,
   *  overdue   = currently open tasks past their deadline,
   *  reports   = progress reports + daily operations reports + farm reports + inspections
   *              authored in the period.
   * Defaults to the current month.
   */
  async performance(query: PerformanceQuery) {
    const range = monthRange(today());
    const from = query.from ?? range.from;
    const to = query.to ?? range.to;
    const fromTs = new Date(`${from}T00:00:00Z`);
    const toTs = new Date(`${to}T23:59:59.999Z`);
    const now = today();

    const [people, assigned, completed, overdue, prs, ops, farm, insp] = await Promise.all([
      db
        .select({ id: users.id, name: users.name, roleName: roles.name, jobTitle: users.jobTitle })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(eq(users.status, 'active'))
        .orderBy(asc(users.name)),
      db
        .select({ userId: tasks.assigneeId, n: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(isNull(tasks.deletedAt), gte(tasks.createdAt, fromTs), lte(tasks.createdAt, toTs)),
        )
        .groupBy(tasks.assigneeId),
      db
        .select({
          userId: tasks.assigneeId,
          deadline: tasks.deadline,
          completedAt: tasks.completedAt,
        })
        .from(tasks)
        .where(
          and(
            isNull(tasks.deletedAt),
            eq(tasks.status, 'done'),
            gte(tasks.completedAt, fromTs),
            lte(tasks.completedAt, toTs),
          ),
        ),
      db
        .select({ userId: tasks.assigneeId, n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(isNull(tasks.deletedAt), ne(tasks.status, 'done'), lt(tasks.deadline, now)))
        .groupBy(tasks.assigneeId),
      db
        .select({ userId: progressReports.technicianId, n: sql<number>`count(*)` })
        .from(progressReports)
        .where(and(gte(progressReports.reportDate, from), lte(progressReports.reportDate, to)))
        .groupBy(progressReports.technicianId),
      db
        .select({ userId: dailyOpsReports.submittedBy, n: sql<number>`count(*)` })
        .from(dailyOpsReports)
        .where(and(gte(dailyOpsReports.reportDate, from), lte(dailyOpsReports.reportDate, to)))
        .groupBy(dailyOpsReports.submittedBy),
      db
        .select({ userId: farmReports.submittedBy, n: sql<number>`count(*)` })
        .from(farmReports)
        .where(and(gte(farmReports.reportDate, from), lte(farmReports.reportDate, to)))
        .groupBy(farmReports.submittedBy),
      db
        .select({ userId: inspections.agronomistId, n: sql<number>`count(*)` })
        .from(inspections)
        .where(
          and(
            isNull(inspections.deletedAt),
            gte(inspections.inspectionDate, from),
            lte(inspections.inspectionDate, to),
          ),
        )
        .groupBy(inspections.agronomistId),
    ]);

    const counts = (rows: { userId: number; n: number }[]) =>
      new Map(rows.map((r) => [r.userId, Number(r.n)]));
    const assignedBy = counts(assigned);
    const overdueBy = counts(overdue);
    const reportMaps = [counts(prs), counts(ops), counts(farm), counts(insp)];
    const doneBy = new Map<number, { completed: number; onTime: number }>();
    for (const t of completed) {
      const e = doneBy.get(t.userId) ?? { completed: 0, onTime: 0 };
      e.completed++;
      if (t.completedAt && completedOnTime(t.deadline, toLocalDate(t.completedAt))) e.onTime++;
      doneBy.set(t.userId, e);
    }

    const rows = people.map((p) => {
      const done = doneBy.get(p.id) ?? { completed: 0, onTime: 0 };
      return {
        ...p,
        tasksAssigned: assignedBy.get(p.id) ?? 0,
        tasksCompleted: done.completed,
        completedOnTime: done.onTime,
        onTimeRate: percent(done.onTime, done.completed),
        overdueOpen: overdueBy.get(p.id) ?? 0,
        reportsSubmitted: reportMaps.reduce((acc, m) => acc + (m.get(p.id) ?? 0), 0),
      };
    });
    return { from, to, employees: rows };
  },
};

/** Exposed for other modules (e.g. reminders): ids of users with open tasks on running projects. */
export async function usersWithOpenProjectTasks(ex: Executor = db): Promise<number[]> {
  const rows = await ex
    .selectDistinct({ id: tasks.assigneeId })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        isNull(tasks.deletedAt),
        ne(tasks.status, 'done'),
        isNull(projects.deletedAt),
        eq(projects.status, 'in_execution'),
      ),
    );
  return rows.map((r) => r.id);
}
