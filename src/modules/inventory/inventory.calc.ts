/** Pure stock maths (FR-INV-01..04), unit-tested. */

const round3 = (v: number) => Math.round((v + Number.EPSILON) * 1000) / 1000;
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Weighted average unit cost after receiving `qty` at `unitCost`. */
export function weightedAverageCost(
  onHand: number,
  averageCost: number,
  qty: number,
  unitCost: number,
): number {
  const base = Math.max(0, onHand);
  const total = base + qty;
  if (total <= 0) return round2(unitCost);
  return round2((base * averageCost + qty * unitCost) / total);
}

export function addQuantity(onHand: number, delta: number): number {
  return round3(onHand + delta);
}

/** Cost of an issue at the current average cost (FR-INV-03). */
export function issueCost(averageCost: number, qty: number): number {
  return round2(averageCost * qty);
}

/** Below the reorder level (FR-INV-04). A zero reorder level never flags. */
export function isLowStock(onHand: number, reorderLevel: number): boolean {
  return reorderLevel > 0 && onHand < reorderLevel;
}

/**
 * What to do with the low-stock alert after a change:
 * `notify` when newly low and not yet notified, `clear` when back at/above the level.
 */
export function lowStockAction(
  onHand: number,
  reorderLevel: number,
  notifiedAt: Date | null,
): 'notify' | 'clear' | null {
  const low = isLowStock(onHand, reorderLevel);
  if (low && !notifiedAt) return 'notify';
  if (!low && notifiedAt) return 'clear';
  return null;
}
