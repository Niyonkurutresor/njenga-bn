import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { outerColumn } from '../../common/utils/sql.js';
import { db, type Executor } from '../../db/client.js';
import { fieldIssues, progressReports, projects, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { can } from '../../common/middleware/authorize.js';
import { today } from '../../common/utils/dates.js';
import { richTextToPlain } from '../../common/utils/rich-text.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { isTeamMember } from '../projects/projects.service.js';
import type {
  CreateIssueInput,
  CreateProgressReportInput,
  IssueListQuery,
  ProgressReportListQuery,
  RespondReportInput,
} from './field.schema.js';

type ReportRow = typeof progressReports.$inferSelect;
type IssueRow = typeof fieldIssues.$inferSelect;

const technician = alias(users, 'technician');
const reviewer = alias(users, 'reviewer');
const raiser = alias(users, 'raiser');
const resolver = alias(users, 'resolver');

export const reportLink = (id: number) => `/field/reports/${id}`;
const issueLink = (id: number) => `/field/issues?issueId=${id}`;

/** Ops / Directors / managers see every report; technicians only their own (matrix: Tech = C). */
export function seesAllReports(user: AuthUser): boolean {
  return can(user, P.FIELD_REPORTS_VIEW) || can(user, P.FIELD_REPORTS_VERIFY);
}

function seesAllIssues(user: AuthUser): boolean {
  return seesAllReports(user) || can(user, P.PROJECTS_MANAGE);
}

function canResolveIssues(user: AuthUser): boolean {
  return can(user, P.FIELD_REPORTS_VERIFY) || can(user, P.PROJECTS_MANAGE);
}

const photoCount = sql<number>`(SELECT COUNT(*) FROM documents d
  WHERE d.entity_type = 'progress_report' AND d.entity_id = ${outerColumn(progressReports.id)}
  AND d.deleted_at IS NULL)`;

const reportColumns = {
  id: progressReports.id,
  projectId: progressReports.projectId,
  technicianId: progressReports.technicianId,
  reportDate: progressReports.reportDate,
  workCompleted: progressReports.workCompleted,
  pendingWork: progressReports.pendingWork,
  percentComplete: progressReports.percentComplete,
  issuesSummary: progressReports.issuesSummary,
  latitude: progressReports.latitude,
  longitude: progressReports.longitude,
  status: progressReports.status,
  verifiedAt: progressReports.verifiedAt,
  queryComment: progressReports.queryComment,
  technicianResponse: progressReports.technicianResponse,
  createdAt: progressReports.createdAt,
  updatedAt: progressReports.updatedAt,
  photoCount,
  project: { id: projects.id, code: projects.code, name: projects.name },
  technician: { id: technician.id, name: technician.name },
  reviewer: { id: reviewer.id, name: reviewer.name },
};

const SORTS = {
  reportDate: progressReports.reportDate,
  createdAt: progressReports.createdAt,
  percentComplete: progressReports.percentComplete,
} as const;

function selectReports() {
  return db
    .select(reportColumns)
    .from(progressReports)
    .innerJoin(projects, eq(projects.id, progressReports.projectId))
    .innerJoin(technician, eq(technician.id, progressReports.technicianId))
    .leftJoin(reviewer, eq(reviewer.id, progressReports.verifiedBy));
}

type SelectedReport = Awaited<ReturnType<ReturnType<typeof selectReports>['execute']>>[number];

function presentReport(user: AuthUser, r: SelectedReport) {
  const own = r.technicianId === user.id;
  return {
    ...r,
    photoCount: Number(r.photoCount),
    reviewer: r.reviewer?.id ? r.reviewer : null,
    actions: {
      verify: can(user, P.FIELD_REPORTS_VERIFY) && r.status !== 'verified',
      query: can(user, P.FIELD_REPORTS_VERIFY) && r.status === 'submitted',
      respond: own && r.status === 'queried',
      attach: own && r.status !== 'verified',
    },
  };
}

async function lockReport(tx: Executor, id: number): Promise<ReportRow> {
  const [row] = await tx
    .select()
    .from(progressReports)
    .where(eq(progressReports.id, id))
    .for('update');
  if (!row) throw AppError.notFound('Progress report');
  return row;
}

async function lockIssue(tx: Executor, id: number): Promise<IssueRow> {
  const [row] = await tx.select().from(fieldIssues).where(eq(fieldIssues.id, id)).for('update');
  if (!row) throw AppError.notFound('Issue');
  return row;
}

async function projectHeader(ex: Executor, projectId: number) {
  const [p] = await ex
    .select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!p) throw AppError.rule('Project does not exist');
  return p;
}

/** Technicians may only report on projects they lead or belong to (FR-OPS-01). */
async function assertCanReportOn(ex: Executor, user: AuthUser, projectId: number) {
  if (seesAllReports(user)) return;
  if (!(await isTeamMember(ex, projectId, user.id))) {
    throw AppError.forbidden('You can only report on projects you are assigned to');
  }
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === 'ER_DUP_ENTRY' || e?.cause?.code === 'ER_DUP_ENTRY';
}

async function findByClientRef(clientRef: string) {
  const [row] = await db
    .select({ id: progressReports.id, technicianId: progressReports.technicianId })
    .from(progressReports)
    .where(eq(progressReports.clientRef, clientRef));
  return row;
}

export const progressReportService = {
  async canRead(user: AuthUser, id: number): Promise<boolean> {
    if (seesAllReports(user)) return true;
    const [row] = await db
      .select({ technicianId: progressReports.technicianId })
      .from(progressReports)
      .where(eq(progressReports.id, id));
    return row?.technicianId === user.id;
  },

  /** Photos can be added by the author until the report is verified (FR-OPS-02). */
  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const [row] = await db
      .select({ technicianId: progressReports.technicianId, status: progressReports.status })
      .from(progressReports)
      .where(eq(progressReports.id, id));
    return row?.technicianId === user.id && row.status !== 'verified';
  },

  async list(user: AuthUser, query: ProgressReportListQuery) {
    const filters: (SQL | undefined)[] = [isNull(projects.deletedAt)];
    if (!seesAllReports(user) || query.mine)
      filters.push(eq(progressReports.technicianId, user.id));
    if (query.status?.length) filters.push(inArray(progressReports.status, query.status));
    if (query.projectId) filters.push(eq(progressReports.projectId, query.projectId));
    if (query.technicianId) filters.push(eq(progressReports.technicianId, query.technicianId));
    if (query.from) filters.push(gte(progressReports.reportDate, query.from));
    if (query.to) filters.push(lte(progressReports.reportDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(projects.code, term),
          like(projects.name, term),
          like(technician.name, term),
          like(progressReports.workCompleted, term),
        ),
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'reportDate'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      selectReports()
        .where(where)
        .orderBy(order, desc(progressReports.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(progressReports)
        .innerJoin(projects, eq(projects.id, progressReports.projectId))
        .innerJoin(technician, eq(technician.id, progressReports.technicianId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => presentReport(user, r)),
      Number(total),
      query,
    );
  },

  async get(user: AuthUser, id: number) {
    const [row] = await selectReports().where(eq(progressReports.id, id));
    if (!row) throw AppError.notFound('Progress report');
    if (!seesAllReports(user) && row.technicianId !== user.id) throw AppError.forbidden();
    const issues = await db
      .select({
        id: fieldIssues.id,
        title: fieldIssues.title,
        severity: fieldIssues.severity,
        status: fieldIssues.status,
      })
      .from(fieldIssues)
      .where(eq(fieldIssues.progressReportId, id))
      .orderBy(desc(fieldIssues.id));
    return { ...presentReport(user, row), issues };
  },

  /**
   * FR-OPS-01/03/08, US-TECH-001: technician submits a progress report. Idempotent on
   * `clientRef` so the offline outbox can retry safely.
   */
  async submit(user: AuthUser, input: CreateProgressReportInput) {
    if (input.clientRef) {
      const existing = await findByClientRef(input.clientRef);
      if (existing) {
        if (existing.technicianId !== user.id) throw AppError.conflict('Duplicate submission');
        return this.get(user, existing.id);
      }
    }
    const reportDate = input.reportDate ?? today();
    if (reportDate > today()) throw AppError.rule('A report cannot be dated in the future');

    let id: number;
    try {
      id = await db.transaction(async (tx) => {
        const project = await projectHeader(tx, input.projectId);
        if (project.status === 'closed') throw AppError.rule('This project is closed');
        await assertCanReportOn(tx, user, input.projectId);
        const [res] = await tx.insert(progressReports).values({
          projectId: input.projectId,
          technicianId: user.id,
          reportDate,
          // Empty when the narrative is an attached report file (Word/PDF).
          workCompleted: input.workCompleted ?? '',
          pendingWork: input.pendingWork ?? null,
          percentComplete: input.percentComplete,
          issuesSummary: input.issuesSummary ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          clientRef: input.clientRef ?? null,
          status: 'submitted',
        });
        const reportId = res.insertId;
        await auditService.log(
          {
            action: 'submit',
            entityType: 'progress_report',
            entityId: reportId,
            newValues: { ...input, reportDate },
          },
          tx,
        );
        await notificationService.notify(
          {
            userIds: await notificationService.userIdsWithPermission(P.FIELD_REPORTS_VERIFY, tx),
            excludeUserId: user.id,
            type: 'field.report_submitted',
            title: `Progress report: ${project.code} at ${input.percentComplete}%`,
            body: `${user.name}: ${
              richTextToPlain(input.workCompleted).slice(0, 200) ||
              `${input.attachmentCount} file(s) attached`
            }`,
            link: reportLink(reportId),
            entityType: 'progress_report',
            entityId: reportId,
          },
          tx,
        );
        return reportId;
      });
    } catch (err) {
      // Two retries of the same offline submission raced: return the one that won.
      if (input.clientRef && isDuplicateKey(err)) {
        const existing = await findByClientRef(input.clientRef);
        if (existing?.technicianId === user.id) return this.get(user, existing.id);
      }
      throw err;
    }
    return this.get(user, id);
  },

  /** FR-OPS-05: Ops verifies a report; its % then drives project progress (FR-PRJ-05). */
  async verify(user: AuthUser, id: number, comment?: string) {
    await db.transaction(async (tx) => {
      const row = await lockReport(tx, id);
      if (row.status === 'verified') throw AppError.rule('This report is already verified');
      const patch = { status: 'verified' as const, verifiedBy: user.id, verifiedAt: new Date() };
      await tx.update(progressReports).set(patch).where(eq(progressReports.id, id));
      await auditService.log(
        {
          action: 'verify',
          entityType: 'progress_report',
          entityId: id,
          oldValues: { status: row.status },
          newValues: { ...patch, comment: comment ?? null },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.technicianId],
          excludeUserId: user.id,
          type: 'field.report_verified',
          title: `Your progress report of ${row.reportDate} was verified`,
          ...(comment ? { body: comment } : {}),
          link: reportLink(id),
          entityType: 'progress_report',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** FR-OPS-05: Ops queries a report; the technician is asked to respond (US-OP-003). */
  async query(user: AuthUser, id: number, comment: string) {
    await db.transaction(async (tx) => {
      const row = await lockReport(tx, id);
      if (row.status !== 'submitted') {
        throw AppError.rule(`A ${row.status} report cannot be queried`);
      }
      // `verifiedBy` records the reviewer, so their response goes back to them.
      const patch = {
        status: 'queried' as const,
        queryComment: comment,
        technicianResponse: null,
        verifiedBy: user.id,
        verifiedAt: null,
      };
      await tx.update(progressReports).set(patch).where(eq(progressReports.id, id));
      await auditService.log(
        {
          action: 'query',
          entityType: 'progress_report',
          entityId: id,
          oldValues: { status: row.status },
          newValues: patch,
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.technicianId],
          excludeUserId: user.id,
          type: 'field.report_queried',
          title: `Question on your progress report of ${row.reportDate}`,
          body: comment,
          link: reportLink(id),
          entityType: 'progress_report',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** US-OP-003 AC2: the technician responds; the report returns to the queue and Ops is notified. */
  async respond(user: AuthUser, id: number, input: RespondReportInput) {
    await db.transaction(async (tx) => {
      const row = await lockReport(tx, id);
      if (row.technicianId !== user.id) throw AppError.forbidden();
      if (row.status !== 'queried') throw AppError.rule('Only a queried report needs a response');
      const patch = {
        status: 'submitted' as const,
        technicianResponse: input.response,
        ...(input.workCompleted ? { workCompleted: input.workCompleted } : {}),
        ...(input.pendingWork !== undefined ? { pendingWork: input.pendingWork } : {}),
        ...(input.percentComplete !== undefined ? { percentComplete: input.percentComplete } : {}),
      };
      await tx.update(progressReports).set(patch).where(eq(progressReports.id, id));
      await auditService.log(
        {
          action: 'respond',
          entityType: 'progress_report',
          entityId: id,
          oldValues: { status: row.status, percentComplete: row.percentComplete },
          newValues: patch,
        },
        tx,
      );
      const recipients = row.verifiedBy
        ? [row.verifiedBy]
        : await notificationService.userIdsWithPermission(P.FIELD_REPORTS_VERIFY, tx);
      await notificationService.notify(
        {
          userIds: recipients,
          excludeUserId: user.id,
          type: 'field.report_response',
          title: `${user.name} responded to your query`,
          body: input.response.slice(0, 300),
          link: reportLink(id),
          entityType: 'progress_report',
          entityId: id,
        },
        tx,
      );
    });
    return this.get(user, id);
  },
};

// ---------------- Issues ----------------

const issueColumns = {
  id: fieldIssues.id,
  projectId: fieldIssues.projectId,
  progressReportId: fieldIssues.progressReportId,
  title: fieldIssues.title,
  description: fieldIssues.description,
  severity: fieldIssues.severity,
  status: fieldIssues.status,
  resolution: fieldIssues.resolution,
  resolvedAt: fieldIssues.resolvedAt,
  createdAt: fieldIssues.createdAt,
  raisedById: fieldIssues.raisedBy,
  project: { id: projects.id, code: projects.code, name: projects.name },
  raisedBy: { id: raiser.id, name: raiser.name },
  resolvedBy: { id: resolver.id, name: resolver.name },
};

function selectIssues() {
  return db
    .select(issueColumns)
    .from(fieldIssues)
    .innerJoin(projects, eq(projects.id, fieldIssues.projectId))
    .innerJoin(raiser, eq(raiser.id, fieldIssues.raisedBy))
    .leftJoin(resolver, eq(resolver.id, fieldIssues.resolvedBy));
}

type SelectedIssue = Awaited<ReturnType<ReturnType<typeof selectIssues>['execute']>>[number];

function presentIssue(user: AuthUser, r: SelectedIssue) {
  const { raisedById, ...rest } = r;
  return {
    ...rest,
    resolvedBy: r.resolvedBy?.id ? r.resolvedBy : null,
    canResolve: r.status === 'open' && canResolveIssues(user),
    isMine: raisedById === user.id,
  };
}

const SEVERITY_ORDER = sql`FIELD(${fieldIssues.severity}, 'high', 'medium', 'low')`;

export const issueService = {
  async list(user: AuthUser, query: IssueListQuery) {
    const filters: (SQL | undefined)[] = [isNull(projects.deletedAt)];
    if (!seesAllIssues(user) || query.mine) filters.push(eq(fieldIssues.raisedBy, user.id));
    if (query.status) filters.push(eq(fieldIssues.status, query.status));
    if (query.severity) filters.push(eq(fieldIssues.severity, query.severity));
    if (query.projectId) filters.push(eq(fieldIssues.projectId, query.projectId));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(fieldIssues.title, term), like(projects.code, term), like(projects.name, term)),
      );
    }
    const where = and(...filters);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      selectIssues()
        .where(where)
        // Open first, most severe first, newest first.
        .orderBy(asc(fieldIssues.status), SEVERITY_ORDER, desc(fieldIssues.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(fieldIssues)
        .innerJoin(projects, eq(projects.id, fieldIssues.projectId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => presentIssue(user, r)),
      Number(total),
      query,
    );
  },

  async get(user: AuthUser, id: number) {
    const [row] = await selectIssues().where(eq(fieldIssues.id, id));
    if (!row) throw AppError.notFound('Issue');
    if (!seesAllIssues(user) && row.raisedById !== user.id) throw AppError.forbidden();
    return presentIssue(user, row);
  },

  /** FR-OPS-04: high severity notifies Ops immediately by in-app, email and SMS. */
  async raise(user: AuthUser, input: CreateIssueInput) {
    const id = await db.transaction(async (tx) => {
      const project = await projectHeader(tx, input.projectId);
      await assertCanReportOn(tx, user, input.projectId);
      if (input.progressReportId) {
        const [report] = await tx
          .select({ projectId: progressReports.projectId })
          .from(progressReports)
          .where(eq(progressReports.id, input.progressReportId));
        if (report?.projectId !== input.projectId) {
          throw AppError.rule('The linked report belongs to another project');
        }
      }
      const [res] = await tx.insert(fieldIssues).values({
        projectId: input.projectId,
        progressReportId: input.progressReportId ?? null,
        raisedBy: user.id,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity,
        status: 'open',
      });
      const issueId = res.insertId;
      await auditService.log(
        { action: 'create', entityType: 'field_issue', entityId: issueId, newValues: { ...input } },
        tx,
      );
      const high = input.severity === 'high';
      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.FIELD_REPORTS_VERIFY, tx),
          excludeUserId: user.id,
          type: high ? 'field.issue_high' : 'field.issue',
          title: `${high ? 'URGENT: high-severity issue' : `New ${input.severity} issue`} on ${project.code}`,
          body: `${input.title} — raised by ${user.name}`,
          link: issueLink(issueId),
          entityType: 'field_issue',
          entityId: issueId,
          email: high,
          sms: high,
          critical: high,
        },
        tx,
      );
      return issueId;
    });
    return this.get(user, id);
  },

  /** US-TECH-003 AC2: resolving an issue notifies the person who raised it. */
  async resolve(user: AuthUser, id: number, resolution: string) {
    await db.transaction(async (tx) => {
      const row = await lockIssue(tx, id);
      if (row.status !== 'open') throw AppError.rule('This issue is already resolved');
      const patch = {
        status: 'resolved' as const,
        resolution,
        resolvedBy: user.id,
        resolvedAt: new Date(),
      };
      await tx.update(fieldIssues).set(patch).where(eq(fieldIssues.id, id));
      await auditService.log(
        {
          action: 'resolve',
          entityType: 'field_issue',
          entityId: id,
          oldValues: { status: row.status },
          newValues: patch,
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [row.raisedBy],
          excludeUserId: user.id,
          type: 'field.issue_resolved',
          title: `Issue resolved: ${row.title}`,
          body: richTextToPlain(resolution).slice(0, 500),
          link: issueLink(id),
          entityType: 'field_issue',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },
};
