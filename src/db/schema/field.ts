import {
  date,
  decimal,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
  mediumtext,
} from 'drizzle-orm/mysql-core';
import { ISSUE_STATUSES, PROGRESS_REPORT_STATUSES, SEVERITIES } from '../enums.js';
import { dateTime, id, ref, timestamps } from './_columns.js';
import { users } from './auth.js';
import { projects } from './projects.js';

/** Technician progress reports (FR-OPS-01..05). Photos are `documents` with entity_type 'progress_report'. */
export const progressReports = mysqlTable(
  'progress_reports',
  {
    id: id(),
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id),
    technicianId: ref('technician_id')
      .notNull()
      .references(() => users.id),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    workCompleted: mediumtext('work_completed').notNull(),
    pendingWork: mediumtext('pending_work'),
    percentComplete: tinyint('percent_complete', { unsigned: true }).notNull(),
    issuesSummary: mediumtext('issues_summary'),
    latitude: decimal('latitude', { precision: 10, scale: 7, mode: 'number' }),
    longitude: decimal('longitude', { precision: 10, scale: 7, mode: 'number' }),
    status: mysqlEnum('status', PROGRESS_REPORT_STATUSES).notNull().default('submitted'),
    verifiedBy: ref('verified_by').references(() => users.id),
    verifiedAt: dateTime('verified_at'),
    queryComment: text('query_comment'),
    technicianResponse: text('technician_response'),
    /** Client-generated id so offline submissions are idempotent (FR-OPS-08). */
    clientRef: varchar('client_ref', { length: 64 }),
    ...timestamps(),
  },
  (t) => [
    index('progress_reports_project_idx').on(t.projectId, t.reportDate),
    index('progress_reports_tech_idx').on(t.technicianId),
    uniqueIndex('progress_reports_client_ref_uq').on(t.clientRef),
  ],
);

/** Issues raised from the field (FR-OPS-04). */
export const fieldIssues = mysqlTable(
  'field_issues',
  {
    id: id(),
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id),
    progressReportId: ref('progress_report_id').references(() => progressReports.id),
    raisedBy: ref('raised_by')
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 191 }).notNull(),
    description: mediumtext('description'),
    severity: mysqlEnum('severity', SEVERITIES).notNull(),
    status: mysqlEnum('status', ISSUE_STATUSES).notNull().default('open'),
    resolution: mediumtext('resolution'),
    resolvedBy: ref('resolved_by').references(() => users.id),
    resolvedAt: dateTime('resolved_at'),
    ...timestamps(),
  },
  (t) => [index('field_issues_project_idx').on(t.projectId, t.status)],
);

/** Operations Manager site visits (FR-OPS-06). Photos are `documents` with entity_type 'site_visit'. */
export const siteVisits = mysqlTable(
  'site_visits',
  {
    id: id(),
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id),
    visitedBy: ref('visited_by')
      .notNull()
      .references(() => users.id),
    visitDate: date('visit_date', { mode: 'string' }).notNull(),
    findings: mediumtext('findings').notNull(),
    ...timestamps(),
  },
  (t) => [index('site_visits_project_idx').on(t.projectId)],
);

export interface DailyOpsSummary {
  activeProjects: number;
  progressReports: number;
  siteVisits: number;
  openIssues: number;
  highSeverityIssues: number;
  projects: { id: number; code: string; name: string; percentComplete: number | null }[];
}

/** Operations Manager daily report, pre-filled from the day's activity (FR-OPS-07). */
export const dailyOpsReports = mysqlTable(
  'daily_ops_reports',
  {
    id: id(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    submittedBy: ref('submitted_by')
      .notNull()
      .references(() => users.id),
    summary: json('summary').$type<DailyOpsSummary>().notNull(),
    comments: mediumtext('comments'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('daily_ops_reports_uq').on(t.submittedBy, t.reportDate)],
);
