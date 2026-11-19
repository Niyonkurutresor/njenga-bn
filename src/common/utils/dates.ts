import { env } from '../../config/env.js';

/** Today's date (YYYY-MM-DD) in the company timezone. */
export function today(): string {
  return toLocalDate(new Date());
}

/** Formats a Date as YYYY-MM-DD in the company timezone. */
export function toLocalDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First and last day of the month containing `isoDate`. */
export function monthRange(isoDate: string): { from: string; to: string } {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000;
}
