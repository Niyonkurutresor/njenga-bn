import { percent, round2 } from '../../common/utils/money.js';
import type { ProjectStatus } from '../../db/enums.js';

/**
 * Pure helpers for dashboard aggregation (FR-DSH-01..05). No I/O, so they are unit-tested
 * and shared with the reports module.
 */

export interface Period {
  from: string;
  to: string;
}

/** First and last day of the month containing `isoDate` (YYYY-MM-DD). */
export function monthOf(isoDate: string): Period {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/**
 * Resolves the dashboard/report period. Defaults to the current month (or `fallback`);
 * a lone `from` runs to today, a lone `to` starts on the first of its month; swapped
 * bounds are put back in order.
 */
export function resolvePeriod(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
  fallback: 'month' | 'day' = 'month',
): Period {
  if (!query.from && !query.to) {
    return fallback === 'day' ? { from: today, to: today } : monthOf(today);
  }
  const from = query.from ?? monthOf(query.to!).from;
  const to = query.to ?? (from > today ? from : today);
  return from <= to ? { from, to } : { from: to, to: from };
}

/** The `n` month keys (YYYY-MM) ending with the month of `endIso`, oldest first. */
export function lastMonths(endIso: string, n = 12): string[] {
  const [y, m] = endIso.split('-').map(Number) as [number, number];
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/**
 * Turns sparse SQL month rows into a dense series (missing months = 0) for charts.
 * @example fillMonthly(['2026-01','2026-02'], [{ month: '2026-02', income: 5 }], ['income'])
 *   → [{ month: '2026-01', income: 0 }, { month: '2026-02', income: 5 }]
 */
export function fillMonthly<K extends string>(
  months: readonly string[],
  rows: readonly ({ month: string } & Partial<Record<K, unknown>>)[],
  keys: readonly K[],
): ({ month: string } & Record<K, number>)[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return months.map((month) => {
    const row = byMonth.get(month);
    const out = { month } as { month: string } & Record<K, number>;
    for (const k of keys) {
      (out as Record<string, unknown>)[k] = round2(Number(row?.[k] ?? 0) || 0);
    }
    return out;
  });
}

/** Statuses after which a project no longer counts as running. */
export const FINISHED_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'completed',
  'pl_analysed',
  'closed',
];

/** FR-PRJ-06: delayed when the end date has passed and the project is not completed. */
export function isProjectDelayed(
  endDate: string | null,
  status: ProjectStatus,
  today: string,
): boolean {
  return Boolean(endDate && endDate < today && !FINISHED_PROJECT_STATUSES.includes(status));
}

/**
 * FR-PRJ-05: % complete from completed tasks and the latest verified progress report.
 * Uses the average of the measures that exist; 0 when neither exists.
 */
export function projectPercentComplete(
  tasksDone: number,
  tasksTotal: number,
  latestVerifiedPct: number | null,
): number {
  const measures: number[] = [];
  if (tasksTotal > 0) measures.push((tasksDone / tasksTotal) * 100);
  if (latestVerifiedPct !== null && latestVerifiedPct !== undefined) {
    measures.push(Math.max(0, Math.min(100, latestVerifiedPct)));
  }
  if (!measures.length) return 0;
  return Math.round(measures.reduce((a, b) => a + b, 0) / measures.length);
}

/** BRL-03 ranking: best `n` and worst `n` by profit (worst list excludes the best ones). */
export function rankByProfit<T extends { profit: number }>(
  rows: readonly T[],
  n = 5,
): { top: T[]; bottom: T[] } {
  const sorted = [...rows].sort((a, b) => b.profit - a.profit);
  const top = sorted.slice(0, n);
  const rest = sorted.slice(top.length);
  const bottom = rest.slice(-n).reverse();
  return { top, bottom };
}

/** FR-BDV-07 win rate (%): won ÷ (won + lost); null when nothing has closed. */
export function winRate(won: number, lost: number): number | null {
  return percent(won, won + lost);
}

/** Builds a frontend link with a query string, skipping empty values. */
export function linkTo(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

/** Counts rows per key, returning every expected key (0 when absent). */
export function countBy<K extends string>(
  keys: readonly K[],
  rows: readonly { key: string | null; n: unknown }[],
): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of rows) {
    if (r.key && (keys as readonly string[]).includes(r.key)) out[r.key as K] = Number(r.n) || 0;
  }
  return out;
}
