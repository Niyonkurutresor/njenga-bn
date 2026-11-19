import type { Response } from 'express';
import { writeReportPdf, writeReportXlsx } from '../reports/reports.export.js';
import { exportFilename } from '../reports/reports.format.js';
import type {
  ReportColumn,
  ReportResult,
  ReportRow,
  ReportTable,
  SummaryItem,
} from '../reports/report.types.js';
import { BOOK_ROW_LIMIT, bookPeriod, booksService, type BookEntry } from './books.service.js';
import type { BookExportQuery, BookKey } from './finance.schema.js';

/** Excel / PDF exports of the finance books, rendered by the shared report writers (FR-RPT-03). */

const TITLES: Record<BookKey, string> = {
  'day-book': 'Day book (journal)',
  'cash-book': 'Cash book',
  'general-ledger': 'General ledger',
  'trial-balance': 'Trial balance',
  'income-statement': 'Income statement',
  'cash-flow-statement': 'Cash flow statement',
  'budget-vs-actual': 'Budget vs actual',
  'loan-register': 'Loan register',
};

const label = (v: string | null | undefined) =>
  v ? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '';

const entryColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'reference', label: 'Reference', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'costCentre', label: 'Cost centre', type: 'text' },
  { key: 'method', label: 'Method', type: 'text' },
  { key: 'moneyIn', label: 'Money in', type: 'money' },
  { key: 'moneyOut', label: 'Money out', type: 'money' },
];

function entryRow(e: BookEntry, extra: ReportRow = {}): ReportRow {
  return {
    date: e.transactionDate,
    reference: e.reference,
    description: e.description,
    source: label(e.source),
    category: e.category,
    costCentre: e.project?.code ?? label(e.costCentreType),
    method: label(e.paymentMethod),
    moneyIn: e.moneyIn || null,
    moneyOut: e.moneyOut || null,
    recordedBy: e.recordedBy.name,
    ...extra,
  };
}

const truncatedNote = (truncated: boolean): SummaryItem[] =>
  truncated
    ? [
        {
          label: 'Note',
          value: `Only the first ${BOOK_ROW_LIMIT} entries are included`,
          type: 'text',
        },
      ]
    : [];

async function build(
  book: BookKey,
  query: BookExportQuery,
): Promise<{ data: Omit<ReportResult, 'key' | 'title' | 'generatedAt' | 'filters'> }> {
  const period = bookPeriod(query);
  switch (book) {
    case 'day-book': {
      const r = await booksService.dayBookAll(query);
      return {
        data: {
          period,
          columns: [...entryColumns, { key: 'recordedBy', label: 'Recorded by', type: 'text' }],
          rows: r.entries.map((e) => entryRow(e)),
          totals: { date: null, reference: 'Total', moneyIn: r.totalIn, moneyOut: r.totalOut },
          summary: [
            { label: 'Entries', value: r.entries.length, type: 'number' },
            { label: 'Money in', value: r.totalIn, type: 'money' },
            { label: 'Money out', value: r.totalOut, type: 'money' },
            ...truncatedNote(r.truncated),
          ],
        },
      };
    }
    case 'cash-book': {
      const r = await booksService.cashBook(query);
      const methods: ReportTable = {
        key: 'methods',
        title: 'By payment method',
        columns: [
          { key: 'method', label: 'Payment method', type: 'text' },
          { key: 'opening', label: 'Opening', type: 'money' },
          { key: 'moneyIn', label: 'Money in', type: 'money' },
          { key: 'moneyOut', label: 'Money out', type: 'money' },
          { key: 'closing', label: 'Closing', type: 'money' },
        ],
        rows: r.byMethod.map((m) => ({
          method: m.paymentMethod ? label(m.paymentMethod) : 'Not specified',
          opening: m.opening,
          moneyIn: m.moneyIn,
          moneyOut: m.moneyOut,
          closing: m.closing,
        })),
        totals: {
          method: 'Total',
          opening: r.openingBalance,
          moneyIn: r.totalIn,
          moneyOut: r.totalOut,
          closing: r.closingBalance,
        },
      };
      return {
        data: {
          period,
          columns: [...entryColumns, { key: 'balance', label: 'Balance', type: 'money' }],
          rows: [
            { date: period.from, description: 'Opening balance', balance: r.openingBalance },
            ...r.entries.map((e) => entryRow(e, { balance: e.balance })),
          ],
          totals: {
            reference: 'Closing',
            moneyIn: r.totalIn,
            moneyOut: r.totalOut,
            balance: r.closingBalance,
          },
          summary: [
            { label: 'Opening balance', value: r.openingBalance, type: 'money' },
            { label: 'Money in', value: r.totalIn, type: 'money' },
            { label: 'Money out', value: r.totalOut, type: 'money' },
            { label: 'Closing balance', value: r.closingBalance, type: 'money' },
            ...truncatedNote(r.truncated),
          ],
          sections: [methods],
        },
      };
    }
    case 'general-ledger': {
      const r = await booksService.generalLedger(query);
      const columns: ReportColumn[] = [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'reference', label: 'Reference', type: 'text' },
        { key: 'description', label: 'Description', type: 'text' },
        { key: 'source', label: 'Source', type: 'text' },
        { key: 'costCentre', label: 'Cost centre', type: 'text' },
        { key: 'debit', label: 'Debit (out)', type: 'money' },
        { key: 'credit', label: 'Credit (in)', type: 'money' },
        { key: 'balance', label: 'Balance', type: 'money' },
      ];
      return {
        data: {
          period,
          columns: [
            { key: 'account', label: 'Account', type: 'text' },
            { key: 'opening', label: 'Opening', type: 'money' },
            { key: 'debit', label: 'Debit (out)', type: 'money' },
            { key: 'credit', label: 'Credit (in)', type: 'money' },
            { key: 'closing', label: 'Closing', type: 'money' },
          ],
          rows: r.accounts.map((a) => ({
            account: a.account,
            opening: a.opening,
            debit: a.debit,
            credit: a.credit,
            closing: a.closing,
          })),
          totals: { account: 'Total', ...r.totals },
          summary: [
            { label: 'Accounts', value: r.accounts.length, type: 'number' },
            { label: 'Debits', value: r.totals.debit, type: 'money' },
            { label: 'Credits', value: r.totals.credit, type: 'money' },
            ...truncatedNote(r.truncated),
          ],
          sections: r.accounts.map((a, i) => ({
            key: `acc-${i}`,
            title: a.account,
            columns,
            rows: [
              { date: period.from, description: 'Opening balance', balance: a.opening },
              ...a.entries.map((e) => ({
                date: e.transactionDate,
                reference: e.reference,
                description: e.description,
                source: label(e.source),
                costCentre: e.project?.code ?? label(e.costCentreType),
                debit: e.moneyOut || null,
                credit: e.moneyIn || null,
                balance: e.balance,
              })),
            ],
            totals: { reference: 'Closing', debit: a.debit, credit: a.credit, balance: a.closing },
          })),
        },
      };
    }
    case 'trial-balance': {
      const r = await booksService.trialBalance(query);
      return {
        data: {
          period,
          columns: [
            { key: 'account', label: 'Account', type: 'text' },
            { key: 'debit', label: 'Debit', type: 'money' },
            { key: 'credit', label: 'Credit', type: 'money' },
          ],
          rows: r.rows.map((row) => ({
            account: row.account,
            debit: row.debit,
            credit: row.credit,
          })),
          totals: { account: 'Total', debit: r.totalDebit, credit: r.totalCredit },
          summary: [
            { label: 'Total debits', value: r.totalDebit, type: 'money' },
            { label: 'Total credits', value: r.totalCredit, type: 'money' },
            {
              label: 'Check',
              value: r.balanced ? 'Balanced' : `Out by ${r.difference}`,
              type: 'text',
            },
            { label: 'Basis', value: r.note, type: 'text' },
          ],
        },
      };
    }
    case 'income-statement': {
      const r = await booksService.incomeStatement(query);
      const lines = (title: string, items: { category: string; amount: number }[]) =>
        items.map((c) => ({ section: title, line: c.category, amount: c.amount }));
      return {
        data: {
          period,
          columns: [
            { key: 'section', label: 'Section', type: 'text' },
            { key: 'line', label: 'Line', type: 'text' },
            { key: 'amount', label: 'Amount', type: 'money' },
          ],
          rows: [
            ...lines('Income', r.income.byCategory),
            { section: 'Income', line: 'Total income', amount: r.income.total },
            ...lines('Costs', r.costs.byCategory),
            { section: 'Costs', line: 'Total costs', amount: r.costs.total },
          ],
          totals: { section: 'Profit / (loss)', amount: r.profit },
          summary: [
            { label: 'Income', value: r.income.total, type: 'money' },
            { label: 'Costs', value: r.costs.total, type: 'money' },
            { label: 'Profit / (loss)', value: r.profit, type: 'money' },
            { label: 'Margin', value: r.marginPct, type: 'percent' },
          ],
          sections: [
            {
              key: 'areas',
              title: 'By area',
              columns: [
                { key: 'area', label: 'Area', type: 'text' },
                { key: 'income', label: 'Income', type: 'money' },
                { key: 'costs', label: 'Costs', type: 'money' },
                { key: 'profit', label: 'Profit', type: 'money' },
              ],
              rows: r.byArea.map((a) => ({ ...a, area: label(a.area) })),
              totals: null,
            },
          ],
        },
      };
    }
    case 'cash-flow-statement': {
      const r = await booksService.cashFlowStatement(query);
      const section = (name: string, s: typeof r.operating): ReportRow[] => [
        ...s.inflows.map((l) => ({ activity: name, line: `In: ${l.category}`, amount: l.amount })),
        ...s.outflows.map((l) => ({
          activity: name,
          line: `Out: ${l.category}`,
          amount: -l.amount,
        })),
        { activity: name, line: `Net cash from ${name.toLowerCase()} activities`, amount: s.net },
      ];
      return {
        data: {
          period,
          columns: [
            { key: 'activity', label: 'Activity', type: 'text' },
            { key: 'line', label: 'Line', type: 'text' },
            { key: 'amount', label: 'Amount', type: 'money' },
          ],
          rows: [
            { activity: '', line: 'Opening cash', amount: r.openingCash },
            ...section('Operating', r.operating),
            ...section('Financing', r.financing),
            { activity: '', line: 'Net change in cash', amount: r.netChange },
          ],
          totals: { line: 'Closing cash', amount: r.closingCash },
          summary: [
            { label: 'Opening cash', value: r.openingCash, type: 'money' },
            { label: 'Net change', value: r.netChange, type: 'money' },
            { label: 'Closing cash', value: r.closingCash, type: 'money' },
          ],
          sections: [
            {
              key: 'series',
              title: `By ${r.interval}`,
              columns: [
                { key: 'period', label: 'Period', type: 'date' },
                { key: 'in', label: 'Money in', type: 'money' },
                { key: 'out', label: 'Money out', type: 'money' },
                { key: 'net', label: 'Net', type: 'money' },
              ],
              rows: r.series.map((s) => ({ period: s.period, in: s.in, out: s.out, net: s.net })),
              totals: null,
            },
          ],
        },
      };
    }
    case 'budget-vs-actual': {
      const r = await booksService.budgetVsActual(query);
      return {
        data: {
          period,
          columns: [
            { key: 'name', label: 'Budget', type: 'text' },
            { key: 'centre', label: 'Cost centre', type: 'text' },
            { key: 'periodLabel', label: 'Period', type: 'text' },
            { key: 'budget', label: 'Budget', type: 'money' },
            { key: 'spent', label: 'Actual', type: 'money' },
            { key: 'remaining', label: 'Remaining', type: 'money' },
            { key: 'usedPct', label: 'Used', type: 'percent' },
            { key: 'level', label: 'Status', type: 'text' },
          ],
          rows: r.budgets.map((b) => ({
            name: b.name,
            centre: b.project?.code ?? label(b.costCentreType),
            periodLabel: b.periodStart
              ? `${b.periodStart} to ${b.periodEnd ?? ''}`
              : 'Whole project',
            budget: b.usage.budget,
            spent: b.usage.spent,
            remaining: b.usage.remaining,
            usedPct: b.usage.usedPct,
            level:
              b.usage.level === 'ok'
                ? 'On track'
                : b.usage.level === 'amber'
                  ? 'Warning'
                  : 'Over budget',
          })),
          totals: { name: 'Total', ...r.totals },
          summary: [
            { label: 'Budgeted', value: r.totals.budget, type: 'money' },
            { label: 'Actual', value: r.totals.spent, type: 'money' },
            { label: 'Remaining', value: r.totals.remaining, type: 'money' },
          ],
        },
      };
    }
    case 'loan-register': {
      const r = await booksService.loanRegister();
      return {
        data: {
          period,
          columns: [
            { key: 'lender', label: 'Lender', type: 'text' },
            { key: 'startDate', label: 'Start', type: 'date' },
            { key: 'interestRate', label: 'Rate', type: 'percent' },
            { key: 'principal', label: 'Amount', type: 'money' },
            { key: 'received', label: 'Received', type: 'money' },
            { key: 'used', label: 'Used', type: 'money' },
            { key: 'unused', label: 'Unused', type: 'money' },
            { key: 'repaid', label: 'Repaid', type: 'money' },
            { key: 'balance', label: 'Balance', type: 'money' },
            { key: 'status', label: 'Status', type: 'text' },
          ],
          rows: r.loans.map((l) => ({
            lender: l.lender,
            startDate: l.startDate,
            interestRate: l.interestRate,
            principal: l.principal,
            received: l.received,
            used: l.used,
            unused: l.unused,
            repaid: l.repaid,
            balance: l.balance,
            status: label(l.status),
          })),
          totals: { lender: 'Total', ...r.totals },
          summary: [
            { label: 'Loans', value: r.loans.length, type: 'number' },
            { label: 'Outstanding', value: r.totals.balance, type: 'money' },
          ],
        },
      };
    }
  }
}

/** Streams a book as PDF or Excel. */
export async function exportBook(book: BookKey, query: BookExportQuery, res: Response) {
  const { data } = await build(book, query);
  const { format, page: _p, pageSize: _s, sortDir: _d, interval: _i, ...filters } = query;
  const report: ReportResult = {
    ...data,
    key: book,
    title: TITLES[book],
    generatedAt: new Date().toISOString(),
    filters: Object.fromEntries(
      Object.entries(filters).filter(([k]) => k !== 'from' && k !== 'to'),
    ),
  };
  res.setHeader(
    'Content-Type',
    format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${exportFilename(book, data.period.from, data.period.to, format)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'pdf') await writeReportPdf(report, res);
  else await writeReportXlsx(report, res);
}
