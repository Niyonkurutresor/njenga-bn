import { and, asc, between, eq, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { db } from '../../../db/client.js';
import { categories, loans, projects, transactions } from '../../../db/schema/index.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { loanBalance } from '../../finance/finance.calc.js';
import { clip, computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { centreLabel, labelOf, noFilters } from './_shared.js';

const columns: ReportColumn[] = [
  { key: 'lender', label: 'Lender', type: 'text' },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'interestRate', label: 'Interest rate', type: 'percent' },
  { key: 'principal', label: 'Loan amount', type: 'money' },
  { key: 'used', label: 'Amount used', type: 'money' },
  { key: 'unused', label: 'Unused balance', type: 'money' },
  { key: 'interestCharged', label: 'Interest charged', type: 'money' },
  { key: 'repaid', label: 'Repayments', type: 'money' },
  { key: 'outstanding', label: 'Outstanding', type: 'money' },
  { key: 'status', label: 'Status', type: 'text' },
];

const useColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'lender', label: 'Loan', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'costCentre', label: 'Cost centre', type: 'text' },
  { key: 'description', label: 'Use of funds', type: 'text' },
  { key: 'amount', label: 'Amount', type: 'money' },
];

/** Loan utilisation (BRD 6, FR-FIN-06/07, US-OA-008): amounts, use of funds, balances (BRL-06). */
export const loanUtilisationReport: ReportDefinition = {
  key: 'loan-utilisation',
  title: 'Loan utilisation report',
  description: 'Loan amounts, use of funds, repayments and outstanding balances',
  department: 'finance',
  permissions: [P.REPORTS_FINANCE],
  defaultPeriod: 'month',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    // Expenses linked to a loan are its use of funds; repayment postings are not.
    const useWhere = and(
      isNull(transactions.deletedAt),
      eq(transactions.direction, 'out'),
      ne(transactions.source, 'loan_repayment'),
      isNotNull(transactions.loanId),
    );
    const [loanRows, uses] = await Promise.all([
      db
        .select({
          lender: loans.lender,
          startDate: loans.startDate,
          interestRate: loans.interestRate,
          principal: loans.principal,
          interestCharged: loans.interestCharged,
          status: loans.status,
          used: sql<string>`(SELECT COALESCE(SUM(tx.amount), 0) FROM transactions tx
            WHERE tx.loan_id = ${outerColumn(loans.id)} AND tx.deleted_at IS NULL AND tx.direction = 'out'
              AND tx.source <> 'loan_repayment' AND tx.transaction_date <= ${to})`,
          repaid: sql<string>`(SELECT COALESCE(SUM(lr.amount), 0) FROM loan_repayments lr
            WHERE lr.loan_id = ${outerColumn(loans.id)} AND lr.payment_date <= ${to})`,
        })
        .from(loans)
        .where(and(isNull(loans.deletedAt), lte(loans.startDate, to)))
        .orderBy(asc(loans.startDate)),
      db
        .select({
          date: transactions.transactionDate,
          lender: loans.lender,
          category: categories.name,
          costCentreType: transactions.costCentreType,
          projectCode: projects.code,
          projectName: projects.name,
          description: transactions.description,
          amount: transactions.amount,
        })
        .from(transactions)
        .innerJoin(loans, eq(loans.id, transactions.loanId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .where(and(useWhere, between(transactions.transactionDate, from, to)))
        .orderBy(asc(transactions.transactionDate)),
    ]);

    const rows = loanRows.map((l) => {
      const principal = toNumber(l.principal);
      const used = toNumber(l.used);
      const interest = toNumber(l.interestCharged);
      const repaid = toNumber(l.repaid);
      return {
        lender: l.lender,
        startDate: l.startDate,
        interestRate: toNumber(l.interestRate),
        principal,
        used,
        unused: round2(principal - used),
        interestCharged: interest,
        repaid,
        outstanding: loanBalance(principal, interest, repaid),
        status: labelOf(l.status),
      };
    });
    const useRows = uses.map((u) => ({
      date: u.date,
      lender: u.lender,
      category: u.category ?? 'Uncategorised',
      costCentre: centreLabel(u.costCentreType, u.projectCode, u.projectName),
      description: clip(u.description, 160),
      amount: toNumber(u.amount),
    }));
    const totals = computeTotals(columns, rows);

    return {
      columns,
      rows,
      totals,
      summary: [
        { label: 'Loans', value: rows.length, type: 'number' },
        { label: 'Total borrowed', value: Number(totals?.principal ?? 0), type: 'money' },
        { label: 'Total used', value: Number(totals?.used ?? 0), type: 'money' },
        { label: 'Total repaid', value: Number(totals?.repaid ?? 0), type: 'money' },
        { label: 'Outstanding balance', value: Number(totals?.outstanding ?? 0), type: 'money' },
        {
          label: 'Funds used in period',
          value: round2(useRows.reduce((a, r) => a + r.amount, 0)),
          type: 'money',
        },
      ],
      sections: [
        {
          key: 'uses',
          title: 'Use of funds in the period',
          columns: useColumns,
          rows: useRows,
          totals: computeTotals(useColumns, useRows),
        },
      ],
    };
  },
};
