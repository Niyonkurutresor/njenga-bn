import { and, asc, desc, eq, gte, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  casualPayItems,
  categories,
  payrollItems,
  projects,
  transactions,
  users,
} from '../../db/schema/index.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../../db/enums.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { monthRange, today } from '../../common/utils/dates.js';
import { round2, toNumber } from '../../common/utils/money.js';
import {
  cashFlowActivity,
  debitEffect,
  sourceLink,
  trialBalance,
  withRunningBalance,
} from './books.calc.js';
import { budgetService } from './budgets.service.js';
import type { BookQuery } from './finance.schema.js';
import { loanService } from './loans.service.js';
import { financeReportService } from './reports.service.js';

/** Upper bound for unpaginated books; the response says when it was reached. */
export const BOOK_ROW_LIMIT = 5000;

export function bookPeriod(query: Pick<BookQuery, 'from' | 'to'>) {
  const to = query.to ?? today();
  return { from: query.from ?? monthRange(to).from, to };
}

/** Filters other than the date range (shared by period rows and opening balances). */
function scopeFilters(query: BookQuery, opts: { search?: boolean } = {}): SQL[] {
  const f: SQL[] = [isNull(transactions.deletedAt)];
  if (query.costCentreType) f.push(eq(transactions.costCentreType, query.costCentreType));
  if (query.projectId) f.push(eq(transactions.projectId, query.projectId));
  if (query.categoryId) f.push(eq(transactions.categoryId, query.categoryId));
  if (query.paymentMethod === 'none') f.push(isNull(transactions.paymentMethod));
  else if (query.paymentMethod) f.push(eq(transactions.paymentMethod, query.paymentMethod));
  if (query.direction) f.push(eq(transactions.direction, query.direction));
  if (query.source) f.push(eq(transactions.source, query.source));
  if (query.recordedBy) f.push(eq(transactions.recordedBy, query.recordedBy));
  if (query.loanId) f.push(eq(transactions.loanId, query.loanId));
  if (opts.search !== false) f.push(...searchFilter(query));
  return f;
}

/** Free-text search on reference / description. */
function searchFilter(query: Pick<BookQuery, 'search'>): SQL[] {
  if (!query.search) return [];
  const term = `%${query.search}%`;
  return [or(like(transactions.reference, term), like(transactions.description, term))!];
}

function inPeriod(from: string, to: string): SQL[] {
  return [gte(transactions.transactionDate, from), lte(transactions.transactionDate, to)];
}

const signedSum = sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} ELSE -${transactions.amount} END), 0)`;
const sumIn = sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} END), 0)`;
const sumOut = sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'out' THEN ${transactions.amount} END), 0)`;

/** Day-book columns, with the payroll / casual-pay run behind an entry for the source link. */
const entryColumns = {
  id: transactions.id,
  transactionDate: transactions.transactionDate,
  reference: transactions.reference,
  description: transactions.description,
  direction: transactions.direction,
  amount: transactions.amount,
  source: transactions.source,
  sourceId: transactions.sourceId,
  loanId: transactions.loanId,
  costCentreType: transactions.costCentreType,
  paymentMethod: transactions.paymentMethod,
  affectsCash: transactions.affectsCash,
  affectsPnl: transactions.affectsPnl,
  categoryId: transactions.categoryId,
  category: categories.name,
  project: { id: projects.id, code: projects.code, name: projects.name },
  recordedBy: { id: users.id, name: users.name },
  payrollRunId: payrollItems.runId,
  casualRunId: casualPayItems.runId,
  createdAt: transactions.createdAt,
};

function entriesQuery(where: SQL | undefined) {
  return db
    .select(entryColumns)
    .from(transactions)
    .innerJoin(users, eq(users.id, transactions.recordedBy))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(projects, eq(projects.id, transactions.projectId))
    .leftJoin(
      payrollItems,
      and(eq(transactions.source, 'payroll'), eq(payrollItems.id, transactions.sourceId)),
    )
    .leftJoin(
      casualPayItems,
      and(eq(transactions.source, 'casual_payroll'), eq(casualPayItems.id, transactions.sourceId)),
    )
    .where(where);
}

type EntryRow = Awaited<ReturnType<typeof entriesQuery>>[number];

function presentEntry(r: EntryRow) {
  const { payrollRunId, casualRunId, ...rest } = r;
  return {
    ...rest,
    category: r.category ?? 'Uncategorised',
    moneyIn: r.direction === 'in' ? r.amount : 0,
    moneyOut: r.direction === 'out' ? r.amount : 0,
    sourceLink: sourceLink({ ...r, sourceRunId: payrollRunId ?? casualRunId }),
  };
}

export type BookEntry = ReturnType<typeof presentEntry>;

/**
 * The finance books (FR-FIN-08/09 and the coordinator's "basic books" requirement). Everything
 * is read from the single ledger, so every module's money — requests, payroll, casual pay,
 * stock, loans, manual entries — appears here for anyone with `finance:view`.
 */
export const booksService = {
  /** Day book / journal: every ledger entry in date order, paginated, with totals. */
  async dayBook(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const where = and(...scopeFilters(query), ...inPeriod(from, to));
    const order =
      query.sortDir === 'desc'
        ? [desc(transactions.transactionDate), desc(transactions.id)]
        : [asc(transactions.transactionDate), asc(transactions.id)];
    const [rows, [agg]] = await Promise.all([
      entriesQuery(where)
        .orderBy(...order)
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)`, moneyIn: sumIn, moneyOut: sumOut })
        .from(transactions)
        .where(where),
    ]);
    const page = paginated(rows.map(presentEntry), Number(agg?.total ?? 0), query);
    Object.assign(page.meta, {
      from,
      to,
      totalIn: round2(toNumber(agg?.moneyIn)),
      totalOut: round2(toNumber(agg?.moneyOut)),
    });
    return page;
  },

  /** All day-book rows for an export (capped). */
  async dayBookAll(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const rows = await entriesQuery(and(...scopeFilters(query), ...inPeriod(from, to)))
      .orderBy(asc(transactions.transactionDate), asc(transactions.id))
      .limit(BOOK_ROW_LIMIT + 1);
    const entries = rows.slice(0, BOOK_ROW_LIMIT).map(presentEntry);
    return {
      from,
      to,
      entries,
      truncated: rows.length > BOOK_ROW_LIMIT,
      totalIn: round2(entries.reduce((s, e) => s + e.moneyIn, 0)),
      totalOut: round2(entries.reduce((s, e) => s + e.moneyOut, 0)),
    };
  },

  /**
   * Cash book: real money only (`affectsCash`), opening balance before `from`, running and
   * closing balance, and a per-payment-method split for reconciliation (cash / bank / mobile money).
   */
  async cashBook(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const scope = [...scopeFilters(query, { search: false }), eq(transactions.affectsCash, true)];
    const search = searchFilter(query);

    const [[opening], rows, methodOpen, methodPeriod] = await Promise.all([
      db
        .select({ net: signedSum })
        .from(transactions)
        .where(and(...scope, lt(transactions.transactionDate, from))),
      entriesQuery(and(...scope, ...search, ...inPeriod(from, to)))
        .orderBy(asc(transactions.transactionDate), asc(transactions.id))
        .limit(BOOK_ROW_LIMIT + 1),
      db
        .select({ method: transactions.paymentMethod, net: signedSum })
        .from(transactions)
        .where(and(...scope, lt(transactions.transactionDate, from)))
        .groupBy(transactions.paymentMethod),
      db
        .select({ method: transactions.paymentMethod, moneyIn: sumIn, moneyOut: sumOut })
        .from(transactions)
        .where(and(...scope, ...inPeriod(from, to)))
        .groupBy(transactions.paymentMethod),
    ]);

    const openingBalance = round2(toNumber(opening?.net));
    // With a search the running balance only covers matching rows; opening stays the full book's.
    const book = withRunningBalance(
      rows.slice(0, BOOK_ROW_LIMIT).map(presentEntry),
      openingBalance,
    );

    const methods: (PaymentMethod | null)[] = [...PAYMENT_METHODS, null];
    const byMethod = methods
      .map((method) => {
        const o = toNumber(methodOpen.find((m) => m.method === method)?.net);
        const p = methodPeriod.find((m) => m.method === method);
        const moneyIn = round2(toNumber(p?.moneyIn));
        const moneyOut = round2(toNumber(p?.moneyOut));
        return {
          paymentMethod: method,
          opening: round2(o),
          moneyIn,
          moneyOut,
          closing: round2(o + moneyIn - moneyOut),
        };
      })
      .filter((m) => m.opening || m.moneyIn || m.moneyOut);

    return {
      from,
      to,
      openingBalance,
      entries: book.rows,
      totalIn: book.totalIn,
      totalOut: book.totalOut,
      closingBalance: book.closing,
      truncated: rows.length > BOOK_ROW_LIMIT,
      byMethod,
    };
  },

  /**
   * General ledger: one account per category, each with an opening balance (before `from`),
   * its entries with a running balance, and a closing balance. Balances are in debit terms:
   * money out debits the account, money in credits it.
   */
  async generalLedger(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const scope = scopeFilters(query, { search: false });
    const [openings, rows] = await Promise.all([
      db
        .select({
          categoryId: transactions.categoryId,
          category: categories.name,
          debit: sumOut,
          credit: sumIn,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(and(...scope, lt(transactions.transactionDate, from)))
        .groupBy(transactions.categoryId, categories.name),
      entriesQuery(and(...scopeFilters(query), ...inPeriod(from, to)))
        .orderBy(asc(categories.name), asc(transactions.transactionDate), asc(transactions.id))
        .limit(BOOK_ROW_LIMIT + 1),
    ]);

    const accounts = new Map<
      number | null,
      { categoryId: number | null; account: string; opening: number; entries: BookEntry[] }
    >();
    for (const o of openings) {
      accounts.set(o.categoryId, {
        categoryId: o.categoryId,
        account: o.category ?? 'Uncategorised',
        opening: round2(toNumber(o.debit) - toNumber(o.credit)),
        entries: [],
      });
    }
    for (const r of rows.slice(0, BOOK_ROW_LIMIT).map(presentEntry)) {
      const acc = accounts.get(r.categoryId) ?? {
        categoryId: r.categoryId,
        account: r.category,
        opening: 0,
        entries: [],
      };
      acc.entries.push(r);
      accounts.set(r.categoryId, acc);
    }

    const result = [...accounts.values()]
      .filter((a) => a.entries.length || a.opening)
      .sort((a, b) => a.account.localeCompare(b.account))
      .map((a) => {
        const book = withRunningBalance(a.entries, a.opening, debitEffect);
        return {
          categoryId: a.categoryId,
          account: a.account,
          opening: a.opening,
          debit: book.totalOut,
          credit: book.totalIn,
          closing: book.closing,
          entries: book.rows,
        };
      });
    return {
      from,
      to,
      accounts: result,
      truncated: rows.length > BOOK_ROW_LIMIT,
      totals: {
        opening: round2(result.reduce((s, a) => s + a.opening, 0)),
        debit: round2(result.reduce((s, a) => s + a.debit, 0)),
        credit: round2(result.reduce((s, a) => s + a.credit, 0)),
        closing: round2(result.reduce((s, a) => s + a.closing, 0)),
      },
    };
  },

  /** Trial balance of the period: categories plus the Cash/Bank (and non-cash) contra rows. */
  async trialBalance(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const where = and(...scopeFilters(query, { search: false }), ...inPeriod(from, to));
    const [cats, [cash], [nonCash]] = await Promise.all([
      db
        .select({
          categoryId: transactions.categoryId,
          category: categories.name,
          moneyIn: sumIn,
          moneyOut: sumOut,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(where)
        .groupBy(transactions.categoryId, categories.name),
      db
        .select({ moneyIn: sumIn, moneyOut: sumOut })
        .from(transactions)
        .where(and(where, eq(transactions.affectsCash, true))),
      db
        .select({ moneyIn: sumIn, moneyOut: sumOut })
        .from(transactions)
        .where(and(where, eq(transactions.affectsCash, false))),
    ]);
    return {
      from,
      to,
      ...trialBalance({
        categories: cats.map((c) => ({
          categoryId: c.categoryId,
          category: c.category ?? 'Uncategorised',
          moneyIn: toNumber(c.moneyIn),
          moneyOut: toNumber(c.moneyOut),
        })),
        cashIn: toNumber(cash?.moneyIn),
        cashOut: toNumber(cash?.moneyOut),
        nonCashIn: toNumber(nonCash?.moneyIn),
        nonCashOut: toNumber(nonCash?.moneyOut),
      }),
      note:
        'The ledger is single-entry with categories. Each outflow is shown as a debit to its ' +
        'category and a credit to Cash and bank (or to non-cash movements when no cash moved); ' +
        'each inflow the reverse.',
    };
  },

  /** Income statement (P&L) for the period — same figures as /finance/profit-loss. */
  async incomeStatement(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    return financeReportService.profitLoss({
      from,
      to,
      costCentreType: query.costCentreType,
      projectId: query.projectId,
    });
  },

  /**
   * Cash flow statement: opening cash, inflows and outflows by activity (operating vs
   * financing) and category, net change and closing cash. The period series comes from
   * /finance/cash-flow for the chart.
   */
  async cashFlowStatement(query: BookQuery) {
    const { from, to } = bookPeriod(query);
    const scope = [
      isNull(transactions.deletedAt),
      eq(transactions.affectsCash, true),
      query.costCentreType ? eq(transactions.costCentreType, query.costCentreType) : undefined,
      query.projectId ? eq(transactions.projectId, query.projectId) : undefined,
    ].filter((f): f is SQL => Boolean(f));
    const [[opening], rows, series] = await Promise.all([
      db
        .select({ net: signedSum })
        .from(transactions)
        .where(and(...scope, lt(transactions.transactionDate, from))),
      db
        .select({
          source: transactions.source,
          direction: transactions.direction,
          categoryId: transactions.categoryId,
          category: categories.name,
          total: sql<string>`SUM(${transactions.amount})`,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(and(...scope, ...inPeriod(from, to)))
        .groupBy(
          transactions.source,
          transactions.direction,
          transactions.categoryId,
          categories.name,
        ),
      financeReportService.cashFlow({
        from,
        to,
        interval: query.interval,
        costCentreType: query.costCentreType,
      }),
    ]);

    type Line = { categoryId: number | null; category: string; amount: number };
    const sections = {
      operating: { inflows: new Map<string, Line>(), outflows: new Map<string, Line>() },
      financing: { inflows: new Map<string, Line>(), outflows: new Map<string, Line>() },
    };
    for (const r of rows) {
      const bucket =
        sections[cashFlowActivity(r.source)][r.direction === 'in' ? 'inflows' : 'outflows'];
      const key = String(r.categoryId ?? 'none');
      const line = bucket.get(key) ?? {
        categoryId: r.categoryId,
        category: r.category ?? 'Uncategorised',
        amount: 0,
      };
      line.amount = round2(line.amount + toNumber(r.total));
      bucket.set(key, line);
    }
    const present = (s: { inflows: Map<string, Line>; outflows: Map<string, Line> }) => {
      const inflows = [...s.inflows.values()].sort((a, b) => b.amount - a.amount);
      const outflows = [...s.outflows.values()].sort((a, b) => b.amount - a.amount);
      const totalIn = round2(inflows.reduce((t, l) => t + l.amount, 0));
      const totalOut = round2(outflows.reduce((t, l) => t + l.amount, 0));
      return { inflows, outflows, totalIn, totalOut, net: round2(totalIn - totalOut) };
    };
    const operating = present(sections.operating);
    const financing = present(sections.financing);
    const openingCash = round2(toNumber(opening?.net));
    const netChange = round2(operating.net + financing.net);
    return {
      from,
      to,
      openingCash,
      operating,
      financing,
      netChange,
      closingCash: round2(openingCash + netChange),
      series: series.series,
      interval: series.interval,
    };
  },

  /** Budget vs actual for every budget in scope (FR-FIN-04). */
  async budgetVsActual(query: BookQuery) {
    const rows = await budgetService.all({
      costCentreType: query.costCentreType,
      projectId: query.projectId,
    });
    const totals = rows.reduce(
      (t, b) => ({ budget: t.budget + b.usage.budget, spent: t.spent + b.usage.spent }),
      { budget: 0, spent: 0 },
    );
    return {
      budgets: rows,
      totals: {
        budget: round2(totals.budget),
        spent: round2(totals.spent),
        remaining: round2(totals.budget - totals.spent),
      },
    };
  },

  /** Loan register: every loan with received, used, unused, repaid and balance (US-OA-008). */
  async loanRegister() {
    const page = await loanService.list({
      page: 1,
      pageSize: 100,
      sortDir: 'asc',
      sortBy: 'startDate',
    });
    const loans = page.data;
    const sum = (k: 'principal' | 'received' | 'used' | 'unused' | 'repaid' | 'balance') =>
      round2(loans.reduce((s, l) => s + l[k], 0));
    return {
      loans,
      totals: {
        principal: sum('principal'),
        received: sum('received'),
        used: sum('used'),
        unused: sum('unused'),
        repaid: sum('repaid'),
        balance: sum('balance'),
      },
    };
  },
};
