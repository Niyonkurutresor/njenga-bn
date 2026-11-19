import { describe, expect, it } from 'vitest';
import {
  addQuantity,
  isLowStock,
  issueCost,
  lowStockAction,
  weightedAverageCost,
} from '../../src/modules/inventory/inventory.calc.js';

describe('inventory maths (SRS 3.10)', () => {
  it('weighted average cost on receipt', () => {
    expect(weightedAverageCost(0, 0, 10, 500)).toBe(500);
    expect(weightedAverageCost(10, 500, 10, 700)).toBe(600);
    expect(weightedAverageCost(3, 100, 1, 200)).toBe(125);
  });

  it('issue cost = average × quantity (FR-INV-03)', () => {
    expect(issueCost(600, 2.5)).toBe(1500);
    expect(issueCost(33.33, 3)).toBe(99.99);
  });

  it('quantities keep 3 decimals', () => {
    expect(addQuantity(0.1, 0.2)).toBe(0.3);
    expect(addQuantity(5, -5)).toBe(0);
  });

  it('low stock below the reorder level; level 0 never flags (FR-INV-04)', () => {
    expect(isLowStock(4, 5)).toBe(true);
    expect(isLowStock(5, 5)).toBe(false);
    expect(isLowStock(0, 0)).toBe(false);
  });

  it('alerts once and re-arms when restocked', () => {
    expect(lowStockAction(2, 5, null)).toBe('notify');
    expect(lowStockAction(2, 5, new Date())).toBeNull();
    expect(lowStockAction(8, 5, new Date())).toBe('clear');
    expect(lowStockAction(8, 5, null)).toBeNull();
  });
});
