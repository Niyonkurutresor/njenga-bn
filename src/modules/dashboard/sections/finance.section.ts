import { and, between, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { db } from '../../../db/client.js';
import { budgets, loans, projects, transactions } from '../../../db/schema/index.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { budgetUsage, loanBalance, type BudgetLevel } from '../../finance/finance.calc.js';
import { fillMonthly, lastMonths, linkTo, monthOf } from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

const t = transactions;
const live = isNull(t.deletedAt);
/** P&L income / costs (FR-FIN-08): only rows that affect profit and loss. */
const incomeAmt = sql`CASE WHEN ${t.direction} = 'in' AND ${t.affectsPnl} = 1 THEN ${t.amount} ELSE 0 END`;
const costAmt = sql`CASE WHEN ${t.direction} = 'out' AND ${t.affectsPnl} = 1 THEN ${t.amount} ELSE 0 END`;
/** Cash movement (FR-FIN-09): only rows where money actually moved. */
const cashAmt = sql`CASE WHEN ${t.affectsCash} = 1 THEN (CASE WHEN ${t.direction} = 'in' THEN ${t.amount} ELSE -${t.amount} END) ELSE 0 END`;

export interface BudgetAlert {
  id: number;
  name: string;
  costCentreType: string;
  projectId: number | null;
  budget: number;
  spent: number;
  usedPct: number | null;
  level: BudgetLevel;
  link: string;
}

export interface FinanceSection {
  kpis: Kpi[];
  monthly: { month: string; income: number; expenses: number }[];
  expensesByCostCentre: { costCentreType: string; amount: number; link: string }[];
  budgetAlerts: BudgetAlert[];
}

/** Budgets whose period overlaps the dashboard period, with BRL-04 usage. */
async function budgetsInUse(from: string, to: string): Promise<BudgetAlert[]> {
  const b = budgets;
  // Correlated subquery: project budgets count all project costs; farm/office budgets only
  // the costs inside their own period.
  const spent = sql<string>`(SELECT COALESCE(SUM(tx.amount), 0) FROM transactions tx
    WHERE tx.deleted_at IS NULL AND tx.direction = 'out' AND tx.affects_pnl = 1
      AND tx.cost_centre_type = ${b.costCentreType}
      AND (${b.costCentreType} <> 'project' OR tx.project_id = ${b.projectId})
      AND (${b.costCentreType} = 'project' OR ${b.periodStart} IS NULL OR tx.transaction_date >= ${b.periodStart})
      AND (${b.costCentreType} = 'project' OR ${b.periodEnd} IS NULL OR tx.transaction_date <= ${b.periodEnd}))`;
  const rows = await db
    .select({
      id: b.id,
      name: b.name,
      costCentreType: b.costCentreType,
      projectId: b.projectId,
      projectName: projects.name,
      projectStatus: projects.status,
      amount: b.amount,
      spent,
    })
    .from(b)
    .leftJoin(projects, eq(projects.id, b.projectId))
    .where(
      and(
        isNull(b.deletedAt),
        or(isNull(b.periodStart), lte(b.periodStart, to)),
        or(isNull(b.periodEnd), gte(b.periodEnd, from)),
      ),
    );

  // Several budgets for one project are summed, matching projectBudgetUsage() in the ledger.
  const merged = new Map<string, BudgetAlert>();
  for (const r of rows) {
    if (r.costCentreType === 'project' && r.projectStatus === 'closed') continue;
    const key = r.costCentreType === 'project' ? `p${r.projectId}` : `b${r.id}`;
    const prev = merged.get(key);
    const amount = (prev?.budget ?? 0) + toNumber(r.amount);
    const usage = budgetUsage(amount, toNumber(r.spent));
    merged.set(key, {
      id: r.id,
      name: r.costCentreType === 'project' ? (r.projectName ?? r.name) : r.name,
      costCentreType: r.costCentreType,
      projectId: r.projectId,
      budget: usage.budget,
      spent: usage.spent,
      usedPct: usage.usedPct,
      level: usage.level,
      link: r.projectId ? `/projects/${r.projectId}` : `/finance/budgets/${r.id}`,
    });
  }
  return [...merged.values()].sort((a, b2) => (b2.usedPct ?? 0) - (a.usedPct ?? 0));
}

/** FR-DSH-02/04: revenue, expenses, profit, cash position, budget use, loans, 12-month trend. */
export const financeSection: SectionBuilder<FinanceSection> = {
  key: 'finance',
  visible: (ctx) => ctx.can(P.FINANCE_VIEW),
  async build({ period, today }) {
    const months = lastMonths(period.to, 12);
    const firstMonth = `${months[0]}-01`;
    const monthExpr = sql<string>`DATE_FORMAT(${t.transactionDate}, '%Y-%m')`;

    const [[totals], [cash], monthlyRows, byCentre, budgetRows, loanRows] = await Promise.all([
      db
        .select({
          income: sql<string>`COALESCE(SUM(${incomeAmt}), 0)`,
          expenses: sql<string>`COALESCE(SUM(${costAmt}), 0)`,
        })
        .from(t)
        .where(and(live, between(t.transactionDate, period.from, period.to))),
      db
        .select({ balance: sql<string>`COALESCE(SUM(${cashAmt}), 0)` })
        .from(t)
        .where(and(live, lte(t.transactionDate, today))),
      db
        .select({
          month: monthExpr,
          income: sql<string>`COALESCE(SUM(${incomeAmt}), 0)`,
          expenses: sql<string>`COALESCE(SUM(${costAmt}), 0)`,
        })
        .from(t)
        .where(and(live, between(t.transactionDate, firstMonth, monthOf(period.to).to)))
        .groupBy(monthExpr),
      db
        .select({
          costCentreType: t.costCentreType,
          amount: sql<string>`COALESCE(SUM(${t.amount}), 0)`,
        })
        .from(t)
        .where(
          and(
            live,
            eq(t.direction, 'out'),
            eq(t.affectsPnl, true),
            between(t.transactionDate, period.from, period.to),
          ),
        )
        .groupBy(t.costCentreType),
      budgetsInUse(period.from, period.to),
      db
        .select({
          principal: loans.principal,
          interestCharged: loans.interestCharged,
          repaid: sql<string>`(SELECT COALESCE(SUM(lr.amount), 0) FROM loan_repayments lr WHERE lr.loan_id = ${outerColumn(loans.id)})`,
        })
        .from(loans)
        .where(and(isNull(loans.deletedAt), eq(loans.status, 'active'))),
    ]);

    const income = toNumber(totals?.income);
    const expenses = toNumber(totals?.expenses);
    const profit = round2(income - expenses);
    const cashPosition = toNumber(cash?.balance);
    const loansOutstanding = round2(
      loanRows.reduce(
        (acc, l) =>
          acc + loanBalance(toNumber(l.principal), toNumber(l.interestCharged), toNumber(l.repaid)),
        0,
      ),
    );
    const amber = budgetRows.filter((b) => b.level === 'amber').length;
    const red = budgetRows.filter((b) => b.level === 'red').length;
    const range = { from: period.from, to: period.to };

    const kpis: Kpi[] = [
      {
        key: 'income',
        label: 'Revenue / income',
        value: income,
        format: 'money',
        tone: 'green',
        link: linkTo('/finance/transactions', { direction: 'in', ...range }),
      },
      {
        key: 'expenses',
        label: 'Expenses',
        value: expenses,
        format: 'money',
        link: linkTo('/finance/transactions', { direction: 'out', ...range }),
      },
      {
        key: 'profit',
        label: 'Profit',
        value: profit,
        format: 'money',
        tone: profit < 0 ? 'red' : 'green',
        link: linkTo('/reports/profit-loss', range),
      },
      {
        key: 'cash',
        label: 'Cash position',
        value: cashPosition,
        format: 'money',
        tone: cashPosition < 0 ? 'red' : 'neutral',
        hint: 'All money in − out to date',
        link: '/finance/cash-flow',
      },
      {
        key: 'budgetAlerts',
        label: 'Budgets at risk',
        value: amber + red,
        format: 'number',
        tone: red ? 'red' : amber ? 'amber' : 'green',
        hint: `${red} over budget · ${amber} at 80%+`,
        link: '/finance/budgets',
      },
      {
        key: 'loans',
        label: 'Loans outstanding',
        value: loansOutstanding,
        format: 'money',
        hint: `${loanRows.length} active loan${loanRows.length === 1 ? '' : 's'}`,
        link: '/finance/loans',
      },
    ];

    return {
      kpis,
      monthly: fillMonthly(
        months,
        monthlyRows.map((r) => ({
          ...r,
          income: toNumber(r.income),
          expenses: toNumber(r.expenses),
        })),
        ['income', 'expenses'] as const,
      ),
      expensesByCostCentre: byCentre.map((r) => ({
        costCentreType: r.costCentreType,
        amount: toNumber(r.amount),
        link: linkTo('/finance/transactions', {
          direction: 'out',
          costCentreType: r.costCentreType,
          ...range,
        }),
      })),
      budgetAlerts: budgetRows.filter((b) => b.level !== 'ok').slice(0, 8),
    };
  },
};
