import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { projects, tasks, users } from '../../../db/schema/index.js';
import type { Priority, TaskStatus } from '../../../db/enums.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface TaskItem {
  id: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  deadline: string | null;
  overdue: boolean;
  project: string | null;
  link: string;
}

export interface TasksSection {
  kpis: Kpi[];
  myTasks: TaskItem[] | null;
  workload: { userId: number; name: string; open: number; overdue: number; link: string }[] | null;
}

const open = and(isNull(tasks.deletedAt), ne(tasks.status, 'done'));

/** FR-TSK-03: my open tasks with overdue highlighted; team overdue for managers (US-BD-001 AC2). */
export const tasksSection: SectionBuilder<TasksSection> = {
  key: 'tasks',
  visible: (ctx) => ctx.canAny(P.TASKS_VIEW_ASSIGNED, P.TASKS_VIEW, P.TASKS_MANAGE),
  async build(ctx) {
    const mine = ctx.can(P.TASKS_VIEW_ASSIGNED);
    const team = ctx.canAny(P.TASKS_VIEW, P.TASKS_MANAGE);
    // Managers without tasks:view see the tasks they created (their team's work).
    const teamScope = ctx.can(P.TASKS_VIEW) ? undefined : eq(tasks.createdBy, ctx.user.id);
    const overdueExpr = sql<number>`SUM(CASE WHEN ${tasks.deadline} < ${ctx.today} THEN 1 ELSE 0 END)`;

    const [myRows, [myCounts], [teamCounts], workloadRows] = await Promise.all([
      mine
        ? db
            .select({
              id: tasks.id,
              title: tasks.title,
              status: tasks.status,
              priority: tasks.priority,
              deadline: tasks.deadline,
              project: projects.name,
            })
            .from(tasks)
            .leftJoin(projects, eq(projects.id, tasks.projectId))
            .where(and(open, eq(tasks.assigneeId, ctx.user.id)))
            // Deadline first (US-TECH-004), undated last.
            .orderBy(sql`${tasks.deadline} IS NULL`, asc(tasks.deadline), desc(tasks.priority))
            .limit(10)
        : [],
      mine
        ? db
            .select({ open: sql<number>`count(*)`, overdue: overdueExpr })
            .from(tasks)
            .where(and(open, eq(tasks.assigneeId, ctx.user.id)))
        : [undefined],
      team
        ? db
            .select({
              open: sql<number>`count(*)`,
              overdue: overdueExpr,
              blocked: sql<number>`SUM(CASE WHEN ${tasks.status} = 'blocked' THEN 1 ELSE 0 END)`,
            })
            .from(tasks)
            .where(and(open, teamScope))
        : [undefined],
      team
        ? db
            .select({
              userId: users.id,
              name: users.name,
              open: sql<number>`count(*)`,
              overdue: overdueExpr,
            })
            .from(tasks)
            .innerJoin(users, eq(users.id, tasks.assigneeId))
            .where(and(open, teamScope))
            .groupBy(users.id, users.name)
            .orderBy(desc(sql`count(*)`))
            .limit(8)
        : [],
    ]);

    const kpis: Kpi[] = [];
    if (myCounts) {
      const overdue = Number(myCounts.overdue ?? 0);
      kpis.push(
        {
          key: 'myOpen',
          label: 'My open tasks',
          value: Number(myCounts.open),
          format: 'number',
          link: '/tasks',
        },
        {
          key: 'myOverdue',
          label: 'My overdue tasks',
          value: overdue,
          format: 'number',
          tone: overdue ? 'red' : 'green',
          link: '/tasks?overdue=true',
        },
      );
    }
    if (teamCounts) {
      const overdue = Number(teamCounts.overdue ?? 0);
      kpis.push({
        key: 'teamOverdue',
        label: 'Team overdue tasks',
        value: overdue,
        format: 'number',
        tone: overdue ? 'red' : 'green',
        hint: `${Number(teamCounts.open)} open · ${Number(teamCounts.blocked ?? 0)} blocked`,
        link: '/tasks?view=all&overdue=true',
      });
    }

    return {
      kpis,
      myTasks: mine
        ? myRows.map((r) => ({
            ...r,
            overdue: Boolean(r.deadline && r.deadline < ctx.today),
            link: `/tasks`,
          }))
        : null,
      workload: team
        ? workloadRows.map((r) => ({
            userId: r.userId,
            name: r.name,
            open: Number(r.open),
            overdue: Number(r.overdue ?? 0),
            link: `/tasks?view=all&assigneeId=${r.userId}`,
          }))
        : null,
    };
  },
};
