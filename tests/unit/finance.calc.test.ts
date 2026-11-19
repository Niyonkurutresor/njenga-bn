import { describe, expect, it } from 'vitest';
import {
  budgetUsage,
  casualPay,
  isPaymentLocked,
  loanBalance,
  netSalary,
  projectProfit,
  wouldExceedBudget,
} from '../../src/modules/finance/finance.calc.js';

describe('budgetUsage (BRL-04, FR-FIN-04/05)', () => {
  it('computes used, remaining and percentage', () => {
    expect(budgetUsage(1_000_000, 250_000)).toEqual({
      budget: 1_000_000,
      spent: 250_000,
      remaining: 750_000,
      usedPct: 25,
      level: 'ok',
    });
  });

  it('turns amber at 80% and red at 100%', () => {
    expect(budgetUsage(100, 79.99).level).toBe('ok');
    expect(budgetUsage(100, 80).level).toBe('amber');
    expect(budgetUsage(100, 100).level).toBe('red');
    expect(budgetUsage(100, 130).remaining).toBe(-30);
  });

  it('treats spending without a budget as red', () => {
    expect(budgetUsage(0, 10)).toMatchObject({ level: 'red', usedPct: null });
    expect(budgetUsage(0, 0).level).toBe('ok');
  });
});

describe('wouldExceedBudget (FR-REQ-10)', () => {
  it('flags only when the total goes over budget', () => {
    expect(wouldExceedBudget(1000, 600, 400)).toBe(false);
    expect(wouldExceedBudget(1000, 600, 400.01)).toBe(true);
  });
});

describe('projectProfit (BRL-03)', () => {
  it('profit = contract value - costs, margin = profit / value', () => {
    expect(projectProfit(650_000, 487_500)).toEqual({
      contractValue: 650_000,
      cost: 487_500,
      profit: 162_500,
      marginPct: 25,
    });
  });

  it('reports losses and handles zero contract value', () => {
    expect(projectProfit(100, 150)).toMatchObject({ profit: -50, marginPct: -50 });
    expect(projectProfit(0, 10).marginPct).toBeNull();
  });
});

describe('payroll rules', () => {
  it('casual pay = days present x daily rate (BRL-05)', () => {
    expect(casualPay(12, 3_500)).toBe(42_000);
    expect(casualPay(0, 3_500)).toBe(0);
  });

  it('net salary = basic + allowances - deductions', () => {
    expect(netSalary(300_000, 50_000, 45_000.5)).toBe(304_999.5);
  });
});

describe('loanBalance (BRL-06)', () => {
  it('= amount + interest charged - repayments', () => {
    expect(loanBalance(5_000_000, 400_000, 1_200_000)).toBe(4_200_000);
  });
});

describe('isPaymentLocked (FR-FIN-10, BRL-09)', () => {
  it('locks payments older than 24 hours', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    expect(isPaymentLocked(new Date('2026-11-17T13:00:00Z'), now)).toBe(false);
    expect(isPaymentLocked(new Date('2026-11-17T11:59:00Z'), now)).toBe(true);
  });
});
