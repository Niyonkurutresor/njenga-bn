import { describe, expect, it } from 'vitest';
import {
  canRateProject,
  conversionError,
  isOpenStage,
  stageChangeError,
  winRate,
} from '../../src/modules/crm/crm.rules.js';

describe('CRM rules (SRS 3.9)', () => {
  it('win rate = won ÷ (won + lost) (FR-BDV-07)', () => {
    expect(winRate(3, 1)).toBe(75);
    expect(winRate(1, 2)).toBe(33.3);
    expect(winRate(0, 0)).toBeNull();
    expect(winRate(0, 4)).toBe(0);
  });

  it('only new → negotiation are open stages', () => {
    expect(isOpenStage('negotiation')).toBe(true);
    expect(isOpenStage('won')).toBe(false);
    expect(isOpenStage('lost')).toBe(false);
  });

  it('Lost requires a reason (FR-BDV-02)', () => {
    const lead = { stage: 'negotiation' as const, convertedAt: null };
    expect(stageChangeError(lead, 'lost')).toMatch(/reason/);
    expect(stageChangeError(lead, 'lost', '  ')).toMatch(/reason/);
    expect(stageChangeError(lead, 'lost', 'Price too high')).toBeNull();
  });

  it('a lost lead can be reopened, a converted lead is final', () => {
    expect(stageChangeError({ stage: 'lost', convertedAt: null }, 'contacted')).toBeNull();
    expect(stageChangeError({ stage: 'won', convertedAt: new Date() }, 'lost', 'x')).toMatch(
      /converted/,
    );
    expect(stageChangeError({ stage: 'new', convertedAt: null }, 'new')).toMatch(/already/);
  });

  it('only won, unconverted leads convert (FR-BDV-04)', () => {
    expect(conversionError({ stage: 'won', convertedAt: null })).toBeNull();
    expect(conversionError({ stage: 'negotiation', convertedAt: null })).toMatch(/won/);
    expect(conversionError({ stage: 'won', convertedAt: new Date() })).toMatch(/already/);
  });

  it('satisfaction only after completion (FR-BDV-08)', () => {
    expect(canRateProject('completed')).toBe(true);
    expect(canRateProject('pl_analysed')).toBe(true);
    expect(canRateProject('closed')).toBe(true);
    expect(canRateProject('in_execution')).toBe(false);
  });
});
