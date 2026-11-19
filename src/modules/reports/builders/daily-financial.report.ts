import { and, asc, between, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { categories, projects, requests, transactions, users } from '../../../db/schema/index.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { computeTotals, clip } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { cashAmt, centreLabel, costAmt, incomeAmt, labelOf, noFilters } from './_shared.js';

const t = transactions;
const PENDING = ['submitted', 'pending_approval', 'approved'] as const;

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'reference', label: 'Reference', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'costCentre', label: 'Cost centre', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'method', label: 'Method', type: 'text' },
  { key: 'moneyIn', label: 'Money in', type: 'money' },
  { key: 'moneyOut', label: 'Money out', type: 'money' },
];

const pendingColumns: ReportColumn[] = [
  { key: 'reference', label: 'Reference', type: 'text' },
  { key: 'requester', label: 'Requester', type: 'text' },
  { key: 'purpose', label: 'Purpose', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'submitted', label: 'Submitted', type: 'date' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

/** Daily financial report (BRD 6, FR-RPT-02): payments, expenses, cash position, pending requests. */
export const dailyFinancialReport: ReportDefinition = {
  key: 'daily-financial',
  title: 'Daily financial report',
  description: 'Payments, income and expenses for the day, cash position and pending requests',
  department: 'finance',
  permissions: [P.REPORTS_FINANCE],
  defaultPeriod: 'day',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    const [txRows, [totals], [cash], pending] = await Promise.all([
      db
        .select({
          date: t.transactionDate,
          reference: t.reference,
          direction: t.direction,
          source: t.source,
          affectsPnl: t.affectsPnl,
          category: categories.name,
          costCentreType: t.costCentreType,
          projectCode: projects.code,
          projectName: projects.name,
          description: t.description,
          method: t.paymentMethod,
          amount: t.amount,
        })
        .from(t)
        .leftJoin(categories, eq(categories.id, t.categoryId))
        .leftJoin(projects, eq(projects.id, t.projectId))
        .where(and(isNull(t.deletedAt), between(t.transactionDate, from, to)))
        .orderBy(asc(t.transactionDate), asc(t.id)),
      db
        .select({
          income: sql<string>`COALESCE(SUM(${incomeAmt}), 0)`,
          expenses: sql<string>`COALESCE(SUM(${costAmt}), 0)`,
          cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${t.affectsCash} = 1 AND ${t.direction} = 'in' THEN ${t.amount} ELSE 0 END), 0)`,
          cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${t.affectsCash} = 1 AND ${t.direction} = 'out' THEN ${t.amount} ELSE 0 END), 0)`,
        })
        .from(t)
        .where(and(isNull(t.deletedAt), between(t.transactionDate, from, to))),
      db
        .select({ balance: sql<string>`COALESCE(SUM(${cashAmt}), 0)` })
        .from(t)
        .where(and(isNull(t.deletedAt), lte(t.transactionDate, to))),
      db
        .select({
          reference: requests.reference,
          requester: users.name,
          purpose: requests.purpose,
          status: requests.status,
          createdAt: requests.createdAt,
          amount: requests.amount,
        })
        .from(requests)
        .innerJoin(users, eq(users.id, requests.requesterId))
        .where(and(isNull(requests.deletedAt), inArray(requests.status, [...PENDING])))
        .orderBy(asc(requests.createdAt)),
    ]);

    const rows = txRows.map((r) => ({
      date: r.date,
      reference: r.reference,
      type:
        r.direction === 'in'
          ? 'Income'
          : r.affectsPnl
            ? 'Expense / payment'
            : `Payment (${labelOf(r.source)})`,
      category: r.category,
      costCentre: centreLabel(r.costCentreType, r.projectCode, r.projectName),
      description: clip(r.description, 160),
      method: r.method ? labelOf(r.method) : null,
      moneyIn: r.direction === 'in' ? toNumber(r.amount) : null,
      moneyOut: r.direction === 'out' ? toNumber(r.amount) : null,
    }));

    const pendingRows = pending.map((r) => ({
      reference: r.reference,
      requester: r.requester,
      purpose: clip(r.purpose, 160),
      status: labelOf(r.status),
      submitted: r.createdAt.toISOString().slice(0, 10),
      amount: toNumber(r.amount),
    }));
    const pendingTotal = round2(pendingRows.reduce((a, r) => a + r.amount, 0));
    const cashIn = toNumber(totals?.cashIn);
    const cashOut = toNumber(totals?.cashOut);

    return {
      columns,
      rows,
      totals: computeTotals(columns, rows),
      summary: [
        { label: 'Payments made', value: cashOut, type: 'money' },
        { label: 'Money received', value: cashIn, type: 'money' },
        { label: 'Income (P&L)', value: toNumber(totals?.income), type: 'money' },
        { label: 'Expenses (P&L)', value: toNumber(totals?.expenses), type: 'money' },
        { label: 'Net cash movement', value: round2(cashIn - cashOut), type: 'money' },
        { label: 'Cash position (closing)', value: toNumber(cash?.balance), type: 'money' },
        { label: 'Pending requests', value: pendingRows.length, type: 'number' },
        { label: 'Pending requests value', value: pendingTotal, type: 'money' },
      ],
      sections: [
        {
          key: 'pending',
          title: 'Pending requests',
          columns: pendingColumns,
          rows: pendingRows,
          totals: computeTotals(pendingColumns, pendingRows),
        },
      ],
    };
  },
};
