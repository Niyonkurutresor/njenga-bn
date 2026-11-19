import { and, asc, desc, eq, gte, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { outerColumn } from '../../common/utils/sql.js';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import {
  dailyOpsReports,
  fieldIssues,
  progressReports,
  projects,
  siteVisits,
  users,
  type DailyOpsSummary,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { can } from '../../common/middleware/authorize.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { richTextToPlain } from '../../common/utils/rich-text.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { projectMetrics, teamUserIds } from '../projects/projects.service.js';
import type {
  CreateDailyOpsInput,
  DailyOpsListQuery,
  SiteVisitInput,
  SiteVisitListQuery,
  UpdateSiteVisitInput,
} from './field.schema.js';

const visitor = alias(users, 'visitor');
const submitter = alias(users, 'submitter');

const photoCount = sql<number>`(SELECT COUNT(*) FROM documents d
  WHERE d.entity_type = 'site_visit' AND d.entity_id = ${outerColumn(siteVisits.id)}
  AND d.deleted_at IS NULL)`;

const visitColumns = {
  id: siteVisits.id,
  projectId: siteVisits.projectId,
  visitDate: siteVisits.visitDate,
  findings: siteVisits.findings,
  createdAt: siteVisits.createdAt,
  updatedAt: siteVisits.updatedAt,
  photoCount,
  project: { id: projects.id, code: projects.code, name: projects.name },
  visitedBy: { id: visitor.id, name: visitor.name },
};

function selectVisits() {
  return db
    .select(visitColumns)
    .from(siteVisits)
    .innerJoin(projects, eq(projects.id, siteVisits.projectId))
    .innerJoin(visitor, eq(visitor.id, siteVisits.visitedBy));
}

async function assertProject(ex: Executor, projectId: number) {
  const [p] = await ex
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!p) throw AppError.rule('Project does not exist');
  return p;
}

function notFuture(date: string, what: string) {
  if (date > today()) throw AppError.rule(`${what} cannot be in the future`);
}

/** Site visits (FR-OPS-06). No delete: records are never removed by users (BRL-10). */
export const siteVisitService = {
  canRead(user: AuthUser): boolean {
    return (
      can(user, P.FIELD_REPORTS_VIEW) ||
      can(user, P.FIELD_REPORTS_VERIFY) ||
      can(user, P.PROJECTS_VIEW)
    );
  },

  async list(query: SiteVisitListQuery) {
    const filters: (SQL | undefined)[] = [isNull(projects.deletedAt)];
    if (query.projectId) filters.push(eq(siteVisits.projectId, query.projectId));
    if (query.visitedBy) filters.push(eq(siteVisits.visitedBy, query.visitedBy));
    if (query.from) filters.push(gte(siteVisits.visitDate, query.from));
    if (query.to) filters.push(lte(siteVisits.visitDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(siteVisits.findings, term), like(projects.code, term), like(projects.name, term)),
      );
    }
    const where = and(...filters);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      selectVisits()
        .where(where)
        .orderBy(desc(siteVisits.visitDate), desc(siteVisits.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(siteVisits)
        .innerJoin(projects, eq(projects.id, siteVisits.projectId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({ ...r, photoCount: Number(r.photoCount) })),
      Number(total),
      query,
    );
  },

  async get(id: number) {
    const [row] = await selectVisits().where(eq(siteVisits.id, id));
    if (!row) throw AppError.notFound('Site visit');
    return { ...row, photoCount: Number(row.photoCount) };
  },

  async create(user: AuthUser, input: SiteVisitInput) {
    notFuture(input.visitDate, 'The visit date');
    const id = await db.transaction(async (tx) => {
      const project = await assertProject(tx, input.projectId);
      const [res] = await tx.insert(siteVisits).values({
        projectId: input.projectId,
        visitDate: input.visitDate,
        // Empty when the findings are in an attached inspection report.
        findings: input.findings ?? '',
        visitedBy: user.id,
      });
      await auditService.log(
        { action: 'create', entityType: 'site_visit', entityId: res.insertId, newValues: input },
        tx,
      );
      await notificationService.notify(
        {
          userIds: await teamUserIds(tx, input.projectId),
          excludeUserId: user.id,
          type: 'field.site_visit',
          title: `Site visit recorded on ${project.code}`,
          body:
            richTextToPlain(input.findings).slice(0, 200) ||
            `${input.attachmentCount} file(s) attached`,
          link: `/projects/${input.projectId}`,
          entityType: 'site_visit',
          entityId: res.insertId,
        },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateSiteVisitInput) {
    if (input.visitDate) notFuture(input.visitDate, 'The visit date');
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(siteVisits).where(eq(siteVisits.id, id)).for('update');
      if (!row) throw AppError.notFound('Site visit');
      if (input.projectId) await assertProject(tx, input.projectId);
      const { findings, ...rest } = input;
      const patch = { ...rest, ...(findings === undefined ? {} : { findings: findings ?? '' }) };
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(siteVisits).set(patch).where(eq(siteVisits.id, id));
      await auditService.log(
        { action: 'update', entityType: 'site_visit', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(id);
  },
};

// ---------------- Daily operations report ----------------

/** The day's project activity (FR-OPS-07), used to pre-fill and to freeze the submitted report. */
async function buildSummary(ex: Executor, date: string) {
  const technician = alias(users, 'technician');
  const raiser = alias(users, 'raiser');
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  const [running, reports, visits, [issueCounts], newIssues] = await Promise.all([
    ex
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        status: projects.status,
        contractValue: projects.contractValue,
      })
      .from(projects)
      .where(and(isNull(projects.deletedAt), eq(projects.status, 'in_execution')))
      .orderBy(asc(projects.code)),
    ex
      .select({
        id: progressReports.id,
        percentComplete: progressReports.percentComplete,
        status: progressReports.status,
        workCompleted: progressReports.workCompleted,
        project: { id: projects.id, code: projects.code, name: projects.name },
        technician: { id: technician.id, name: technician.name },
      })
      .from(progressReports)
      .innerJoin(projects, eq(projects.id, progressReports.projectId))
      .innerJoin(technician, eq(technician.id, progressReports.technicianId))
      .where(eq(progressReports.reportDate, date))
      .orderBy(asc(projects.code)),
    ex
      .select({
        id: siteVisits.id,
        findings: siteVisits.findings,
        project: { id: projects.id, code: projects.code, name: projects.name },
        visitedBy: { id: visitor.id, name: visitor.name },
      })
      .from(siteVisits)
      .innerJoin(projects, eq(projects.id, siteVisits.projectId))
      .innerJoin(visitor, eq(visitor.id, siteVisits.visitedBy))
      .where(eq(siteVisits.visitDate, date)),
    ex
      .select({
        open: sql<number>`count(*)`,
        high: sql<string>`COALESCE(SUM(${fieldIssues.severity} = 'high'), 0)`,
      })
      .from(fieldIssues)
      .where(eq(fieldIssues.status, 'open')),
    ex
      .select({
        id: fieldIssues.id,
        title: fieldIssues.title,
        severity: fieldIssues.severity,
        status: fieldIssues.status,
        project: { id: projects.id, code: projects.code, name: projects.name },
        raisedBy: { id: raiser.id, name: raiser.name },
      })
      .from(fieldIssues)
      .innerJoin(projects, eq(projects.id, fieldIssues.projectId))
      .innerJoin(raiser, eq(raiser.id, fieldIssues.raisedBy))
      .where(and(gte(fieldIssues.createdAt, dayStart), lte(fieldIssues.createdAt, dayEnd))),
  ]);
  const metrics = await projectMetrics(ex, running);

  const summary: DailyOpsSummary = {
    activeProjects: running.length,
    progressReports: reports.length,
    siteVisits: visits.length,
    openIssues: Number(issueCounts?.open ?? 0),
    highSeverityIssues: Number(issueCounts?.high ?? 0),
    projects: running.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      percentComplete: metrics.get(p.id)?.percentComplete ?? null,
    })),
  };
  // Narratives are rich text; the day's overview shows them as short plain text.
  return {
    summary,
    details: {
      reports: reports.map((r) => ({ ...r, workCompleted: richTextToPlain(r.workCompleted) })),
      visits: visits.map((v) => ({ ...v, findings: richTextToPlain(v.findings) })),
      newIssues,
    },
  };
}

const dailyColumns = {
  id: dailyOpsReports.id,
  reportDate: dailyOpsReports.reportDate,
  summary: dailyOpsReports.summary,
  comments: dailyOpsReports.comments,
  createdAt: dailyOpsReports.createdAt,
  updatedAt: dailyOpsReports.updatedAt,
  submittedBy: { id: submitter.id, name: submitter.name },
};

export const dailyOpsService = {
  /** Only the person who submitted the report attaches files to it. */
  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const [row] = await db
      .select({ submittedBy: dailyOpsReports.submittedBy })
      .from(dailyOpsReports)
      .where(eq(dailyOpsReports.id, id));
    return row?.submittedBy === user.id;
  },

  /**
   * FR-OPS-07: the day's activity for the Ops Manager to review before submitting.
   * Returns the `DailyOpsSummary` fields plus the underlying records and any report the
   * user already submitted for that day.
   */
  async prefill(user: AuthUser, date = today()) {
    const [{ summary, details }, [existing]] = await Promise.all([
      buildSummary(db, date),
      db
        .select({ id: dailyOpsReports.id, comments: dailyOpsReports.comments })
        .from(dailyOpsReports)
        .where(and(eq(dailyOpsReports.submittedBy, user.id), eq(dailyOpsReports.reportDate, date))),
    ]);
    return { reportDate: date, ...summary, ...details, existingReport: existing ?? null };
  },

  /** US-OP-004: submit (one per user per day). Visible to Directors in departmental reports. */
  async submit(user: AuthUser, input: CreateDailyOpsInput) {
    const reportDate = input.reportDate ?? today();
    notFuture(reportDate, 'The report date');
    const id = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: dailyOpsReports.id })
        .from(dailyOpsReports)
        .where(
          and(eq(dailyOpsReports.submittedBy, user.id), eq(dailyOpsReports.reportDate, reportDate)),
        );
      if (existing) {
        throw AppError.conflict('You have already submitted the operations report for this day', {
          id: existing.id,
        });
      }
      const { summary } = await buildSummary(tx, reportDate);
      const [res] = await tx.insert(dailyOpsReports).values({
        reportDate,
        submittedBy: user.id,
        summary,
        comments: input.comments ?? null,
      });
      await auditService.log(
        {
          action: 'submit',
          entityType: 'daily_ops_report',
          entityId: res.insertId,
          newValues: { reportDate, comments: input.comments ?? null },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.REPORTS_OPERATIONS, tx),
          excludeUserId: user.id,
          type: 'field.daily_ops_report',
          title: `Daily operations report for ${reportDate}`,
          body: `${user.name}: ${summary.activeProjects} running projects, ${summary.progressReports} technician reports, ${summary.openIssues} open issues`,
          link: `/field/daily-ops/${res.insertId}`,
          entityType: 'daily_ops_report',
          entityId: res.insertId,
        },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(user: AuthUser, id: number, comments: string | null) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(dailyOpsReports)
        .where(eq(dailyOpsReports.id, id))
        .for('update');
      if (!row) throw AppError.notFound('Daily operations report');
      if (row.submittedBy !== user.id) throw AppError.forbidden();
      await tx.update(dailyOpsReports).set({ comments }).where(eq(dailyOpsReports.id, id));
      await auditService.log(
        {
          action: 'update',
          entityType: 'daily_ops_report',
          entityId: id,
          oldValues: { comments: row.comments },
          newValues: { comments },
        },
        tx,
      );
    });
    return this.get(id);
  },

  async list(query: DailyOpsListQuery) {
    const filters: (SQL | undefined)[] = [];
    if (query.from) filters.push(gte(dailyOpsReports.reportDate, query.from));
    if (query.to) filters.push(lte(dailyOpsReports.reportDate, query.to));
    if (query.submittedBy) filters.push(eq(dailyOpsReports.submittedBy, query.submittedBy));
    if (query.search) filters.push(like(dailyOpsReports.comments, `%${query.search}%`));
    const where = and(...filters);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(dailyColumns)
        .from(dailyOpsReports)
        .innerJoin(submitter, eq(submitter.id, dailyOpsReports.submittedBy))
        .where(where)
        .orderBy(desc(dailyOpsReports.reportDate), desc(dailyOpsReports.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(dailyOpsReports)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async get(id: number) {
    const [row] = await db
      .select(dailyColumns)
      .from(dailyOpsReports)
      .innerJoin(submitter, eq(submitter.id, dailyOpsReports.submittedBy))
      .where(eq(dailyOpsReports.id, id));
    if (!row) throw AppError.notFound('Daily operations report');
    return row;
  },
};
