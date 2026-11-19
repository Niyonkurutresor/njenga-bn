import type { Response } from 'express';
import { and, between, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  dailyFinancialReports,
  dailyOpsReports,
  farmReports,
  interactions,
  leads,
  transactions,
  users,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { addDays, today } from '../../common/utils/dates.js';
import { hasPermissions, PERMISSIONS as P } from '../../rbac/permissions.js';
import type { AuthUser } from '../auth/auth.types.js';
import { resolvePeriod } from '../dashboard/dashboard.calc.js';
import { writeReportPdf, writeReportXlsx } from './reports.export.js';
import { exportFilename } from './reports.format.js';
import { DEPARTMENT_LABELS, getReport, REPORTS } from './reports.registry.js';
import type { ExportQuery, ReportQuery } from './reports.schema.js';
import type { ReportDefinition, ReportResult } from './report.types.js';

function canOpen(user: Pick<AuthUser, 'permissions'>, report: ReportDefinition): boolean {
  return hasPermissions(user.permissions, report.permissions, 'any');
}

function requireReport(user: AuthUser, key: string): ReportDefinition {
  const report = getReport(key);
  if (!report) throw AppError.notFound('Report');
  if (!canOpen(user, report)) throw AppError.forbidden();
  return report;
}

/** Runs a builder with a validated period and filters (FR-RPT-01). */
async function runReport(report: ReportDefinition, query: ReportQuery): Promise<ReportResult> {
  const {
    from: qFrom,
    to: qTo,
    format: _format,
    ...rest
  } = query as ReportQuery & {
    format?: unknown;
  };
  const period = resolvePeriod({ from: qFrom, to: qTo }, today(), report.defaultPeriod);
  // Empty strings from the UI mean "no filter".
  const raw = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v != null));
  const parsed = report.filterSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    throw AppError.validation({ in: 'query', fields: flat.fieldErrors, form: flat.formErrors });
  }
  const filters = parsed.data;
  const data = await report.build({ ...period, filters });
  return {
    key: report.key,
    title: report.title,
    period,
    generatedAt: new Date().toISOString(),
    filters,
    ...data,
  };
}

export const DAILY_FINANCIAL_KEY = 'daily-financial';

export const reportsService = {
  /** Reports the user may open, grouped by department in the UI (FR-RPT-01). */
  catalogue(user: AuthUser) {
    const canExport = user.permissions.includes(P.REPORTS_EXPORT);
    return REPORTS.filter((r) => canOpen(user, r)).map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description,
      department: r.department,
      departmentLabel: DEPARTMENT_LABELS[r.department],
      defaultPeriod: r.defaultPeriod,
      filters: r.filters,
      canExport,
    }));
  },

  async run(user: AuthUser, key: string, query: ReportQuery): Promise<ReportResult> {
    return runReport(requireReport(user, key), query);
  },

  /** System use (scheduled job): runs a report without a user. */
  async runAsSystem(key: string, query: ReportQuery): Promise<ReportResult> {
    const report = getReport(key);
    if (!report) throw AppError.notFound('Report');
    return runReport(report, query);
  },

  /** Streams a PDF / Excel file (FR-RPT-03). Route requires reports:export. */
  async export(user: AuthUser, key: string, query: ExportQuery, res: Response): Promise<void> {
    const report = requireReport(user, key);
    const result = await runReport(report, query);
    const ext = query.format;
    res.setHeader(
      'Content-Type',
      ext === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFilename(key, result.period.from, result.period.to, ext)}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    if (ext === 'pdf') await writeReportPdf(result, res);
    else await writeReportXlsx(result, res);
  },

  // ---------- Daily financial snapshots (FR-RPT-02) ----------

  /** Builds the day's daily financial report and stores it (upsert by date). */
  async saveDailyFinancialSnapshot(date: string): Promise<ReportResult> {
    const result = await this.runAsSystem(DAILY_FINANCIAL_KEY, { from: date, to: date });
    await db
      .insert(dailyFinancialReports)
      .values({ reportDate: date, data: result as unknown as Record<string, unknown> })
      .onDuplicateKeyUpdate({ set: { data: result as unknown as Record<string, unknown> } });
    return result;
  },

  async snapshots(query: { from?: string | undefined; to?: string | undefined }) {
    const period = resolvePeriod(query, today(), 'month');
    const rows = await db
      .select({
        id: dailyFinancialReports.id,
        reportDate: dailyFinancialReports.reportDate,
        data: dailyFinancialReports.data,
        createdAt: dailyFinancialReports.createdAt,
      })
      .from(dailyFinancialReports)
      .where(between(dailyFinancialReports.reportDate, period.from, period.to))
      .orderBy(desc(dailyFinancialReports.reportDate));
    return {
      period,
      items: rows.map((r) => {
        const data = r.data as unknown as Partial<ReportResult>;
        return {
          id: r.id,
          reportDate: r.reportDate,
          createdAt: r.createdAt,
          summary: data.summary ?? [],
          transactions: data.rows?.length ?? 0,
        };
      }),
    };
  },

  async snapshot(date: string): Promise<ReportResult> {
    const [row] = await db
      .select({ data: dailyFinancialReports.data, createdAt: dailyFinancialReports.createdAt })
      .from(dailyFinancialReports)
      .where(eq(dailyFinancialReports.reportDate, date));
    if (!row) throw AppError.notFound('Daily financial report');
    return row.data as unknown as ReportResult;
  },

  // ---------- Departmental reports status (US-CEO-002) ----------

  /**
   * Latest report per department with its date and author; `missing` when the department's
   * daily report for `date` is absent (Business development: no lead activity in 7 days).
   */
  async departmental(date = today()) {
    const weekAgo = addDays(date, -6);
    const [weekStart, dayEnd] = [
      new Date(`${weekAgo}T00:00:00Z`),
      new Date(`${date}T23:59:59.999Z`),
    ];

    const [[snap], [txDay], [lastTx], [ops], [farm], [interaction], [lead]] = await Promise.all([
      db
        .select({
          reportDate: dailyFinancialReports.reportDate,
          createdAt: dailyFinancialReports.createdAt,
        })
        .from(dailyFinancialReports)
        .where(lte(dailyFinancialReports.reportDate, date))
        .orderBy(desc(dailyFinancialReports.reportDate))
        .limit(1),
      db
        .select({ n: sql<number>`count(*)` })
        .from(transactions)
        .where(and(eq(transactions.transactionDate, date), isNull(transactions.deletedAt))),
      db
        .select({ date: transactions.transactionDate, by: users.name })
        .from(transactions)
        .innerJoin(users, eq(users.id, transactions.recordedBy))
        .where(and(lte(transactions.transactionDate, date), isNull(transactions.deletedAt)))
        .orderBy(desc(transactions.transactionDate), desc(transactions.id))
        .limit(1),
      db
        .select({ id: dailyOpsReports.id, reportDate: dailyOpsReports.reportDate, by: users.name })
        .from(dailyOpsReports)
        .innerJoin(users, eq(users.id, dailyOpsReports.submittedBy))
        .where(lte(dailyOpsReports.reportDate, date))
        .orderBy(desc(dailyOpsReports.reportDate))
        .limit(1),
      db
        .select({ id: farmReports.id, reportDate: farmReports.reportDate, by: users.name })
        .from(farmReports)
        .innerJoin(users, eq(users.id, farmReports.submittedBy))
        .where(lte(farmReports.reportDate, date))
        .orderBy(desc(farmReports.reportDate))
        .limit(1),
      db
        .select({ at: interactions.occurredAt, by: users.name })
        .from(interactions)
        .innerJoin(users, eq(users.id, interactions.userId))
        .where(lte(interactions.occurredAt, dayEnd))
        .orderBy(desc(interactions.occurredAt))
        .limit(1),
      db
        .select({ at: leads.updatedAt, by: users.name })
        .from(leads)
        .innerJoin(users, eq(users.id, leads.ownerId))
        .where(and(lte(leads.updatedAt, dayEnd), isNull(leads.deletedAt)))
        .orderBy(desc(leads.updatedAt))
        .limit(1),
    ]);

    // Finance: the automatic snapshot, or at least transactions recorded that day.
    const financeLatest =
      snap && (!lastTx || snap.reportDate >= lastTx.date)
        ? { date: snap.reportDate, by: 'System (automatic)' }
        : lastTx
          ? { date: lastTx.date, by: lastTx.by }
          : null;
    const financeToday = snap?.reportDate === date || Number(txDay?.n ?? 0) > 0;

    const bdCandidates = [interaction, lead].filter(Boolean) as { at: Date; by: string }[];
    const bdLatest = bdCandidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
    const bdActive = Boolean(bdLatest && bdLatest.at >= weekStart);

    return {
      date,
      departments: [
        {
          department: 'finance',
          label: 'Finance',
          report: 'Daily financial report',
          latestDate: financeLatest?.date ?? null,
          submittedBy: financeLatest?.by ?? null,
          missing: !financeToday,
          link: `/reports/daily-financial?from=${date}&to=${date}`,
        },
        {
          department: 'operations',
          label: 'Operations',
          report: 'Daily operations report',
          latestDate: ops?.reportDate ?? null,
          submittedBy: ops?.by ?? null,
          missing: ops?.reportDate !== date,
          link: `/reports/daily-operations?from=${date}&to=${date}`,
        },
        {
          department: 'farm',
          label: 'Farm',
          report: 'Daily farm report',
          latestDate: farm?.reportDate ?? null,
          submittedBy: farm?.by ?? null,
          missing: farm?.reportDate !== date,
          link: `/reports/daily-farm?from=${date}&to=${date}`,
        },
        {
          department: 'business',
          label: 'Business development',
          report: 'Lead activity (last 7 days)',
          latestDate: bdLatest ? bdLatest.at.toISOString().slice(0, 10) : null,
          submittedBy: bdLatest?.by ?? null,
          missing: !bdActive,
          link: `/reports/business-development?from=${weekAgo}&to=${date}`,
        },
      ],
    };
  },
};
