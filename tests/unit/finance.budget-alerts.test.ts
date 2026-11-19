import { describe, expect, it } from 'vitest';
import {
  bucketStart,
  bucketStarts,
  crossedBudgetLevel,
  loanUtilisation,
  periodRange,
} from '../../src/modules/finance/finance.calc.js';

describe('crossedBudgetLevel (US-OA-004 AC2)', () => {
  it('alerts amber when spending crosses 80 %', () => {
    expect(crossedBudgetLevel(1000, 700, 850)).toBe('amber');
    expect(crossedBudgetLevel(1000, 799.99, 800)).toBe('amber');
  });

  it('alerts red when spending crosses 100 %, even straight from ok', () => {
    expect(crossedBudgetLevel(1000, 900, 1000)).toBe('red');
    expect(crossedBudgetLevel(1000, 100, 1500)).toBe('red');
  });

  it('stays quiet when no threshold is crossed', () => {
    expect(crossedBudgetLevel(1000, 100, 500)).toBeNull();
    expect(crossedBudgetLevel(1000, 850, 900)).toBeNull(); // already amber
    expect(crossedBudgetLevel(1000, 1200, 1300)).toBeNull(); // already red
  });

  it('never alerts on an empty budget', () => {
    expect(crossedBudgetLevel(0, 0, 500)).toBeNull();
  });
});

describe('cash-flow buckets (FR-FIN-09)', () => {
  it('maps a date to its day, ISO week (Monday) or month', () => {
    expect(bucketStart('2026-11-18', 'day')).toBe('2026-11-18');
    expect(bucketStart('2026-11-18', 'week')).toBe('2026-11-16'); // Wednesday → Monday
    expect(bucketStart('2026-11-16', 'week')).toBe('2026-11-16');
    expect(bucketStart('2026-11-22', 'week')).toBe('2026-11-16'); // Sunday
    expect(bucketStart('2026-11-18', 'month')).toBe('2026-11-01');
  });

  it('lists every bucket in the range, including empty ones', () => {
    expect(bucketStarts('2026-01-15', '2026-04-02', 'month')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
    expect(bucketStarts('2026-11-01', '2026-11-03', 'day')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(bucketStarts('2026-11-18', '2026-11-30', 'week')).toEqual([
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ]);
    expect(bucketStarts('2026-12-01', '2026-11-01', 'day')).toEqual([]);
  });

  it('handles month-end and year rollover', () => {
    expect(bucketStarts('2025-12-31', '2026-01-31', 'month')).toEqual(['2025-12-01', '2026-01-01']);
  });
});

describe('loanUtilisation (US-OA-008, BRL-06)', () => {
  it('reports used, unused and outstanding balance', () => {
    expect(loanUtilisation(10_000_000, 500_000, 4_000_000, 2_000_000)).toEqual({
      used: 4_000_000,
      unused: 6_000_000,
      repaid: 2_000_000,
      balance: 8_500_000,
      usedPct: 40,
    });
  });
});

describe('periodRange', () => {
  it('returns the first and last day of a payroll month', () => {
    expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
