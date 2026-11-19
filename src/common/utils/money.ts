/** Rounds to 2 decimal places, avoiding binary floating point drift (e.g. 0.1 + 0.2). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sum(values: readonly number[]): number {
  return round2(values.reduce((acc, v) => acc + v, 0));
}

/** Percentage (0-100, 1 decimal) or null when the base is zero. */
export function percent(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** MySQL SUM() over DECIMAL returns a string (or null); normalise to number. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
