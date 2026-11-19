import type { z } from 'zod';
import type { Permission } from '../../rbac/permissions.js';

export type ColumnType = 'text' | 'money' | 'number' | 'date' | 'percent';
export type CellValue = string | number | null;
export type ReportRow = Record<string, CellValue>;

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface SummaryItem {
  label: string;
  value: CellValue;
  type: ColumnType;
}

/** A secondary table inside a report (e.g. "Pending requests" in the daily financial report). */
export interface ReportTable {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
}

/** What a builder produces. */
export interface ReportData {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  summary: SummaryItem[];
  sections?: ReportTable[];
}

export interface ReportPeriod {
  from: string;
  to: string;
}

/** API shape of `GET /reports/:key` (FR-RPT-01). */
export interface ReportResult extends ReportData {
  key: string;
  title: string;
  period: ReportPeriod;
  generatedAt: string;
  filters: Record<string, unknown>;
}

export type ReportDepartment = 'finance' | 'projects' | 'operations' | 'farm' | 'business';

/** Metadata so the UI can render a report's own filters. */
export interface ReportFilterDef {
  key: string;
  label: string;
  /** `source` = load options from a shared lookup; `options` = fixed values. */
  source?: 'projects' | 'users' | 'greenhouses' | 'categories';
  options?: readonly { value: string; label: string }[];
}

export interface ReportBuildContext<F> {
  from: string;
  to: string;
  filters: F;
}

/**
 * One report (BRD section 6). Each lives in its own `builders/*.report.ts` and is listed in
 * `reports.registry.ts` — adding a report never touches the service (open/closed).
 */
export interface ReportDefinition<F = Record<string, unknown>> {
  key: string;
  title: string;
  description: string;
  department: ReportDepartment;
  /** The user needs ANY of these. */
  permissions: readonly Permission[];
  /** Daily reports default to today, the rest to the current month. */
  defaultPeriod: 'day' | 'month';
  filters: readonly ReportFilterDef[];
  filterSchema: z.ZodType<F>;
  build(ctx: ReportBuildContext<F>): Promise<ReportData>;
}
