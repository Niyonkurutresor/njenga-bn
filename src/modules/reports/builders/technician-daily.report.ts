import { and, asc, between, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { outerColumn } from '../../../common/utils/sql.js';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import { fieldIssues, progressReports, projects, users } from '../../../db/schema/index.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { clip } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { labelOf, optionalId, projectFilter } from './_shared.js';

const filterSchema = z.object({ technicianId: optionalId, projectId: optionalId });
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'technician', label: 'Technician', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'workCompleted', label: 'Work done', type: 'text' },
  { key: 'pendingWork', label: 'Pending', type: 'text' },
  { key: 'percentComplete', label: '% complete', type: 'percent' },
  { key: 'issues', label: 'Issues', type: 'text' },
  { key: 'photos', label: 'Photos', type: 'number' },
  { key: 'status', label: 'Status', type: 'text' },
];

const issueColumns: ReportColumn[] = [
  { key: 'technician', label: 'Raised by', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'title', label: 'Issue', type: 'text' },
  { key: 'severity', label: 'Severity', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
];

/** Technician daily report (BRD 6, FR-OPS-01..03): work done, pending, issues, photos. */
export const technicianDailyReport: ReportDefinition<Filters> = {
  key: 'technician-daily',
  title: 'Technician daily report',
  description: 'Work done, pending work, issues and photos per technician report',
  department: 'operations',
  permissions: [P.REPORTS_OPERATIONS],
  defaultPeriod: 'day',
  filters: [{ key: 'technicianId', label: 'Technician', source: 'users' }, projectFilter],
  filterSchema,
  async build({ from, to, filters }) {
    const where: SQL[] = [between(progressReports.reportDate, from, to)];
    if (filters.technicianId) where.push(eq(progressReports.technicianId, filters.technicianId));
    if (filters.projectId) where.push(eq(progressReports.projectId, filters.projectId));

    const reports = await db
      .select({
        id: progressReports.id,
        date: progressReports.reportDate,
        technician: users.name,
        project: projects.name,
        workCompleted: progressReports.workCompleted,
        pendingWork: progressReports.pendingWork,
        percentComplete: progressReports.percentComplete,
        issues: progressReports.issuesSummary,
        status: progressReports.status,
        // Photos are documents attached to the report (FR-OPS-02).
        photos: sql<number>`(SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'progress_report'
          AND CAST(d.entity_id AS UNSIGNED) = ${outerColumn(progressReports.id)} AND d.deleted_at IS NULL)`,
      })
      .from(progressReports)
      .innerJoin(users, eq(users.id, progressReports.technicianId))
      .innerJoin(projects, eq(projects.id, progressReports.projectId))
      .where(and(...where))
      .orderBy(asc(progressReports.reportDate), asc(users.name));

    const ids = reports.map((r) => r.id);
    const issues = ids.length
      ? await db
          .select({
            technician: users.name,
            project: projects.name,
            title: fieldIssues.title,
            severity: fieldIssues.severity,
            status: fieldIssues.status,
            reportId: fieldIssues.progressReportId,
          })
          .from(fieldIssues)
          .innerJoin(users, eq(users.id, fieldIssues.raisedBy))
          .innerJoin(projects, eq(projects.id, fieldIssues.projectId))
          .where(inArray(fieldIssues.progressReportId, ids))
      : [];

    const rows = reports.map((r) => ({
      date: r.date,
      technician: r.technician,
      project: r.project,
      workCompleted: clip(r.workCompleted, 400),
      pendingWork: clip(r.pendingWork, 300),
      percentComplete: r.percentComplete,
      issues: clip(r.issues, 300),
      photos: Number(r.photos),
      status: labelOf(r.status),
    }));

    return {
      columns,
      rows,
      totals: { date: 'Total', photos: rows.reduce((a, r) => a + r.photos, 0) },
      summary: [
        { label: 'Reports', value: rows.length, type: 'number' },
        {
          label: 'Technicians reporting',
          value: new Set(rows.map((r) => r.technician)).size,
          type: 'number',
        },
        { label: 'Photos', value: rows.reduce((a, r) => a + r.photos, 0), type: 'number' },
        { label: 'Issues raised', value: issues.length, type: 'number' },
        {
          label: 'Verified',
          value: reports.filter((r) => r.status === 'verified').length,
          type: 'number',
        },
        {
          label: 'Queried',
          value: reports.filter((r) => r.status === 'queried').length,
          type: 'number',
        },
      ],
      sections: [
        {
          key: 'issues',
          title: 'Issues raised in these reports',
          columns: issueColumns,
          rows: issues.map((i) => ({
            technician: i.technician,
            project: i.project,
            title: i.title,
            severity: labelOf(i.severity),
            status: labelOf(i.status),
          })),
          totals: null,
        },
      ],
    };
  },
};
