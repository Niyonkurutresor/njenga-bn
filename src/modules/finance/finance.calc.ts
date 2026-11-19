import { percent, round2 } from '../../common/utils/money.js';

/**
 * Pure business-rule calculations (SRS 4.2). Kept free of I/O so they are unit-tested
 * and reused by services, dashboards and reports.
 */

export type BudgetLevel = 'ok' | 'amber' | 'red';

export interface BudgetUsage {
  budget: number;
  spent: number;
  remaining: number;
  /** null when there is no budget. */
  usedPct: number | null;
  level: BudgetLevel;
}

/** BRL-04: used % = spent ÷ budget × 100; amber at 80 %, red at 100 % (FR-FIN-05). */
export function budgetUsage(budget: number, spent: number): BudgetUsage {
  const usedPct = percent(spent, budget);
  let level: BudgetLevel = 'ok';
  if (budget <= 0) level = spent > 0 ? 'red' : 'ok';
  else if (spent >= budget) level = 'red';
  else if (spent >= budget * 0.8) level = 'amber';
  return {
    budget: round2(budget),
    spent: round2(spent),
    remaining: round2(budget - spent),
    usedPct,
    level,
  };
}

/** True when adding `amount` to `spent` exceeds `budget` (FR-REQ-10). */
export function wouldExceedBudget(budget: number, spent: number, amount: number): boolean {
  return round2(spent + amount) > round2(budget);
}

export interface ProjectProfit {
  contractValue: number;
  cost: number;
  profit: number;
  /** Margin % (1 decimal); null when contract value is 0. */
  marginPct: number | null;
}

/** BRL-03: profit = contract value − total recorded project costs; margin = profit ÷ value × 100. */
export function projectProfit(contractValue: number, cost: number): ProjectProfit {
  const profit = round2(contractValue - cost);
  return {
    contractValue: round2(contractValue),
    cost: round2(cost),
    profit,
    marginPct: percent(profit, contractValue),
  };
}

/** BRL-05: casual worker pay = days present × daily rate. */
export function casualPay(daysPresent: number, dailyRate: number): number {
  return round2(daysPresent * dailyRate);
}

/** BRL-06: loan balance = loan amount + interest charged − repayments. */
export function loanBalance(
  principal: number,
  interestCharged: number,
  repayments: number,
): number {
  return round2(principal + interestCharged - repayments);
}

/** Net salary = basic + allowances − deductions. */
export function netSalary(basic: number, allowances: number, deductions: number): number {
  return round2(basic + allowances - deductions);
}

/** FR-FIN-10 / BRL-09: payments are locked for editing 24 h after being recorded. */
export const PAYMENT_EDIT_WINDOW_HOURS = 24;

export function isPaymentLocked(recordedAt: Date, now = new Date()): boolean {
  return now.getTime() - recordedAt.getTime() > PAYMENT_EDIT_WINDOW_HOURS * 3_600_000;
}

const LEVEL_RANK: Record<BudgetLevel, number> = { ok: 0, amber: 1, red: 2 };

/**
 * US-OA-004 AC2: the budget level newly reached when spending moves from `spentBefore` to
 * `spentAfter` (amber at 80 %, red at 100 %), or null when no threshold was crossed.
 * Budgets of zero never alert (there is nothing to measure against).
 */
export function crossedBudgetLevel(
  budget: number,
  spentBefore: number,
  spentAfter: number,
): BudgetLevel | null {
  if (budget <= 0) return null;
  const before = budgetUsage(budget, spentBefore).level;
  const after = budgetUsage(budget, spentAfter).level;
  return LEVEL_RANK[after] > LEVEL_RANK[before] ? after : null;
}

export type CashFlowInterval = 'day' | 'week' | 'month';

/** Start of the bucket containing `isoDate`: the day, the Monday of its week, or the 1st of its month. */
export function bucketStart(isoDate: string, interval: CashFlowInterval): string {
  if (interval === 'day') return isoDate;
  if (interval === 'month') return `${isoDate.slice(0, 7)}-01`;
  const d = new Date(`${isoDate}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Every bucket start from `from` to `to` inclusive, so empty periods still appear in the series. */
export function bucketStarts(from: string, to: string, interval: CashFlowInterval): string[] {
  const out: string[] = [];
  if (from > to) return out;
  let cursor = bucketStart(from, interval);
  const last = bucketStart(to, interval);
  // Hard cap keeps a malicious range from building a huge array.
  while (cursor <= last && out.length < 1000) {
    out.push(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    if (interval === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return out;
}

/** Loan use of funds (US-OA-008): used, unused and outstanding balance (BRL-06). */
export function loanUtilisation(
  principal: number,
  interestCharged: number,
  used: number,
  repaid: number,
): { used: number; unused: number; repaid: number; balance: number; usedPct: number | null } {
  return {
    used: round2(used),
    unused: round2(principal - used),
    repaid: round2(repaid),
    balance: loanBalance(principal, interestCharged, repaid),
    usedPct: percent(used, principal),
  };
}

/** First and last day of a payroll period `YYYY-MM`. */
export function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
