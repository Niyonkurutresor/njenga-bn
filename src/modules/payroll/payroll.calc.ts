import type { CostCentreType, WorkSiteType } from '../../db/enums.js';
import { sum } from '../../common/utils/money.js';
import { casualPay, netSalary } from '../finance/finance.calc.js';

/** Pure payroll rules (FR-PAY-02, FR-PAY-05), unit-tested in tests/unit/payroll.calc.test.ts. */

export interface SalaryParts {
  basicSalary: number;
  allowances: number;
  deductions: number;
}

/** A payroll line for one employee; null when there is nothing to pay (net ≤ 0). */
export function payrollLine<T extends SalaryParts>(
  employee: T,
): (SalaryParts & { netPay: number }) | null {
  const netPay = netSalary(employee.basicSalary, employee.allowances, employee.deductions);
  if (netPay <= 0) return null;
  return {
    basicSalary: employee.basicSalary,
    allowances: employee.allowances,
    deductions: employee.deductions,
    netPay,
  };
}

export interface AttendanceTally {
  workerId: number;
  daysPresent: number;
  dailyRate: number;
  siteType: WorkSiteType;
  projectId: number | null;
}

/** BRL-05 / US-OA-007 AC1: one item per worker with at least one day present; pay = days × rate. */
export function casualPayLines(tallies: readonly AttendanceTally[]) {
  const items = tallies
    .filter((t) => t.daysPresent > 0)
    .map((t) => ({ ...t, amount: casualPay(t.daysPresent, t.dailyRate) }));
  return { items, total: sum(items.map((i) => i.amount)) };
}

/** FR-PAY-06: where a worker's pay is charged — the farm, or the project they work on. */
export function siteCostCentre(
  siteType: WorkSiteType,
  projectId: number | null,
): { costCentreType: CostCentreType; projectId: number | null } {
  return siteType === 'project'
    ? { costCentreType: 'project', projectId }
    : { costCentreType: 'farm', projectId: null };
}

/** Attendance cannot be recorded for future dates (US-FM-004). */
export function isFutureDate(date: string, todayIso: string): boolean {
  return date > todayIso;
}
