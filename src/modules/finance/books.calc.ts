import { round2 } from '../../common/utils/money.js';
import type { TransactionDirection, TransactionSource } from '../../db/enums.js';

/**
 * Pure book-keeping maths for the finance books (day book, cash book, general ledger, trial
 * balance). The ledger is single-entry with categories; these functions present it in the
 * classic book formats without pretending to be a full double-entry system.
 */

export interface Movement {
  direction: TransactionDirection;
  amount: number;
}

/** Signed effect on a cash balance: money in adds, money out subtracts. */
export function cashEffect(m: Movement): number {
  return m.direction === 'in' ? m.amount : -m.amount;
}

/** Opening balance = signed sum of every movement before the period. */
export function openingBalance(movements: readonly Movement[], effect = cashEffect): number {
  return round2(movements.reduce((s, m) => s + effect(m), 0));
}

/** Adds a running `balance` to each entry (in order), starting from `opening`. */
export function withRunningBalance<T extends Movement>(
  entries: readonly T[],
  opening: number,
  effect: (m: Movement) => number = cashEffect,
): { rows: (T & { balance: number })[]; closing: number; totalIn: number; totalOut: number } {
  let balance = round2(opening);
  let totalIn = 0;
  let totalOut = 0;
  const rows = entries.map((e) => {
    balance = round2(balance + effect(e));
    if (e.direction === 'in') totalIn = round2(totalIn + e.amount);
    else totalOut = round2(totalOut + e.amount);
    return { ...e, balance };
  });
  return { rows, closing: balance, totalIn, totalOut };
}

/**
 * General-ledger account balance in debit terms: money out is a debit to the category
 * (expense / asset bought), money in is a credit (income / funds received).
 */
export function debitEffect(m: Movement): number {
  return m.direction === 'out' ? m.amount : -m.amount;
}

export interface TrialBalanceInput {
  /** Per-category movement totals for the period. */
  categories: { categoryId: number | null; category: string; moneyIn: number; moneyOut: number }[];
  /** Cash movements (affectsCash) for the period. */
  cashIn: number;
  cashOut: number;
  /** Non-cash movements (e.g. stock issued from inventory) for the period. */
  nonCashIn: number;
  nonCashOut: number;
}

export interface TrialBalanceRow {
  account: string;
  categoryId: number | null;
  kind: 'category' | 'cash' | 'non_cash';
  debit: number;
  credit: number;
}

/**
 * Trial balance of the single-entry ledger for a period. Each recorded outflow debits its
 * category and credits Cash/Bank (or, when no cash moved, the non-cash contra such as stock);
 * each inflow does the reverse. Totals therefore agree whenever every movement is recorded once.
 */
export function trialBalance(input: TrialBalanceInput) {
  const rows: TrialBalanceRow[] = input.categories
    .map((c) => ({
      account: c.category,
      categoryId: c.categoryId,
      kind: 'category' as const,
      debit: round2(c.moneyOut),
      credit: round2(c.moneyIn),
    }))
    .sort((a, b) => a.account.localeCompare(b.account));
  rows.push({
    account: 'Cash and bank',
    categoryId: null,
    kind: 'cash',
    debit: round2(input.cashIn),
    credit: round2(input.cashOut),
  });
  if (input.nonCashIn || input.nonCashOut) {
    rows.push({
      account: 'Non-cash movements (stock issued, etc.)',
      categoryId: null,
      kind: 'non_cash',
      debit: round2(input.nonCashIn),
      credit: round2(input.nonCashOut),
    });
  }
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return {
    rows,
    totalDebit,
    totalCredit,
    difference: round2(totalDebit - totalCredit),
    balanced: Math.abs(totalDebit - totalCredit) < 0.005,
  };
}

/** Frontend path of the record that produced a ledger entry (day book "source" link). */
export function sourceLink(entry: {
  id: number;
  source: TransactionSource;
  sourceId: number | null;
  loanId: number | null;
  sourceRunId?: number | null;
}): string | null {
  switch (entry.source) {
    case 'manual':
      return `/finance/transactions/${entry.id}`;
    case 'request':
      return entry.sourceId ? `/requests/${entry.sourceId}` : null;
    case 'payroll':
      return entry.sourceRunId ? `/payroll/runs/${entry.sourceRunId}` : null;
    case 'casual_payroll':
      return entry.sourceRunId ? `/payroll/casual-runs/${entry.sourceRunId}` : null;
    case 'stock_purchase':
    case 'stock_issue':
      return '/inventory';
    case 'loan_receipt':
    case 'loan_repayment':
      return entry.loanId ? `/finance/loans/${entry.loanId}` : null;
  }
}

/** Cash-flow statement section of a ledger source (operating vs financing activities). */
export function cashFlowActivity(source: TransactionSource): 'operating' | 'financing' {
  return source === 'loan_receipt' || source === 'loan_repayment' ? 'financing' : 'operating';
}
