import { round2 } from '../../common/utils/money.js';
import type { CellValue, ColumnType, ReportColumn, ReportRow } from './report.types.js';

/**
 * Pure helpers shared by report builders and the PDF / Excel writers (FR-RPT-01, FR-RPT-03).
 */

const moneyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-18" → "18 Nov 2026". Anything else is returned unchanged. */
export function formatDateLabel(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Text rendering of a cell, used by the PDF writer and column-width estimation. */
export function formatCell(value: CellValue | undefined, type: ColumnType): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? moneyFmt.format(Math.round(n)) : String(value);
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? numberFmt.format(n) : String(value);
    }
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${numberFmt.format(n)}%` : String(value);
    }
    case 'date':
      return formatDateLabel(String(value));
    default:
      return String(value);
  }
}

export function formatPeriod(from: string, to: string): string {
  return from === to ? formatDateLabel(from) : `${formatDateLabel(from)} – ${formatDateLabel(to)}`;
}

/**
 * Totals row: sums the given numeric columns (default: every money column).
 * The first column carries the "Total" label.
 */
export function computeTotals(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
  keys?: readonly string[],
): ReportRow | null {
  const sumKeys = keys ?? columns.filter((c) => c.type === 'money').map((c) => c.key);
  if (!sumKeys.length || !columns.length) return null;
  const totals: ReportRow = { [columns[0]!.key]: 'Total' };
  for (const k of sumKeys) {
    totals[k] = round2(rows.reduce((acc, r) => acc + (Number(r[k]) || 0), 0));
  }
  return totals;
}

/** `expenses-2026-11-01-2026-11-30.pdf` */
export function exportFilename(key: string, from: string, to: string, ext: 'pdf' | 'xlsx'): string {
  const safe = key.replace(/[^a-z0-9-]/gi, '');
  return `${safe}-${from}-${to}.${ext}`;
}

/** Excel column widths (characters) from the longest rendered value, clamped. */
export function columnWidths(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
  min = 8,
  max = 60,
): number[] {
  return columns.map((c) => {
    let longest = c.label.length;
    for (const r of rows) {
      const len = formatCell(r[c.key], c.type).length;
      if (len > longest) longest = len;
    }
    return Math.max(min, Math.min(max, longest + 2));
  });
}

/** Relative PDF column weights: free text gets more room than numbers and dates. */
export function pdfColumnWeights(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
): number[] {
  const widths = columnWidths(columns, rows.slice(0, 200), 6, 40);
  return widths.map((w, i) => (columns[i]!.type === 'text' ? w : Math.min(w, 16)));
}

/** Shares (percent, 1 decimal) of a total, safe for a zero total. */
export function share(part: number, total: number): number | null {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Truncates long free text for table cells. */
export function clip(value: string | null | undefined, max = 300): string | null {
  if (value === null || value === undefined) return null;
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
