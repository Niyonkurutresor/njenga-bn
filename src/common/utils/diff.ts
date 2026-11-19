/** Returns only the fields that changed, as `{ old, new }` value maps for the audit log. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { oldValues: Partial<T>; newValues: Partial<T> } | null {
  const oldValues: Partial<T> = {};
  const newValues: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const a = before[key];
    const b = after[key];
    if (b === undefined) continue;
    const same =
      a instanceof Date && b instanceof Date
        ? a.getTime() === b.getTime()
        : JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      oldValues[key] = a;
      newValues[key] = b as T[keyof T];
    }
  }
  return Object.keys(newValues).length ? { oldValues, newValues } : null;
}

/** Removes secrets before values are written to the audit log. */
export function redact<T extends Record<string, unknown>>(values: T): T {
  const copy: Record<string, unknown> = { ...values };
  for (const key of ['passwordHash', 'password', 'tokenHash']) {
    if (key in copy) copy[key] = '[redacted]';
  }
  return copy as T;
}
