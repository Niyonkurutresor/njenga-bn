import { and, asc, between, eq, gte, lte } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  casualPayItems,
  casualPayRuns,
  casualWorkers,
  employees,
  payrollItems,
  payrollRuns,
  projects,
} from '../../../db/schema/index.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { labelOf, noFilters } from './_shared.js';

const columns: ReportColumn[] = [
  { key: 'period', label: 'Month', type: 'text' },
  { key: 'employee', label: 'Employee', type: 'text' },
  { key: 'jobTitle', label: 'Job title', type: 'text' },
  { key: 'basic', label: 'Basic', type: 'money' },
  { key: 'allowances', label: 'Allowances', type: 'money' },
  { key: 'deductions', label: 'Deductions', type: 'money' },
  { key: 'net', label: 'Net pay', type: 'money' },
  { key: 'status', label: 'Status', type: 'text' },
];

const casualColumns: ReportColumn[] = [
  { key: 'period', label: 'Period', type: 'text' },
  { key: 'worker', label: 'Worker', type: 'text' },
  { key: 'site', label: 'Site', type: 'text' },
  { key: 'days', label: 'Days present', type: 'number' },
  { key: 'rate', label: 'Daily rate', type: 'money' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'status', label: 'Status', type: 'text' },
];

/** Payroll report (BRD 6, FR-PAY-02/05): salaries (by month) and casual worker payments. */
export const payrollReport: ReportDefinition = {
  key: 'payroll',
  title: 'Payroll report',
  description: 'Salaries and casual worker payments for the period',
  department: 'finance',
  permissions: [P.REPORTS_FINANCE],
  defaultPeriod: 'month',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    const [salaries, casual] = await Promise.all([
      db
        .select({
          period: payrollRuns.period,
          status: payrollRuns.status,
          employee: employees.fullName,
          jobTitle: employees.jobTitle,
          basic: payrollItems.basicSalary,
          allowances: payrollItems.allowances,
          deductions: payrollItems.deductions,
          net: payrollItems.netPay,
        })
        .from(payrollItems)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.runId))
        .innerJoin(employees, eq(employees.id, payrollItems.employeeId))
        .where(between(payrollRuns.period, from.slice(0, 7), to.slice(0, 7)))
        .orderBy(asc(payrollRuns.period), asc(employees.fullName)),
      db
        .select({
          periodStart: casualPayRuns.periodStart,
          periodEnd: casualPayRuns.periodEnd,
          runStatus: casualPayRuns.status,
          worker: casualWorkers.fullName,
          siteType: casualPayItems.siteType,
          projectCode: projects.code,
          days: casualPayItems.daysPresent,
          rate: casualPayItems.dailyRate,
          amount: casualPayItems.amount,
          paid: casualPayItems.paid,
        })
        .from(casualPayItems)
        .innerJoin(casualPayRuns, eq(casualPayRuns.id, casualPayItems.runId))
        .innerJoin(casualWorkers, eq(casualWorkers.id, casualPayItems.workerId))
        .leftJoin(projects, eq(projects.id, casualPayItems.projectId))
        // Runs overlapping the period.
        .where(and(lte(casualPayRuns.periodStart, to), gte(casualPayRuns.periodEnd, from)))
        .orderBy(asc(casualPayRuns.periodStart), asc(casualWorkers.fullName)),
    ]);

    const rows = salaries.map((s) => ({
      period: s.period,
      employee: s.employee,
      jobTitle: s.jobTitle,
      basic: toNumber(s.basic),
      allowances: toNumber(s.allowances),
      deductions: toNumber(s.deductions),
      net: toNumber(s.net),
      status: labelOf(s.status),
    }));
    const casualRows = casual.map((c) => ({
      period: `${c.periodStart} to ${c.periodEnd}`,
      worker: c.worker,
      site: c.siteType === 'project' ? (c.projectCode ?? 'Project') : 'Farm',
      days: c.days,
      rate: toNumber(c.rate),
      amount: toNumber(c.amount),
      status: c.paid || c.runStatus === 'paid' ? 'Paid' : 'Draft',
    }));
    const salaryTotal = round2(rows.reduce((a, r) => a + r.net, 0));
    const casualTotal = round2(casualRows.reduce((a, r) => a + r.amount, 0));

    return {
      columns,
      rows,
      totals: computeTotals(columns, rows),
      summary: [
        { label: 'Salaries (net)', value: salaryTotal, type: 'money' },
        {
          label: 'Employees paid',
          value: new Set(rows.map((r) => r.employee)).size,
          type: 'number',
        },
        { label: 'Casual worker pay', value: casualTotal, type: 'money' },
        {
          label: 'Casual workers',
          value: new Set(casualRows.map((r) => r.worker)).size,
          type: 'number',
        },
        { label: 'Total labour cost', value: round2(salaryTotal + casualTotal), type: 'money' },
      ],
      sections: [
        {
          key: 'casual',
          title: 'Casual worker payments',
          columns: casualColumns,
          rows: casualRows,
          totals: computeTotals(casualColumns, casualRows, ['days', 'amount']),
        },
      ],
    };
  },
};
