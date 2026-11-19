import { and, desc, eq, gte, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { categories, projects, transactions, users } from '../../db/schema/index.js';
import { COST_CENTRE_TYPES, type CostCentreType } from '../../db/enums.js';
import { addDays, monthRange, today } from '../../common/utils/dates.js';
import { percent, round2, toNumber } from '../../common/utils/money.js';
import { bucketStart, bucketStarts } from './finance.calc.js';
import { budgetService } from './budgets.service.js';
import { loanService } from './loans.service.js';
import type { CashFlowQuery, ProfitLossQuery, SummaryQuery } from './finance.schema.js';

function dateFilters(from?: string, to?: string): SQL[] {
  const f: SQL[] = [isNull(transactions.deletedAt)];
  if (from) f.push(gte(transactions.transactionDate, from));
  if (to) f.push(lte(transactions.transactionDate, to));
  return f;
}

interface CategoryAmount {
  categoryId: number | null;
  category: string;
  amount: number;
}

function addTo(
  map: Map<number | null, CategoryAmount>,
  id: number | null,
  name: string | null,
  n: number,
) {
  const entry = map.get(id) ?? { categoryId: id, category: name ?? 'Uncategorised', amount: 0 };
  entry.amount = round2(entry.amount + n);
  map.set(id, entry);
}

const sorted = (m: Map<number | null, CategoryAmount>) =>
  [...m.values()].sort((a, b) => b.amount - a.amount);

/** Cash position = all cash in − all cash out up to and including `date`. */
async function cashPositionAt(date: string, exclusive = false): Promise<number> {
  const [row] = await db
    .select({
      net: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} ELSE -${transactions.amount} END), 0)`,
    })
    .from(transactions)
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.affectsCash, true),
        exclusive
          ? lt(transactions.transactionDate, date)
          : lte(transactions.transactionDate, date),
      ),
    );
  return round2(toNumber(row?.net));
}

export const financeReportService = {
  /**
   * FR-FIN-08: income, costs by category and profit for the company, an area
   * (project / farm / office) or one project, for any date range. Only `affectsPnl` rows count.
   */
  async profitLoss(query: ProfitLossQuery) {
    const filters = [...dateFilters(query.from, query.to), eq(transactions.affectsPnl, true)];
    if (query.costCentreType) filters.push(eq(transactions.costCentreType, query.costCentreType));
    if (query.projectId) filters.push(eq(transactions.projectId, query.projectId));

    const rows = await db
      .select({
        direction: transactions.direction,
        costCentreType: transactions.costCentreType,
        projectId: transactions.projectId,
        projectCode: projects.code,
        projectName: projects.name,
        categoryId: transactions.categoryId,
        category: categories.name,
        total: sql<string>`SUM(${transactions.amount})`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(projects, eq(projects.id, transactions.projectId))
      .where(and(...filters))
      .groupBy(
        transactions.direction,
        transactions.costCentreType,
        transactions.projectId,
        projects.code,
        projects.name,
        transactions.categoryId,
        categories.name,
      );

    const income = new Map<number | null, CategoryAmount>();
    const costs = new Map<number | null, CategoryAmount>();
    const areas = new Map<CostCentreType, { income: number; costs: number }>(
      COST_CENTRE_TYPES.map((a) => [a, { income: 0, costs: 0 }]),
    );
    const projectMap = new Map<
      number,
      { projectId: number; code: string; name: string; income: number; costs: number }
    >();

    for (const r of rows) {
      const n = toNumber(r.total);
      addTo(r.direction === 'in' ? income : costs, r.categoryId, r.category, n);
      const area = areas.get(r.costCentreType)!;
      if (r.direction === 'in') area.income = round2(area.income + n);
      else area.costs = round2(area.costs + n);
      if (r.projectId) {
        const p = projectMap.get(r.projectId) ?? {
          projectId: r.projectId,
          code: r.projectCode ?? '',
          name: r.projectName ?? '',
          income: 0,
          costs: 0,
        };
        if (r.direction === 'in') p.income = round2(p.income + n);
        else p.costs = round2(p.costs + n);
        projectMap.set(r.projectId, p);
      }
    }

    const totalIncome = round2([...income.values()].reduce((s, c) => s + c.amount, 0));
    const totalCosts = round2([...costs.values()].reduce((s, c) => s + c.amount, 0));
    const profit = round2(totalIncome - totalCosts);
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      income: { total: totalIncome, byCategory: sorted(income) },
      costs: { total: totalCosts, byCategory: sorted(costs) },
      profit,
      marginPct: percent(profit, totalIncome),
      byArea: [...areas.entries()]
        .filter(([area]) => !query.costCentreType || area === query.costCentreType)
        .map(([area, v]) => ({ area, ...v, profit: round2(v.income - v.costs) })),
      byProject: [...projectMap.values()]
        .map((p) => ({ ...p, profit: round2(p.income - p.costs) }))
        .sort((a, b) => b.profit - a.profit),
    };
  },

  /** FR-FIN-09: money in, out and net per day / week / month (`affectsCash` rows). */
  async cashFlow(query: CashFlowQuery) {
    const to = query.to ?? today();
    const from =
      query.from ??
      (query.interval === 'day'
        ? addDays(to, -29)
        : query.interval === 'week'
          ? addDays(to, -7 * 11)
          : `${addDays(monthRange(to).from, -330).slice(0, 7)}-01`);

    const bucket =
      query.interval === 'day'
        ? sql<string>`${transactions.transactionDate}`
        : query.interval === 'week'
          ? sql<string>`DATE_SUB(${transactions.transactionDate}, INTERVAL WEEKDAY(${transactions.transactionDate}) DAY)`
          : sql<string>`DATE_FORMAT(${transactions.transactionDate}, '%Y-%m-01')`;

    const filters = [...dateFilters(from, to), eq(transactions.affectsCash, true)];
    if (query.costCentreType) filters.push(eq(transactions.costCentreType, query.costCentreType));

    const [rows, opening] = await Promise.all([
      db
        .select({
          period: bucket,
          direction: transactions.direction,
          total: sql<string>`SUM(${transactions.amount})`,
        })
        .from(transactions)
        .where(and(...filters))
        .groupBy(bucket, transactions.direction),
      query.costCentreType ? Promise.resolve(null) : cashPositionAt(from, true),
    ]);

    const totals = new Map<string, { in: number; out: number }>();
    for (const r of rows) {
      const key = bucketStart(String(r.period).slice(0, 10), query.interval);
      const entry = totals.get(key) ?? { in: 0, out: 0 };
      entry[r.direction] = round2(entry[r.direction] + toNumber(r.total));
      totals.set(key, entry);
    }

    let running = opening ?? 0;
    const series = bucketStarts(from, to, query.interval).map((period) => {
      const v = totals.get(period) ?? { in: 0, out: 0 };
      const net = round2(v.in - v.out);
      running = round2(running + net);
      return { period, in: v.in, out: v.out, net, balance: opening === null ? null : running };
    });
    const moneyIn = round2(series.reduce((s, p) => s + p.in, 0));
    const moneyOut = round2(series.reduce((s, p) => s + p.out, 0));
    return {
      from,
      to,
      interval: query.interval,
      openingBalance: opening,
      closingBalance: opening === null ? null : running,
      totals: { in: moneyIn, out: moneyOut, net: round2(moneyIn - moneyOut) },
      series,
    };
  },

  /** Finance overview: KPIs for the range, budgets at amber/red, loans and recent entries. */
  async summary(query: SummaryQuery) {
    const to = query.to ?? today();
    const from = query.from ?? monthRange(to).from;
    const range = dateFilters(from, to);

    const [[pnl], [cash], cashPosition, budgetsAtRisk, loans, recent] = await Promise.all([
      db
        .select({
          income: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} END), 0)`,
          expenses: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'out' THEN ${transactions.amount} END), 0)`,
        })
        .from(transactions)
        .where(and(...range, eq(transactions.affectsPnl, true))),
      db
        .select({
          moneyIn: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} END), 0)`,
          moneyOut: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'out' THEN ${transactions.amount} END), 0)`,
        })
        .from(transactions)
        .where(and(...range, eq(transactions.affectsCash, true))),
      cashPositionAt(to),
      budgetService.atRisk(),
      loanService.outstanding(),
      db
        .select({
          id: transactions.id,
          direction: transactions.direction,
          transactionDate: transactions.transactionDate,
          amount: transactions.amount,
          costCentreType: transactions.costCentreType,
          reference: transactions.reference,
          description: transactions.description,
          source: transactions.source,
          category: { id: categories.id, name: categories.name },
          project: { id: projects.id, code: projects.code, name: projects.name },
          recordedBy: { id: users.id, name: users.name },
        })
        .from(transactions)
        .innerJoin(users, eq(users.id, transactions.recordedBy))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .where(isNull(transactions.deletedAt))
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(8),
    ]);

    const income = round2(toNumber(pnl?.income));
    const expenses = round2(toNumber(pnl?.expenses));
    return {
      from,
      to,
      income,
      expenses,
      net: round2(income - expenses),
      cashIn: round2(toNumber(cash?.moneyIn)),
      cashOut: round2(toNumber(cash?.moneyOut)),
      cashPosition,
      budgetsAtRisk,
      loans,
      recentTransactions: recent,
    };
  },
};
