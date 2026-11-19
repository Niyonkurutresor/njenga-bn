import { and, asc, eq, sql } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import { roles, users } from '../../../db/schema/index.js';
import { percent } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { dayBounds, optionalId } from './_shared.js';

const filterSchema = z.object({ userId: optionalId });
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'employee', label: 'Employee', type: 'text' },
  { key: 'role', label: 'Role', type: 'text' },
  { key: 'assigned', label: 'Tasks assigned', type: 'number' },
  { key: 'completed', label: 'Tasks completed', type: 'number' },
  { key: 'onTime', label: 'Completed on time', type: 'number' },
  { key: 'onTimePct', label: 'Deadlines met', type: 'percent' },
  { key: 'overdue', label: 'Overdue open', type: 'number' },
  { key: 'reports', label: 'Reports submitted', type: 'number' },
];

/** Deadlines met (%) = completed on time ÷ completed; null when nothing was completed. */
export function deadlinesMetPct(onTime: number, completed: number): number | null {
  return percent(onTime, completed);
}

/**
 * Employee performance (BRD 6, FR-TSK-04, US-BD-005): tasks completed, completed on time,
 * reports submitted (progress, farm, operations, inspections) per employee for the period.
 */
export const employeePerformanceReport: ReportDefinition<Filters> = {
  key: 'employee-performance',
  title: 'Employee performance report',
  description: 'Tasks completed, deadlines met and reports submitted per employee',
  department: 'business',
  permissions: [P.REPORTS_BUSINESS],
  defaultPeriod: 'month',
  filters: [{ key: 'userId', label: 'Employee', source: 'users' }],
  filterSchema,
  async build({ from, to, filters }) {
    const [start, end] = dayBounds(from, to);
    const rowsDb = await db
      .select({
        employee: users.name,
        role: roles.name,
        assigned: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = ${outerColumn(users.id)}
          AND tk.deleted_at IS NULL AND tk.created_at BETWEEN ${start} AND ${end})`,
        completed: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = ${outerColumn(users.id)}
          AND tk.deleted_at IS NULL AND tk.status = 'done' AND tk.completed_at BETWEEN ${start} AND ${end})`,
        onTime: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = ${outerColumn(users.id)}
          AND tk.deleted_at IS NULL AND tk.status = 'done' AND tk.completed_at BETWEEN ${start} AND ${end}
          AND (tk.deadline IS NULL OR DATE(tk.completed_at) <= tk.deadline))`,
        overdue: sql<number>`(SELECT COUNT(*) FROM tasks tk WHERE tk.assignee_id = ${outerColumn(users.id)}
          AND tk.deleted_at IS NULL AND tk.status <> 'done' AND tk.deadline < ${to})`,
        reports: sql<number>`(
          (SELECT COUNT(*) FROM progress_reports pr WHERE pr.technician_id = ${outerColumn(users.id)} AND pr.report_date BETWEEN ${from} AND ${to})
          + (SELECT COUNT(*) FROM farm_reports fr WHERE fr.submitted_by = ${outerColumn(users.id)} AND fr.report_date BETWEEN ${from} AND ${to})
          + (SELECT COUNT(*) FROM daily_ops_reports dr WHERE dr.submitted_by = ${outerColumn(users.id)} AND dr.report_date BETWEEN ${from} AND ${to})
          + (SELECT COUNT(*) FROM inspections ins WHERE ins.agronomist_id = ${outerColumn(users.id)} AND ins.deleted_at IS NULL AND ins.inspection_date BETWEEN ${from} AND ${to}))`,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(eq(users.status, 'active'), filters.userId ? eq(users.id, filters.userId) : undefined),
      )
      .orderBy(asc(users.name));

    const rows = rowsDb
      .map((r) => {
        const completed = Number(r.completed);
        const onTime = Number(r.onTime);
        return {
          employee: r.employee,
          role: r.role,
          assigned: Number(r.assigned),
          completed,
          onTime,
          onTimePct: deadlinesMetPct(onTime, completed),
          overdue: Number(r.overdue),
          reports: Number(r.reports),
        };
      })
      // Only people with something to report on (unless one employee was asked for).
      .filter((r) => filters.userId || r.assigned + r.completed + r.overdue + r.reports > 0);

    const totals = computeTotals(columns, rows, [
      'assigned',
      'completed',
      'onTime',
      'overdue',
      'reports',
    ]);
    const completed = Number(totals?.completed ?? 0);
    const onTime = Number(totals?.onTime ?? 0);

    return {
      columns,
      rows,
      totals: totals && { ...totals, onTimePct: deadlinesMetPct(onTime, completed) },
      summary: [
        { label: 'Employees', value: rows.length, type: 'number' },
        { label: 'Tasks completed', value: completed, type: 'number' },
        { label: 'Deadlines met', value: deadlinesMetPct(onTime, completed), type: 'percent' },
        { label: 'Overdue open tasks', value: Number(totals?.overdue ?? 0), type: 'number' },
        { label: 'Reports submitted', value: Number(totals?.reports ?? 0), type: 'number' },
      ],
    };
  },
};
