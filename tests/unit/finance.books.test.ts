import { describe, expect, it } from 'vitest';
import {
  cashFlowActivity,
  debitEffect,
  openingBalance,
  sourceLink,
  trialBalance,
  withRunningBalance,
} from '../../src/modules/finance/books.calc.js';

describe('openingBalance', () => {
  it('nets money in against money out before the period', () => {
    expect(
      openingBalance([
        { direction: 'in', amount: 1000 },
        { direction: 'out', amount: 250.5 },
        { direction: 'out', amount: 100 },
      ]),
    ).toBe(649.5);
    expect(openingBalance([])).toBe(0);
  });

  it('uses debit terms for ledger accounts', () => {
    expect(
      openingBalance(
        [
          { direction: 'out', amount: 300 },
          { direction: 'in', amount: 50 },
        ],
        debitEffect,
      ),
    ).toBe(250);
  });
});

describe('withRunningBalance (cash book)', () => {
  it('carries the balance through every entry and totals both sides', () => {
    const r = withRunningBalance(
      [
        { id: 1, direction: 'in' as const, amount: 500 },
        { id: 2, direction: 'out' as const, amount: 200 },
        { id: 3, direction: 'out' as const, amount: 400 },
      ],
      100,
    );
    expect(r.rows.map((x) => x.balance)).toEqual([600, 400, 0]);
    expect(r.closing).toBe(0);
    expect(r.totalIn).toBe(500);
    expect(r.totalOut).toBe(600);
    expect(r.rows[0]!.id).toBe(1);
  });

  it('closing = opening + in − out, without float drift', () => {
    const r = withRunningBalance(
      [
        { direction: 'in' as const, amount: 0.1 },
        { direction: 'in' as const, amount: 0.2 },
      ],
      0,
    );
    expect(r.closing).toBe(0.3);
  });

  it('keeps the opening balance when there are no entries', () => {
    expect(withRunningBalance([], 1234).closing).toBe(1234);
  });
});

describe('trialBalance', () => {
  it('balances when every movement is either cash or non-cash', () => {
    // Expenses 700 (600 cash + 100 stock issued), income 1000 cash.
    const tb = trialBalance({
      categories: [
        { categoryId: 1, category: 'Materials', moneyIn: 0, moneyOut: 400 },
        { categoryId: 2, category: 'Salaries', moneyIn: 0, moneyOut: 300 },
        { categoryId: 3, category: 'Project revenue', moneyIn: 1000, moneyOut: 0 },
      ],
      cashIn: 1000,
      cashOut: 600,
      nonCashIn: 0,
      nonCashOut: 100,
    });
    expect(tb.totalDebit).toBe(1700);
    expect(tb.totalCredit).toBe(1700);
    expect(tb.balanced).toBe(true);
    expect(tb.difference).toBe(0);
    expect(tb.rows.at(-2)).toMatchObject({ kind: 'cash', debit: 1000, credit: 600 });
    expect(tb.rows.at(-1)).toMatchObject({ kind: 'non_cash', debit: 0, credit: 100 });
  });

  it('flags an imbalance', () => {
    const tb = trialBalance({
      categories: [{ categoryId: 1, category: 'Fuel', moneyIn: 0, moneyOut: 500 }],
      cashIn: 0,
      cashOut: 400,
      nonCashIn: 0,
      nonCashOut: 0,
    });
    expect(tb.balanced).toBe(false);
    expect(tb.difference).toBe(100);
    expect(tb.rows.some((r) => r.kind === 'non_cash')).toBe(false);
  });
});

describe('sourceLink', () => {
  const base = { id: 7, sourceId: 3, loanId: 2, sourceRunId: 9 };
  it('points each entry at the record that produced it', () => {
    expect(sourceLink({ ...base, source: 'manual' })).toBe('/finance/transactions/7');
    expect(sourceLink({ ...base, source: 'request' })).toBe('/requests/3');
    expect(sourceLink({ ...base, source: 'payroll' })).toBe('/payroll/runs/9');
    expect(sourceLink({ ...base, source: 'casual_payroll' })).toBe('/payroll/casual-runs/9');
    expect(sourceLink({ ...base, source: 'loan_repayment' })).toBe('/finance/loans/2');
    expect(sourceLink({ ...base, source: 'stock_issue' })).toBe('/inventory');
  });

  it('classifies loan money as financing', () => {
    expect(cashFlowActivity('loan_receipt')).toBe('financing');
    expect(cashFlowActivity('payroll')).toBe('operating');
  });
});
