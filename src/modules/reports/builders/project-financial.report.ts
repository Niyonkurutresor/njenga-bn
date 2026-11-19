import { and, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import {
  budgetLines,
  budgets,
  categories,
  projects,
  transactions,
} from '../../../db/schema/index.js';
import { PROJECT_STATUSES } from '../../../db/enums.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { budgetUsage, projectProfit } from '../../finance/finance.calc.js';
import { computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition, ReportTable } from '../report.types.js';
import { dayBounds, labelOf, optionalId, projectFilter } from './_shared.js';

const filterSchema = z.object({
  projectId: optionalId,
  status: z.enum(PROJECT_STATUSES).optional(),
});
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'code', label: 'Code', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'client', label: 'Client', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'contractValue', label: 'Contract value', type: 'money' },
  { key: 'budget', label: 'Budget', type: 'money' },
  { key: 'actualCost', label: 'Actual cost', type: 'money' },
  { key: 'budgetUsed', label: 'Budget used', type: 'percent' },
  { key: 'profit', label: 'Profit / loss', type: 'money' },
  { key: 'margin', label: 'Margin', type: 'percent' },
];

const categoryColumns: ReportColumn[] = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'budgeted', label: 'Budgeted', type: 'money' },
  { key: 'actual', label: 'Actual', type: 'money' },
  { key: 'variance', label: 'Variance', type: 'money' },
];

/** FR-PRJ-08: budgeted vs actual cost by category for one project. */
async function byCategory(projectId: number, to: string): Promise<ReportTable> {
  const [planned, actual] = await Promise.all([
    db
      .select({
        categoryId: budgetLines.categoryId,
        category: categories.name,
        amount: sql<string>`COALESCE(SUM(${budgetLines.amount}), 0)`,
      })
      .from(budgetLines)
      .innerJoin(budgets, eq(budgets.id, budgetLines.budgetId))
      .innerJoin(categories, eq(categories.id, budgetLines.categoryId))
      .where(and(eq(budgets.projectId, projectId), isNull(budgets.deletedAt)))
      .groupBy(budgetLines.categoryId, categories.name),
    db
      .select({
        categoryId: transactions.categoryId,
        category: categories.name,
        amount: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          eq(transactions.projectId, projectId),
          isNull(transactions.deletedAt),
          eq(transactions.direction, 'out'),
          eq(transactions.affectsPnl, true),
          lte(transactions.transactionDate, to),
        ),
      )
      .groupBy(transactions.categoryId, categories.name),
  ]);
  const map = new Map<string, { category: string; budgeted: number; actual: number }>();
  for (const p of planned) {
    map.set(String(p.categoryId), {
      category: p.category,
      budgeted: toNumber(p.amount),
      actual: 0,
    });
  }
  for (const a of actual) {
    const key = String(a.categoryId);
    const row = map.get(key) ?? { category: a.category ?? 'Uncategorised', budgeted: 0, actual: 0 };
    row.actual = toNumber(a.amount);
    map.set(key, row);
  }
  const rows = [...map.values()].map((r) => ({ ...r, variance: round2(r.budgeted - r.actual) }));
  return {
    key: 'byCategory',
    title: 'Budgeted vs actual cost by category',
    columns: categoryColumns,
    rows,
    totals: computeTotals(categoryColumns, rows),
  };
}

/**
 * Project financial summary (BRD 6, US-OA-005 / US-CEO-004): budget, actual cost, value and
 * profit per project, ranked by profit (losses show in red in the UI). Costs are to the period end.
 */
export const projectFinancialReport: ReportDefinition<Filters> = {
  key: 'project-financial-summary',
  title: 'Project financial summary',
  description: 'Budget, actual cost, contract value and profit/loss per project',
  department: 'projects',
  permissions: [P.REPORTS_PROJECTS, P.REPORTS_FINANCE],
  defaultPeriod: 'month',
  filters: [
    projectFilter,
    {
      key: 'status',
      label: 'Status',
      options: PROJECT_STATUSES.map((s) => ({ value: s, label: labelOf(s) })),
    },
  ],
  filterSchema,
  async build({ from, to, filters }) {
    const [start, end] = dayBounds(from, to);
    const where: SQL[] = [isNull(projects.deletedAt), lte(projects.createdAt, end)];
    if (filters.projectId) where.push(eq(projects.id, filters.projectId));
    if (filters.status) where.push(eq(projects.status, filters.status));
    // Projects that were not closed before the period started.
    where.push(or(isNull(projects.closedAt), gte(projects.closedAt, start))!);

    const rowsDb = await db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        client: projects.clientName,
        status: projects.status,
        contractValue: projects.contractValue,
        budget: sql<string>`(SELECT COALESCE(SUM(b.amount), 0) FROM budgets b
          WHERE b.project_id = ${outerColumn(projects.id)} AND b.cost_centre_type = 'project' AND b.deleted_at IS NULL)`,
        cost: sql<string>`(SELECT COALESCE(SUM(tx.amount), 0) FROM transactions tx
          WHERE tx.project_id = ${outerColumn(projects.id)} AND tx.deleted_at IS NULL AND tx.direction = 'out'
            AND tx.affects_pnl = 1 AND tx.transaction_date <= ${to})`,
      })
      .from(projects)
      .where(and(...where));

    const rows = rowsDb
      .map((r) => {
        const pr = projectProfit(toNumber(r.contractValue), toNumber(r.cost));
        const usage = budgetUsage(toNumber(r.budget), pr.cost);
        return {
          code: r.code,
          project: r.name,
          client: r.client,
          status: labelOf(r.status),
          contractValue: pr.contractValue,
          budget: usage.budget,
          actualCost: pr.cost,
          budgetUsed: usage.usedPct,
          profit: pr.profit,
          margin: pr.marginPct,
        };
      })
      .sort((a, b) => b.profit - a.profit);

    const totals = computeTotals(columns, rows);
    const profit = Number(totals?.profit ?? 0);
    const value = Number(totals?.contractValue ?? 0);
    const sections = filters.projectId ? [await byCategory(filters.projectId, to)] : [];

    return {
      columns,
      rows,
      totals: totals && {
        ...totals,
        margin: value ? Math.round((profit / value) * 1000) / 10 : null,
      },
      summary: [
        { label: 'Projects', value: rows.length, type: 'number' },
        { label: 'Total contract value', value, type: 'money' },
        { label: 'Total actual cost', value: Number(totals?.actualCost ?? 0), type: 'money' },
        { label: 'Total profit / loss', value: profit, type: 'money' },
        {
          label: 'Loss-making projects',
          value: rows.filter((r) => r.profit < 0).length,
          type: 'number',
        },
        {
          label: 'Over budget',
          value: rows.filter((r) => (r.budgetUsed ?? 0) >= 100).length,
          type: 'number',
        },
      ],
      sections,
    };
  },
};
