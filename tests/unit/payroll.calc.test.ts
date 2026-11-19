import { describe, expect, it } from 'vitest';
import {
  casualPayLines,
  isFutureDate,
  payrollLine,
  siteCostCentre,
} from '../../src/modules/payroll/payroll.calc.js';

describe('payrollLine (FR-PAY-01/02)', () => {
  it('computes net pay = basic + allowances − deductions', () => {
    expect(payrollLine({ basicSalary: 500_000, allowances: 50_000, deductions: 80_000 })).toEqual({
      basicSalary: 500_000,
      allowances: 50_000,
      deductions: 80_000,
      netPay: 470_000,
    });
  });

  it('skips employees with nothing to pay', () => {
    expect(payrollLine({ basicSalary: 0, allowances: 0, deductions: 0 })).toBeNull();
    expect(payrollLine({ basicSalary: 100, allowances: 0, deductions: 150 })).toBeNull();
  });
});

describe('casualPayLines (BRL-05, US-OA-007 AC1)', () => {
  it('pays days present × daily rate and totals the run', () => {
    const { items, total } = casualPayLines([
      { workerId: 1, daysPresent: 5, dailyRate: 3000, siteType: 'farm', projectId: null },
      { workerId: 2, daysPresent: 3, dailyRate: 3500.5, siteType: 'project', projectId: 9 },
      { workerId: 3, daysPresent: 0, dailyRate: 3000, siteType: 'farm', projectId: null },
    ]);
    expect(items.map((i) => [i.workerId, i.amount])).toEqual([
      [1, 15_000],
      [2, 10_501.5],
    ]);
    expect(total).toBe(25_501.5);
  });
});

describe('siteCostCentre (FR-PAY-06)', () => {
  it('charges farm workers to the farm and project workers to their project', () => {
    expect(siteCostCentre('farm', 4)).toEqual({ costCentreType: 'farm', projectId: null });
    expect(siteCostCentre('project', 4)).toEqual({ costCentreType: 'project', projectId: 4 });
  });
});

describe('isFutureDate', () => {
  it('rejects only dates after today', () => {
    expect(isFutureDate('2026-11-19', '2026-11-18')).toBe(true);
    expect(isFutureDate('2026-11-18', '2026-11-18')).toBe(false);
  });
});
