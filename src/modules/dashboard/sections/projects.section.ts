import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { db } from '../../../db/client.js';
import { projectMembers, projects } from '../../../db/schema/index.js';
import type { ProjectStatus } from '../../../db/enums.js';
import { toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { budgetUsage, projectProfit, type BudgetLevel } from '../../finance/finance.calc.js';
import {
  FINISHED_PROJECT_STATUSES,
  isProjectDelayed,
  projectPercentComplete,
  rankByProfit,
} from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  status: ProjectStatus;
  endDate: string | null;
  percentComplete: number;
  delayed: boolean;
  budgetLevel: BudgetLevel;
  budgetUsedPct: number | null;
  openIssues: number;
  link: string;
}

export interface ProfitRow {
  id: number;
  code: string;
  name: string;
  contractValue: number;
  cost: number;
  profit: number;
  marginPct: number | null;
  link: string;
}

export interface ProjectsSection {
  scope: 'all' | 'assigned';
  kpis: Kpi[];
  running: ProjectRow[];
  profitability: { top: ProfitRow[]; bottom: ProfitRow[] } | null;
}

/** Projects the user may see: all with projects:view, otherwise member/lead (own records). */
export function projectScope(userId: number, all: boolean): SQL | undefined {
  if (all) return undefined;
  return or(
    eq(projects.projectLeadId, userId),
    inArray(
      projects.id,
      db
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId)),
    ),
  );
}

/**
 * Running, on track vs delayed (FR-PRJ-06), % complete (FR-PRJ-05) and profitability
 * ranking (BRL-03). Technicians see only their assigned projects and no money figures.
 */
export const projectsSection: SectionBuilder<ProjectsSection> = {
  key: 'projects',
  visible: (ctx) => ctx.canAny(P.PROJECTS_VIEW, P.PROJECTS_VIEW_ASSIGNED),
  async build(ctx) {
    const all = ctx.can(P.PROJECTS_VIEW);
    const rows = await db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        status: projects.status,
        endDate: projects.endDate,
        contractValue: projects.contractValue,
        cost: sql<string>`(SELECT COALESCE(SUM(tx.amount), 0) FROM transactions tx
          WHERE tx.project_id = ${outerColumn(projects.id)} AND tx.deleted_at IS NULL
            AND tx.direction = 'out' AND tx.affects_pnl = 1)`,
        budget: sql<string>`(SELECT COALESCE(SUM(b.amount), 0) FROM budgets b
          WHERE b.project_id = ${outerColumn(projects.id)} AND b.cost_centre_type = 'project' AND b.deleted_at IS NULL)`,
        tasksTotal: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.project_id = ${outerColumn(projects.id)} AND tk.deleted_at IS NULL)`,
        tasksDone: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.project_id = ${outerColumn(projects.id)} AND tk.deleted_at IS NULL AND tk.status = 'done')`,
        verifiedPct: sql<number | null>`(SELECT pr.percent_complete FROM progress_reports pr
          WHERE pr.project_id = ${outerColumn(projects.id)} AND pr.status = 'verified'
          ORDER BY pr.report_date DESC, pr.id DESC LIMIT 1)`,
        openIssues: sql<number>`(SELECT COUNT(*) FROM field_issues fi WHERE fi.project_id = ${outerColumn(projects.id)} AND fi.status = 'open')`,
      })
      .from(projects)
      .where(and(isNull(projects.deletedAt), projectScope(ctx.user.id, all)));

    const enriched = rows.map((r) => {
      const usage = budgetUsage(toNumber(r.budget), toNumber(r.cost));
      return {
        ...r,
        finished: FINISHED_PROJECT_STATUSES.includes(r.status),
        delayed: isProjectDelayed(r.endDate, r.status, ctx.today),
        percentComplete: projectPercentComplete(
          Number(r.tasksDone),
          Number(r.tasksTotal),
          r.verifiedPct === null ? null : Number(r.verifiedPct),
        ),
        usage,
        profit: projectProfit(toNumber(r.contractValue), toNumber(r.cost)),
      };
    });

    const active = enriched.filter((r) => !r.finished && r.status !== 'created');
    const delayed = active.filter((r) => r.delayed);
    const inExecution = active.filter((r) => r.status === 'in_execution');
    const avgComplete = active.length
      ? Math.round(active.reduce((a, r) => a + r.percentComplete, 0) / active.length)
      : null;
    const base = all ? '/projects' : '/projects';
    const q = (extra: string) => (all ? `/projects?${extra}` : `/projects?mine=true&${extra}`);

    const kpis: Kpi[] = [
      {
        key: 'running',
        label: all ? 'Running projects' : 'My projects',
        value: active.length,
        format: 'number',
        hint: `${inExecution.length} in execution`,
        link: base,
      },
      {
        key: 'onTrack',
        label: 'On track',
        value: active.length - delayed.length,
        format: 'number',
        tone: 'green',
        link: q('delayed=false'),
      },
      {
        key: 'delayed',
        label: 'Delayed',
        value: delayed.length,
        format: 'number',
        tone: delayed.length ? 'red' : 'green',
        link: q('delayed=true'),
      },
      {
        key: 'complete',
        label: 'Average % complete',
        value: avgComplete,
        format: 'percent',
        link: q('status=in_execution'),
      },
    ];

    const running: ProjectRow[] = active
      .sort(
        (a, b) =>
          Number(b.delayed) - Number(a.delayed) ||
          (a.endDate ?? '9').localeCompare(b.endDate ?? '9'),
      )
      .slice(0, 10)
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        endDate: r.endDate,
        percentComplete: r.percentComplete,
        delayed: r.delayed,
        budgetLevel: r.usage.level,
        budgetUsedPct: r.usage.usedPct,
        openIssues: Number(r.openIssues),
        link: `/projects/${r.id}`,
      }));

    // Money figures only for users who see all projects (managers / directors).
    let profitability: ProjectsSection['profitability'] = null;
    if (all) {
      const withMoney = enriched
        .filter((r) => r.profit.contractValue > 0 || r.profit.cost > 0)
        .map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          ...r.profit,
          link: `/projects/${r.id}`,
        }));
      profitability = rankByProfit(withMoney, 5);
      const lossMaking = withMoney.filter((r) => r.profit < 0).length;
      kpis.push({
        key: 'lossMaking',
        label: 'Loss-making projects',
        value: lossMaking,
        format: 'number',
        tone: lossMaking ? 'red' : 'green',
        link: '/reports/project-financial-summary',
      });
    }

    return { scope: all ? 'all' : 'assigned', kpis, running, profitability };
  },
};
