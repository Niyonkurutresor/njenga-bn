import { and, between, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { categories, projects, transactions } from '../../../db/schema/index.js';
import { percent, round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition, ReportRow } from '../report.types.js';
import { centreLabel, costAmt, incomeAmt, noFilters } from './_shared.js';

const t = transactions;

const columns: ReportColumn[] = [
  { key: 'area', label: 'Area', type: 'text' },
  { key: 'income', label: 'Income', type: 'money' },
  { key: 'costs', label: 'Costs', type: 'money' },
  { key: 'profit', label: 'Profit / loss', type: 'money' },
  { key: 'margin', label: 'Margin', type: 'percent' },
];

const categoryColumns: ReportColumn[] = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'kind', label: 'Kind', type: 'text' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

/** P&L row with BRL-03-style profit and margin. */
export function pnlRow(
  area: string,
  income: number,
  costs: number,
): { area: string; income: number; costs: number; profit: number; margin: number | null } {
  const profit = round2(income - costs);
  return {
    area,
    income: round2(income),
    costs: round2(costs),
    profit,
    margin: percent(profit, income),
  };
}

/** Profit & loss statement (FR-FIN-08, BRD 6): company and each area (projects, farm, office). */
export const profitLossReport: ReportDefinition = {
  key: 'profit-loss',
  title: 'Profit & loss statement',
  description: 'Income, costs and profit for the company and each area',
  department: 'finance',
  permissions: [P.REPORTS_FINANCE],
  defaultPeriod: 'month',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    const where = and(
      isNull(t.deletedAt),
      eq(t.affectsPnl, true),
      between(t.transactionDate, from, to),
    );
    const income = sql<string>`COALESCE(SUM(${incomeAmt}), 0)`;
    const costs = sql<string>`COALESCE(SUM(${costAmt}), 0)`;
    const [areas, byCategory] = await Promise.all([
      db
        .select({
          costCentreType: t.costCentreType,
          projectCode: projects.code,
          projectName: projects.name,
          income,
          costs,
        })
        .from(t)
        .leftJoin(projects, eq(projects.id, t.projectId))
        .where(where)
        .groupBy(t.costCentreType, projects.code, projects.name)
        .orderBy(t.costCentreType, projects.code),
      db
        .select({
          category: categories.name,
          direction: t.direction,
          amount: sql<string>`COALESCE(SUM(${t.amount}), 0)`,
        })
        .from(t)
        .leftJoin(categories, eq(categories.id, t.categoryId))
        .where(where)
        .groupBy(categories.name, t.direction)
        .orderBy(t.direction, desc(sql`SUM(${t.amount})`)),
    ]);

    const rows = areas.map((a) =>
      pnlRow(
        centreLabel(a.costCentreType, a.projectCode, a.projectName),
        toNumber(a.income),
        toNumber(a.costs),
      ),
    );
    const totalIncome = round2(rows.reduce((s, r) => s + Number(r.income), 0));
    const totalCosts = round2(rows.reduce((s, r) => s + Number(r.costs), 0));
    const company = pnlRow('Company total', totalIncome, totalCosts);
    const projectRows = rows.filter((_, i) => areas[i]!.costCentreType === 'project');
    const sumOf = (list: ReportRow[], k: string) =>
      round2(list.reduce((s, r) => s + Number(r[k]), 0));

    const catRows = byCategory.map((c) => ({
      category: c.category ?? 'Uncategorised',
      kind: c.direction === 'in' ? 'Income' : 'Cost',
      amount: toNumber(c.amount),
    }));

    return {
      columns,
      rows,
      totals: company,
      summary: [
        { label: 'Total income', value: totalIncome, type: 'money' },
        { label: 'Total costs', value: totalCosts, type: 'money' },
        { label: 'Net profit / loss', value: company.profit, type: 'money' },
        { label: 'Margin', value: company.margin, type: 'percent' },
        { label: 'Projects profit', value: sumOf(projectRows, 'profit'), type: 'money' },
        {
          label: 'Farm profit',
          value: rows.find((_, i) => areas[i]!.costCentreType === 'farm')?.profit ?? 0,
          type: 'money',
        },
        {
          label: 'Office costs',
          value: rows.find((_, i) => areas[i]!.costCentreType === 'office')?.costs ?? 0,
          type: 'money',
        },
      ],
      sections: [
        {
          key: 'categories',
          title: 'By category',
          columns: categoryColumns,
          rows: catRows,
          totals: computeTotals(categoryColumns, catRows, []),
        },
      ],
    };
  },
};
