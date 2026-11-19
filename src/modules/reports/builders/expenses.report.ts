import { and, asc, between, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import { categories, projects, transactions } from '../../../db/schema/index.js';
import { COST_CENTRE_TYPES } from '../../../db/enums.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { clip, computeTotals, share } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { centreLabel, costCentreFilter, labelOf, optionalId, projectFilter } from './_shared.js';

const t = transactions;

const filterSchema = z.object({
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: optionalId,
  categoryId: optionalId,
});
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'costCentre', label: 'Cost centre', type: 'text' },
  { key: 'count', label: 'Payments', type: 'number' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'share', label: 'Share', type: 'percent' },
];

const detailColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'reference', label: 'Reference', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'costCentre', label: 'Cost centre', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

/** Expense report (BRD 6): expenses by category, project, farm and office for any period. */
export const expensesReport: ReportDefinition<Filters> = {
  key: 'expenses',
  title: 'Expense report',
  description: 'Expenses by category and cost centre (project, farm, office)',
  department: 'finance',
  permissions: [P.REPORTS_FINANCE],
  defaultPeriod: 'month',
  filters: [
    costCentreFilter,
    projectFilter,
    { key: 'categoryId', label: 'Category', source: 'categories' },
  ],
  filterSchema,
  async build({ from, to, filters }) {
    const where: SQL[] = [
      isNull(t.deletedAt),
      eq(t.direction, 'out'),
      eq(t.affectsPnl, true),
      between(t.transactionDate, from, to),
    ];
    if (filters.costCentreType) where.push(eq(t.costCentreType, filters.costCentreType));
    if (filters.projectId) where.push(eq(t.projectId, filters.projectId));
    if (filters.categoryId) where.push(eq(t.categoryId, filters.categoryId));
    const cond = and(...where);
    const total = sql<string>`COALESCE(SUM(${t.amount}), 0)`;

    const [grouped, byCentre, detail] = await Promise.all([
      db
        .select({
          category: categories.name,
          costCentreType: t.costCentreType,
          projectCode: projects.code,
          projectName: projects.name,
          n: sql<number>`count(*)`,
          amount: total,
        })
        .from(t)
        .leftJoin(categories, eq(categories.id, t.categoryId))
        .leftJoin(projects, eq(projects.id, t.projectId))
        .where(cond)
        .groupBy(categories.name, t.costCentreType, projects.code, projects.name)
        .orderBy(desc(total)),
      db
        .select({ costCentreType: t.costCentreType, amount: total })
        .from(t)
        .where(cond)
        .groupBy(t.costCentreType),
      db
        .select({
          date: t.transactionDate,
          reference: t.reference,
          category: categories.name,
          costCentreType: t.costCentreType,
          projectCode: projects.code,
          projectName: projects.name,
          description: t.description,
          amount: t.amount,
        })
        .from(t)
        .leftJoin(categories, eq(categories.id, t.categoryId))
        .leftJoin(projects, eq(projects.id, t.projectId))
        .where(cond)
        .orderBy(asc(t.transactionDate), asc(t.id))
        .limit(5000),
    ]);

    const grand = round2(grouped.reduce((a, r) => a + toNumber(r.amount), 0));
    const rows = grouped.map((r) => ({
      category: r.category ?? 'Uncategorised',
      costCentre: centreLabel(r.costCentreType, r.projectCode, r.projectName),
      count: Number(r.n),
      amount: toNumber(r.amount),
      share: share(toNumber(r.amount), grand),
    }));
    const centre = (c: string) => toNumber(byCentre.find((r) => r.costCentreType === c)?.amount);
    const detailRows = detail.map((r) => ({
      date: r.date,
      reference: r.reference,
      category: r.category ?? 'Uncategorised',
      costCentre: centreLabel(r.costCentreType, r.projectCode, r.projectName),
      description: clip(r.description, 160),
      amount: toNumber(r.amount),
    }));

    return {
      columns,
      rows,
      totals: computeTotals(columns, rows, ['count', 'amount']),
      summary: [
        { label: 'Total expenses', value: grand, type: 'money' },
        ...COST_CENTRE_TYPES.map((c) => ({
          label: `${labelOf(c)} expenses`,
          value: centre(c),
          type: 'money' as const,
        })),
        { label: 'Payments', value: detailRows.length, type: 'number' },
      ],
      sections: [
        {
          key: 'detail',
          title: 'Expense transactions',
          columns: detailColumns,
          rows: detailRows,
          totals: computeTotals(detailColumns, detailRows),
        },
      ],
    };
  },
};
