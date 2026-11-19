import { and, asc, between, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from '../../../db/client.js';
import {
  dailyOpsReports,
  fieldIssues,
  progressReports,
  projects,
  siteVisits,
  users,
} from '../../../db/schema/index.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { isProjectDelayed } from '../../dashboard/dashboard.calc.js';
import { clip } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { dayBounds, labelOf, noFilters } from './_shared.js';

const columns: ReportColumn[] = [
  { key: 'code', label: 'Code', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'endDate', label: 'End date', type: 'date' },
  { key: 'schedule', label: 'Schedule', type: 'text' },
  { key: 'percentComplete', label: 'Latest % complete', type: 'percent' },
  { key: 'reports', label: 'Progress reports', type: 'number' },
  { key: 'visits', label: 'Site visits', type: 'number' },
  { key: 'openIssues', label: 'Open issues', type: 'number' },
];

const visitColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'visitedBy', label: 'Visited by', type: 'text' },
  { key: 'findings', label: 'Findings', type: 'text' },
];

const progressColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'technician', label: 'Technician', type: 'text' },
  { key: 'workCompleted', label: 'Work completed', type: 'text' },
  { key: 'percentComplete', label: '% complete', type: 'percent' },
  { key: 'status', label: 'Status', type: 'text' },
];

const issueColumns: ReportColumn[] = [
  { key: 'date', label: 'Raised', type: 'date' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'title', label: 'Issue', type: 'text' },
  { key: 'severity', label: 'Severity', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'raisedBy', label: 'Raised by', type: 'text' },
];

/**
 * Daily operations report (BRD 6, FR-OPS-07): project status, site visits, technician
 * progress and issues for the period.
 */
export const dailyOperationsReport: ReportDefinition = {
  key: 'daily-operations',
  title: 'Daily operations report',
  description: 'Project status, site visits, technician progress and issues',
  department: 'operations',
  permissions: [P.REPORTS_OPERATIONS],
  defaultPeriod: 'day',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    const [start, end] = dayBounds(from, to);
    const raiser = alias(users, 'raiser');

    const [projectRows, visits, progress, issues, opsReports] = await Promise.all([
      db
        .select({
          id: projects.id,
          code: projects.code,
          name: projects.name,
          status: projects.status,
          endDate: projects.endDate,
          latestPct: sql<number | null>`(SELECT pr.percent_complete FROM progress_reports pr
            WHERE pr.project_id = ${outerColumn(projects.id)} AND pr.report_date <= ${to}
            ORDER BY pr.report_date DESC, pr.id DESC LIMIT 1)`,
          reports: sql<number>`(SELECT COUNT(*) FROM progress_reports pr
            WHERE pr.project_id = ${outerColumn(projects.id)} AND pr.report_date BETWEEN ${from} AND ${to})`,
          visits: sql<number>`(SELECT COUNT(*) FROM site_visits sv
            WHERE sv.project_id = ${outerColumn(projects.id)} AND sv.visit_date BETWEEN ${from} AND ${to})`,
          openIssues: sql<number>`(SELECT COUNT(*) FROM field_issues fi
            WHERE fi.project_id = ${outerColumn(projects.id)} AND fi.status = 'open')`,
        })
        .from(projects)
        .where(
          and(
            isNull(projects.deletedAt),
            notInArray(projects.status, ['created', 'closed']),
            // Running projects, plus anything that had field activity in the period.
            or(
              inArray(projects.status, [
                'tasks_assigned',
                'funding_requested',
                'funding_approved',
                'in_execution',
              ]),
              sql`EXISTS (SELECT 1 FROM progress_reports pr WHERE pr.project_id = ${outerColumn(projects.id)} AND pr.report_date BETWEEN ${from} AND ${to})`,
            ),
          ),
        )
        .orderBy(asc(projects.code)),
      db
        .select({
          date: siteVisits.visitDate,
          project: projects.name,
          visitedBy: users.name,
          findings: siteVisits.findings,
        })
        .from(siteVisits)
        .innerJoin(projects, eq(projects.id, siteVisits.projectId))
        .innerJoin(users, eq(users.id, siteVisits.visitedBy))
        .where(between(siteVisits.visitDate, from, to))
        .orderBy(asc(siteVisits.visitDate)),
      db
        .select({
          date: progressReports.reportDate,
          project: projects.name,
          technician: users.name,
          workCompleted: progressReports.workCompleted,
          percentComplete: progressReports.percentComplete,
          status: progressReports.status,
        })
        .from(progressReports)
        .innerJoin(projects, eq(projects.id, progressReports.projectId))
        .innerJoin(users, eq(users.id, progressReports.technicianId))
        .where(between(progressReports.reportDate, from, to))
        .orderBy(asc(progressReports.reportDate), asc(projects.name)),
      db
        .select({
          createdAt: fieldIssues.createdAt,
          project: projects.name,
          title: fieldIssues.title,
          severity: fieldIssues.severity,
          status: fieldIssues.status,
          raisedBy: raiser.name,
        })
        .from(fieldIssues)
        .innerJoin(projects, eq(projects.id, fieldIssues.projectId))
        .innerJoin(raiser, eq(raiser.id, fieldIssues.raisedBy))
        // Raised in the period, or still open.
        .where(
          or(
            and(gte(fieldIssues.createdAt, start), lte(fieldIssues.createdAt, end)),
            eq(fieldIssues.status, 'open'),
          ),
        )
        .orderBy(asc(fieldIssues.createdAt)),
      db
        .select({
          date: dailyOpsReports.reportDate,
          comments: dailyOpsReports.comments,
          by: users.name,
        })
        .from(dailyOpsReports)
        .innerJoin(users, eq(users.id, dailyOpsReports.submittedBy))
        .where(between(dailyOpsReports.reportDate, from, to))
        .orderBy(asc(dailyOpsReports.reportDate)),
    ]);

    const today = to;
    const rows = projectRows.map((p) => ({
      code: p.code,
      project: p.name,
      status: labelOf(p.status),
      endDate: p.endDate,
      schedule: isProjectDelayed(p.endDate, p.status, today) ? 'Delayed' : 'On track',
      percentComplete: p.latestPct === null ? null : Number(p.latestPct),
      reports: Number(p.reports),
      visits: Number(p.visits),
      openIssues: Number(p.openIssues),
    }));
    const issueRows = issues.map((i) => ({
      date: i.createdAt.toISOString().slice(0, 10),
      project: i.project,
      title: i.title,
      severity: labelOf(i.severity),
      status: labelOf(i.status),
      raisedBy: i.raisedBy,
    }));
    const openHigh = issues.filter((i) => i.status === 'open' && i.severity === 'high').length;

    return {
      columns,
      rows,
      totals: {
        code: 'Total',
        reports: progress.length,
        visits: visits.length,
        openIssues: rows.reduce((a, r) => a + r.openIssues, 0),
      },
      summary: [
        { label: 'Active projects', value: rows.length, type: 'number' },
        {
          label: 'Delayed projects',
          value: rows.filter((r) => r.schedule === 'Delayed').length,
          type: 'number',
        },
        { label: 'Progress reports', value: progress.length, type: 'number' },
        { label: 'Site visits', value: visits.length, type: 'number' },
        {
          label: 'Open issues',
          value: issues.filter((i) => i.status === 'open').length,
          type: 'number',
        },
        { label: 'High-severity open issues', value: openHigh, type: 'number' },
        { label: 'Daily ops reports submitted', value: opsReports.length, type: 'number' },
        {
          label: 'Operations manager comments',
          value:
            clip(opsReports.map((r) => `${r.date}: ${r.comments ?? '—'}`).join(' | '), 600) ?? '—',
          type: 'text',
        },
      ],
      sections: [
        {
          key: 'visits',
          title: 'Site visits',
          columns: visitColumns,
          rows: visits.map((v) => ({ ...v, findings: clip(v.findings, 300) })),
          totals: null,
        },
        {
          key: 'progress',
          title: 'Technician progress',
          columns: progressColumns,
          rows: progress.map((p) => ({
            ...p,
            workCompleted: clip(p.workCompleted, 300),
            status: labelOf(p.status),
          })),
          totals: null,
        },
        { key: 'issues', title: 'Issues', columns: issueColumns, rows: issueRows, totals: null },
      ],
    };
  },
};
