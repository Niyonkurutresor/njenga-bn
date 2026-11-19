import { businessDevelopmentReport } from './builders/business-development.report.js';
import { cropInspectionReport } from './builders/crop-inspection.report.js';
import { dailyFarmReport } from './builders/daily-farm.report.js';
import { dailyFinancialReport } from './builders/daily-financial.report.js';
import { dailyOperationsReport } from './builders/daily-operations.report.js';
import { employeePerformanceReport } from './builders/employee-performance.report.js';
import { expensesReport } from './builders/expenses.report.js';
import { loanUtilisationReport } from './builders/loan-utilisation.report.js';
import { payrollReport } from './builders/payroll.report.js';
import { profitLossReport } from './builders/profit-loss.report.js';
import { projectFinancialReport } from './builders/project-financial.report.js';
import { technicianDailyReport } from './builders/technician-daily.report.js';
import type { ReportDefinition } from './report.types.js';

/**
 * Every report in the system (BRD section 6). To add a report: write a builder in
 * `builders/` and list it here — routes, exports and the catalogue pick it up automatically.
 */
export const REPORTS: readonly ReportDefinition[] = [
  dailyFinancialReport,
  expensesReport,
  profitLossReport,
  projectFinancialReport,
  loanUtilisationReport,
  payrollReport,
  dailyOperationsReport,
  technicianDailyReport,
  dailyFarmReport,
  cropInspectionReport,
  businessDevelopmentReport,
  employeePerformanceReport,
  // Each builder validates its own filters, so the registry can treat them uniformly.
].map((r) => r as unknown as ReportDefinition);

const byKey = new Map(REPORTS.map((r) => [r.key, r]));

export function getReport(key: string): ReportDefinition | undefined {
  return byKey.get(key);
}

export const DEPARTMENT_LABELS = {
  finance: 'Finance',
  projects: 'Projects',
  operations: 'Operations',
  farm: 'Farm',
  business: 'Business development',
} as const;
