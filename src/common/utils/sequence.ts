import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';

/**
 * Atomically increments a named counter and returns the new value.
 * Uses MySQL's LAST_INSERT_ID(expr) trick so it is safe under concurrency.
 */
export async function nextSequence(tx: Executor, name: string): Promise<number> {
  await tx.execute(
    sql`INSERT INTO sequences (name, value) VALUES (${name}, LAST_INSERT_ID(1))
        ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)`,
  );
  const [rows] = (await tx.execute(sql`SELECT LAST_INSERT_ID() AS v`)) as unknown as [
    { v: number | string }[],
  ];
  return Number(rows[0]?.v);
}

/** e.g. formatReference('REQ', 2026, 7, 4) → "REQ-2026-0007". */
export function formatReference(prefix: string, year: number, value: number, pad = 4): string {
  return `${prefix}-${year}-${String(value).padStart(pad, '0')}`;
}

/** Next yearly reference, e.g. REQ-2026-0001. */
export async function nextReference(
  tx: Executor,
  prefix: string,
  pad = 4,
  date = new Date(),
): Promise<string> {
  const year = date.getUTCFullYear();
  const value = await nextSequence(tx, `${prefix}-${year}`);
  return formatReference(prefix, year, value, pad);
}
