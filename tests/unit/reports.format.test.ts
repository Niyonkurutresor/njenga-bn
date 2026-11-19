import { describe, expect, it } from 'vitest';
import {
  clip,
  columnWidths,
  computeTotals,
  exportFilename,
  formatCell,
  formatDateLabel,
  formatPeriod,
  share,
} from '../../src/modules/reports/reports.format.js';
import {
  isReportRequestOverdue,
  reportRequestActions,
} from '../../src/modules/reports/report-requests.rules.js';
import type { ReportColumn } from '../../src/modules/reports/report.types.js';

const columns: ReportColumn[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'count', label: 'Count', type: 'number' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'pct', label: 'Share', type: 'percent' },
];

describe('formatCell (FR-RPT-03)', () => {
  it('formats each column type', () => {
    expect(formatCell(1234567.4, 'money')).toBe('1,234,567');
    expect(formatCell('2500.5', 'money')).toBe('2,501');
    expect(formatCell(12.345, 'number')).toBe('12.35');
    expect(formatCell(42.5, 'percent')).toBe('42.5%');
    expect(formatCell('2026-11-08', 'date')).toBe('8 Nov 2026');
    expect(formatCell(null, 'money')).toBe('—');
    expect(formatCell('', 'text')).toBe('—');
    expect(formatCell('abc', 'number')).toBe('abc');
  });

  it('formats dates and periods', () => {
    expect(formatDateLabel('2026-01-31T10:00:00Z')).toBe('31 Jan 2026');
    expect(formatPeriod('2026-11-18', '2026-11-18')).toBe('18 Nov 2026');
    expect(formatPeriod('2026-11-01', '2026-11-30')).toBe('1 Nov 2026 – 30 Nov 2026');
  });
});

describe('computeTotals', () => {
  const rows = [
    { name: 'A', count: 2, amount: 100.1, pct: 50 },
    { name: 'B', count: 3, amount: 200.2, pct: 50 },
    { name: 'C', count: null, amount: null, pct: null },
  ];

  it('sums money columns by default with a Total label', () => {
    expect(computeTotals(columns, rows)).toEqual({ name: 'Total', amount: 300.3 });
  });

  it('sums the requested columns', () => {
    expect(computeTotals(columns, rows, ['count', 'amount'])).toEqual({
      name: 'Total',
      count: 5,
      amount: 300.3,
    });
  });

  it('returns null when there is nothing to total', () => {
    expect(computeTotals(columns, rows, [])).toBeNull();
    expect(computeTotals([{ key: 'x', label: 'X', type: 'text' }], [])).toBeNull();
  });

  it('handles empty data', () => {
    expect(computeTotals(columns, [])).toEqual({ name: 'Total', amount: 0 });
  });
});

describe('export helpers', () => {
  it('builds the attachment file name', () => {
    expect(exportFilename('expenses', '2026-11-01', '2026-11-30', 'pdf')).toBe(
      'expenses-2026-11-01-2026-11-30.pdf',
    );
    expect(exportFilename('../evil"key', '2026-11-01', '2026-11-01', 'xlsx')).toBe(
      'evilkey-2026-11-01-2026-11-01.xlsx',
    );
  });

  it('sizes columns from content, clamped', () => {
    const widths = columnWidths(columns, [
      { name: 'x'.repeat(100), count: 1, amount: 1_000_000, pct: 1 },
    ]);
    expect(widths[0]).toBe(60);
    expect(widths[1]).toBe(8);
    expect(widths[2]).toBe(11); // "1,000,000" + 2
  });

  it('computes shares safely and clips text', () => {
    expect(share(25, 200)).toBe(12.5);
    expect(share(5, 0)).toBeNull();
    expect(clip('  a   b  ')).toBe('a b');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip(null)).toBeNull();
  });
});

describe('report requests (FR-RPT-04)', () => {
  it('is overdue only while open past the due date', () => {
    expect(isReportRequestOverdue({ status: 'open', dueDate: '2026-11-17' }, '2026-11-18')).toBe(
      true,
    );
    expect(isReportRequestOverdue({ status: 'open', dueDate: '2026-11-18' }, '2026-11-18')).toBe(
      false,
    );
    expect(
      isReportRequestOverdue({ status: 'delivered', dueDate: '2026-01-01' }, '2026-11-18'),
    ).toBe(false);
    expect(isReportRequestOverdue({ status: 'open', dueDate: null }, '2026-11-18')).toBe(false);
  });

  it('offers deliver to the assignee and cancel to the requester', () => {
    const row = { status: 'open' as const, requestedBy: 1, assigneeId: 2 };
    expect(reportRequestActions({ id: 2 }, row)).toEqual(['deliver', 'attach']);
    expect(reportRequestActions({ id: 1 }, row)).toEqual(['cancel']);
    expect(reportRequestActions({ id: 3 }, row)).toEqual([]);
    expect(reportRequestActions({ id: 2 }, { ...row, status: 'delivered' })).toEqual([]);
  });
});
