import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  dailyOpsReports,
  fieldIssues,
  progressReports,
  projects,
  users,
} from '../../../db/schema/index.js';
import { SEVERITIES, type Severity } from '../../../db/enums.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { countBy } from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface FieldSection {
  kpis: Kpi[];
  /** Technician: did I submit a progress report today? */
  submittedToday: boolean | null;
  /** Ops: is today's daily operations report in? */
  dailyOpsSubmittedToday: boolean | null;
  issuesBySeverity: Record<Severity, number> | null;
  awaitingVerification:
    | {
        id: number;
        project: string;
        technician: string;
        reportDate: string;
        percentComplete: number;
        link: string;
      }[]
    | null;
}

/** Technician report submission (FR-OPS-01) and Ops verification queue / issues (FR-OPS-04/05). */
export const fieldSection: SectionBuilder<FieldSection> = {
  key: 'field',
  visible: (ctx) =>
    ctx.canAny(
      P.FIELD_REPORTS_SUBMIT,
      P.FIELD_REPORTS_VERIFY,
      P.FIELD_REPORTS_VIEW,
      P.OPS_REPORTS_SUBMIT,
    ),
  async build(ctx) {
    const submitter = ctx.can(P.FIELD_REPORTS_SUBMIT);
    const reviewer = ctx.canAny(P.FIELD_REPORTS_VERIFY, P.FIELD_REPORTS_VIEW);
    const opsReporter = ctx.can(P.OPS_REPORTS_SUBMIT);

    const [mine, myIssues, queue, statusRows, severityRows, opsToday] = await Promise.all([
      submitter
        ? db
            .select({
              today: sql<number>`SUM(CASE WHEN ${progressReports.reportDate} = ${ctx.today} THEN 1 ELSE 0 END)`,
              queried: sql<number>`SUM(CASE WHEN ${progressReports.status} = 'queried' THEN 1 ELSE 0 END)`,
            })
            .from(progressReports)
            .where(eq(progressReports.technicianId, ctx.user.id))
        : null,
      submitter
        ? db
            .select({ n: sql<number>`count(*)` })
            .from(fieldIssues)
            .where(and(eq(fieldIssues.raisedBy, ctx.user.id), eq(fieldIssues.status, 'open')))
        : null,
      reviewer
        ? db
            .select({
              id: progressReports.id,
              project: projects.name,
              technician: users.name,
              reportDate: progressReports.reportDate,
              percentComplete: progressReports.percentComplete,
            })
            .from(progressReports)
            .innerJoin(projects, eq(projects.id, progressReports.projectId))
            .innerJoin(users, eq(users.id, progressReports.technicianId))
            .where(eq(progressReports.status, 'submitted'))
            .orderBy(desc(progressReports.reportDate))
            .limit(6)
        : null,
      reviewer
        ? db
            .select({ key: progressReports.status, n: sql<number>`count(*)` })
            .from(progressReports)
            .groupBy(progressReports.status)
        : null,
      reviewer
        ? db
            .select({ key: fieldIssues.severity, n: sql<number>`count(*)` })
            .from(fieldIssues)
            .where(eq(fieldIssues.status, 'open'))
            .groupBy(fieldIssues.severity)
        : null,
      opsReporter
        ? db
            .select({ id: dailyOpsReports.id })
            .from(dailyOpsReports)
            .where(eq(dailyOpsReports.reportDate, ctx.today))
            .limit(1)
        : null,
    ]);

    const kpis: Kpi[] = [];
    let submittedToday: boolean | null = null;
    if (mine) {
      const today = Number(mine[0]?.today ?? 0);
      const queried = Number(mine[0]?.queried ?? 0);
      submittedToday = today > 0;
      kpis.push(
        {
          key: 'reportToday',
          label: "Today's progress report",
          value: today,
          format: 'number',
          tone: today ? 'green' : 'amber',
          hint: today ? 'Submitted' : 'Not submitted yet',
          link: today ? '/field/reports?mine=true' : '/field/reports/new',
        },
        {
          key: 'queried',
          label: 'Reports queried',
          value: queried,
          format: 'number',
          tone: queried ? 'amber' : 'green',
          hint: 'Need your response',
          link: '/field/reports?view=mine',
        },
        {
          key: 'myIssues',
          label: 'My open issues',
          value: Number(myIssues?.[0]?.n ?? 0),
          format: 'number',
          link: '/field/issues?status=open',
        },
      );
    }

    let issuesBySeverity: FieldSection['issuesBySeverity'] = null;
    if (statusRows && severityRows) {
      const statuses = countBy(['submitted', 'verified', 'queried'] as const, statusRows);
      issuesBySeverity = countBy(SEVERITIES, severityRows);
      const openIssues = SEVERITIES.reduce((a, s) => a + issuesBySeverity![s], 0);
      kpis.push(
        {
          key: 'awaiting',
          label: 'Reports awaiting verification',
          value: statuses.submitted,
          format: 'number',
          tone: statuses.submitted ? 'amber' : 'green',
          hint: `${statuses.queried} queried`,
          link: '/field/reports?view=queue',
        },
        {
          key: 'openIssues',
          label: 'Open site issues',
          value: openIssues,
          format: 'number',
          tone: issuesBySeverity.high ? 'red' : openIssues ? 'amber' : 'green',
          hint: `${issuesBySeverity.high} high severity`,
          link: '/field/issues?status=open',
        },
      );
    }

    let dailyOpsSubmittedToday: boolean | null = null;
    if (opsToday) {
      dailyOpsSubmittedToday = opsToday.length > 0;
      kpis.push({
        key: 'dailyOps',
        label: 'Daily operations report',
        value: opsToday.length,
        format: 'number',
        tone: dailyOpsSubmittedToday ? 'green' : 'amber',
        hint: dailyOpsSubmittedToday ? 'Submitted today' : 'Not submitted today',
        link: '/field/daily-ops',
      });
    }

    return {
      kpis,
      submittedToday,
      dailyOpsSubmittedToday,
      issuesBySeverity,
      awaitingVerification: queue?.map((r) => ({ ...r, link: `/field/reports/${r.id}` })) ?? null,
    };
  },
};
