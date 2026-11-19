import { describe, expect, it } from 'vitest';
import {
  becameHigh,
  healthCounts,
  isFollowUpDue,
  isOpenCase,
  summariseHarvests,
  worstSeverity,
  type HarvestAggRow,
} from '../../src/modules/farm/farm.calc.js';

const row = (o: Partial<HarvestAggRow>): HarvestAggRow => ({
  crop: 'Tomato',
  greenhouseId: 1,
  greenhouseName: 'GH-1',
  month: '2026-10',
  unit: 'kg',
  grade: 'A',
  quantity: 10,
  ...o,
});

describe('high-severity alerts (FR-FRM-07)', () => {
  it('fires when severity becomes high', () => {
    expect(becameHigh(undefined, 'high')).toBe(true);
    expect(becameHigh('medium', 'high')).toBe(true);
  });
  it('does not fire again on re-save, or for lower severities', () => {
    expect(becameHigh('high', 'high')).toBe(false);
    expect(becameHigh(undefined, 'medium')).toBe(false);
  });
});

describe('inspection follow-ups', () => {
  it('is due on or before the date while not closed', () => {
    expect(isFollowUpDue('2026-11-18', 'open', '2026-11-18')).toBe(true);
    expect(isFollowUpDue('2026-11-10', 'treated', '2026-11-18')).toBe(true);
    expect(isFollowUpDue('2026-11-19', 'open', '2026-11-18')).toBe(false);
    expect(isFollowUpDue('2026-11-10', 'closed', '2026-11-18')).toBe(false);
    expect(isFollowUpDue(null, 'open', '2026-11-18')).toBe(false);
  });
  it('open cases exclude clean and closed inspections', () => {
    expect(isOpenCase('low', 'treated')).toBe(true);
    expect(isOpenCase('none', 'open')).toBe(false);
    expect(isOpenCase('high', 'closed')).toBe(false);
  });
});

describe('harvest summary (FR-FRM-09)', () => {
  const s = summariseHarvests([
    row({ quantity: 10 }),
    row({ quantity: 5.5, grade: 'B' }),
    row({ quantity: 200, unit: 'units', crop: 'Lettuce', greenhouseId: 2, greenhouseName: 'GH-2' }),
    row({ quantity: 4, month: '2026-11' }),
  ]);

  it('keeps kg and units separate', () => {
    expect(s.totals).toEqual({ kg: 19.5, units: 200 });
  });
  it('totals by crop with grade split', () => {
    const tomato = s.byCrop.find((c) => c.crop === 'Tomato')!;
    expect(tomato.kg).toBe(19.5);
    expect(tomato.grades.A.kg).toBe(14);
    expect(tomato.grades.B.kg).toBe(5.5);
    expect(s.byCrop[0]!.crop).toBe('Tomato');
  });
  it('totals by greenhouse and month', () => {
    expect(s.byGreenhouse.map((g) => g.name)).toEqual(['GH-1', 'GH-2']);
    expect(s.monthly.map((m) => [m.month, m.kg, m.units])).toEqual([
      ['2026-10', 15.5, 200],
      ['2026-11', 4, 0],
    ]);
    expect(s.monthlyByCrop).toHaveLength(3);
    expect(s.byGrade.find((g) => g.grade === 'reject')).toEqual({
      grade: 'reject',
      kg: 0,
      units: 0,
    });
  });
  it('handles no data', () => {
    expect(summariseHarvests([]).totals).toEqual({ kg: 0, units: 0 });
  });
});

describe('crop health helpers', () => {
  it('counts health including unknown', () => {
    expect(healthCounts(['good', 'poor', null, 'good'])).toEqual({
      good: 2,
      fair: 0,
      poor: 1,
      unknown: 1,
    });
  });
  it('finds the worst severity', () => {
    expect(worstSeverity([])).toBe('none');
    expect(worstSeverity(['low', 'high', 'medium'])).toBe('high');
  });
});
