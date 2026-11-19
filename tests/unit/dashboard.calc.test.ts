import { describe, expect, it } from 'vitest';
import {
  countBy,
  fillMonthly,
  isProjectDelayed,
  lastMonths,
  linkTo,
  monthOf,
  projectPercentComplete,
  rankByProfit,
  resolvePeriod,
  winRate,
} from '../../src/modules/dashboard/dashboard.calc.js';

describe('resolvePeriod (FR-DSH-03)', () => {
  it('defaults to the current month', () => {
    expect(resolvePeriod({}, '2026-11-18')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('defaults daily reports to today', () => {
    expect(resolvePeriod({}, '2026-11-18', 'day')).toEqual({
      from: '2026-11-18',
      to: '2026-11-18',
    });
  });

  it('fills a missing bound and orders swapped bounds', () => {
    expect(resolvePeriod({ from: '2026-10-05' }, '2026-11-18')).toEqual({
      from: '2026-10-05',
      to: '2026-11-18',
    });
    expect(resolvePeriod({ to: '2026-02-10' }, '2026-11-18')).toEqual({
      from: '2026-02-01',
      to: '2026-02-10',
    });
    expect(resolvePeriod({ from: '2026-11-30', to: '2026-11-01' }, '2026-11-18')).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
    });
  });

  it('handles leap-year months', () => {
    expect(monthOf('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('monthly series (FR-DSH-04)', () => {
  it('lists the last n months across a year boundary', () => {
    expect(lastMonths('2026-02-15', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(lastMonths('2026-11-18')).toHaveLength(12);
  });

  it('fills missing months with zero and coerces SQL strings', () => {
    const series = fillMonthly(
      ['2026-01', '2026-02', '2026-03'],
      [{ month: '2026-02', income: '1500.50', expenses: 200 }],
      ['income', 'expenses'] as const,
    );
    expect(series).toEqual([
      { month: '2026-01', income: 0, expenses: 0 },
      { month: '2026-02', income: 1500.5, expenses: 200 },
      { month: '2026-03', income: 0, expenses: 0 },
    ]);
  });
});

describe('projects (FR-PRJ-05/06, BRL-03)', () => {
  it('flags delayed only when the end date passed and not completed', () => {
    expect(isProjectDelayed('2026-11-17', 'in_execution', '2026-11-18')).toBe(true);
    expect(isProjectDelayed('2026-11-18', 'in_execution', '2026-11-18')).toBe(false);
    expect(isProjectDelayed('2026-01-01', 'completed', '2026-11-18')).toBe(false);
    expect(isProjectDelayed('2026-01-01', 'closed', '2026-11-18')).toBe(false);
    expect(isProjectDelayed(null, 'in_execution', '2026-11-18')).toBe(false);
  });

  it('averages task completion and the latest verified report', () => {
    expect(projectPercentComplete(0, 0, null)).toBe(0);
    expect(projectPercentComplete(1, 4, null)).toBe(25);
    expect(projectPercentComplete(0, 0, 60)).toBe(60);
    expect(projectPercentComplete(1, 2, 70)).toBe(60);
    expect(projectPercentComplete(0, 0, 140)).toBe(100);
  });

  it('ranks best and worst without overlap', () => {
    const rows = [5, -3, 10, 0, 7].map((profit, id) => ({ id, profit }));
    const { top, bottom } = rankByProfit(rows, 2);
    expect(top.map((r) => r.profit)).toEqual([10, 7]);
    expect(bottom.map((r) => r.profit)).toEqual([-3, 0]);
    expect(rankByProfit(rows.slice(0, 2), 5)).toEqual({ top: [rows[0], rows[1]], bottom: [] });
  });
});

describe('misc helpers', () => {
  it('computes win rate', () => {
    expect(winRate(3, 1)).toBe(75);
    expect(winRate(0, 0)).toBeNull();
  });

  it('builds links without empty params', () => {
    expect(
      linkTo('/finance/transactions', { direction: 'out', from: '2026-11-01', x: undefined }),
    ).toBe('/finance/transactions?direction=out&from=2026-11-01');
    expect(linkTo('/projects')).toBe('/projects');
  });

  it('counts every expected key', () => {
    expect(
      countBy(['good', 'fair', 'poor'] as const, [
        { key: 'good', n: '3' },
        { key: 'other', n: 9 },
      ]),
    ).toEqual({ good: 3, fair: 0, poor: 0 });
  });
});
