import { Router } from 'express';
import { authorize, can } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  createDailyOpsSchema,
  createIssueSchema,
  createProgressReportSchema,
  dailyOpsListQuerySchema,
  dailyOpsPrefillQuerySchema,
  issueListQuerySchema,
  progressReportListQuerySchema,
  queryReportSchema,
  resolveIssueSchema,
  respondReportSchema,
  siteVisitListQuerySchema,
  siteVisitSchema,
  updateDailyOpsSchema,
  updateSiteVisitSchema,
  verifyReportSchema,
} from './field.schema.js';
import { issueService, progressReportService } from './field.service.js';
import { dailyOpsService, siteVisitService } from './operations.service.js';

// Report attachments accept photos AND report files (PDF, Word, Excel): any type the upload
// middleware allows (ALLOWED_MIME_TYPES), so a report can be written in the app or shared as a file.

// FR-OPS-02: up to 10 photos per progress report (limited in the form) plus report files;
// the author adds them until the report is verified.
registerDocumentEntity('progress_report', {
  label: 'Progress report',
  canRead: (user, id) => progressReportService.canRead(user, id),
  canWrite: (user, id) => progressReportService.canAttach(user, id),
  maxFiles: 15,
});

// FR-OPS-06: site visit photos and inspection reports, recorded by Ops.
registerDocumentEntity('site_visit', {
  label: 'Site visit',
  canRead: (user) => Promise.resolve(siteVisitService.canRead(user)),
  canWrite: (user) => Promise.resolve(can(user, P.FIELD_REPORTS_VERIFY)),
  maxFiles: 20,
});

// FR-OPS-07: the Ops Manager may share the daily report as a file as well.
registerDocumentEntity('daily_ops_report', {
  label: 'Daily operations report',
  canRead: (user) =>
    Promise.resolve(
      [P.FIELD_REPORTS_VIEW, P.REPORTS_OPERATIONS, P.OPS_REPORTS_SUBMIT].some((p) => can(user, p)),
    ),
  canWrite: (user, id) => dailyOpsService.canAttach(user, id),
  maxFiles: 10,
});

const REPORT_ACCESS = [
  P.FIELD_REPORTS_VIEW,
  P.FIELD_REPORTS_SUBMIT,
  P.FIELD_REPORTS_VERIFY,
] as const;
const ISSUE_ACCESS = [...REPORT_ACCESS, P.PROJECTS_MANAGE] as const;
const VISIT_ACCESS = [P.FIELD_REPORTS_VIEW, P.FIELD_REPORTS_VERIFY, P.PROJECTS_VIEW] as const;
const DAILY_OPS_ACCESS = [
  P.FIELD_REPORTS_VIEW,
  P.REPORTS_OPERATIONS,
  P.OPS_REPORTS_SUBMIT,
] as const;

export const fieldRouter = Router();

// ---------- Progress reports ----------

/** Technicians see their own; Ops / Directors all (service). */
fieldRouter.get(
  '/progress-reports',
  authorize(REPORT_ACCESS, 'any'),
  route({ query: progressReportListQuerySchema }, ({ query, user }) =>
    progressReportService.list(user, query),
  ),
);

/** FR-OPS-01, FR-OPS-08 (idempotent on clientRef). */
fieldRouter.post(
  '/progress-reports',
  authorize(P.FIELD_REPORTS_SUBMIT),
  route({ body: createProgressReportSchema, status: 201 }, ({ body, user }) =>
    progressReportService.submit(user, body),
  ),
);

fieldRouter.get(
  '/progress-reports/:id',
  authorize(REPORT_ACCESS, 'any'),
  route({ params: idParamSchema }, ({ params, user }) =>
    progressReportService.get(user, params.id),
  ),
);

/** FR-OPS-05 */
fieldRouter.post(
  '/progress-reports/:id/verify',
  authorize(P.FIELD_REPORTS_VERIFY),
  route({ params: idParamSchema, body: verifyReportSchema }, ({ params, body, user }) =>
    progressReportService.verify(user, params.id, body.comment),
  ),
);

fieldRouter.post(
  '/progress-reports/:id/query',
  authorize(P.FIELD_REPORTS_VERIFY),
  route({ params: idParamSchema, body: queryReportSchema }, ({ params, body, user }) =>
    progressReportService.query(user, params.id, body.comment),
  ),
);

/** US-OP-003 AC2 — the author only (service). */
fieldRouter.post(
  '/progress-reports/:id/respond',
  authorize(P.FIELD_REPORTS_SUBMIT),
  route({ params: idParamSchema, body: respondReportSchema }, ({ params, body, user }) =>
    progressReportService.respond(user, params.id, body),
  ),
);

// ---------- Issues ----------

fieldRouter.get(
  '/issues',
  authorize(ISSUE_ACCESS, 'any'),
  route({ query: issueListQuerySchema }, ({ query, user }) => issueService.list(user, query)),
);

/** FR-OPS-04 */
fieldRouter.post(
  '/issues',
  authorize([P.FIELD_REPORTS_SUBMIT, P.FIELD_REPORTS_VERIFY], 'any'),
  route({ body: createIssueSchema, status: 201 }, ({ body, user }) =>
    issueService.raise(user, body),
  ),
);

fieldRouter.get(
  '/issues/:id',
  authorize(ISSUE_ACCESS, 'any'),
  route({ params: idParamSchema }, ({ params, user }) => issueService.get(user, params.id)),
);

/** US-TECH-003 AC2 */
fieldRouter.post(
  '/issues/:id/resolve',
  authorize([P.FIELD_REPORTS_VERIFY, P.PROJECTS_MANAGE], 'any'),
  route({ params: idParamSchema, body: resolveIssueSchema }, ({ params, body, user }) =>
    issueService.resolve(user, params.id, body.resolution ?? ''),
  ),
);

// ---------- Site visits (FR-OPS-06) ----------

fieldRouter.get(
  '/site-visits',
  authorize(VISIT_ACCESS, 'any'),
  route({ query: siteVisitListQuerySchema }, ({ query }) => siteVisitService.list(query)),
);

fieldRouter.post(
  '/site-visits',
  authorize(P.FIELD_REPORTS_VERIFY),
  route({ body: siteVisitSchema, status: 201 }, ({ body, user }) =>
    siteVisitService.create(user, body),
  ),
);

fieldRouter.get(
  '/site-visits/:id',
  authorize(VISIT_ACCESS, 'any'),
  route({ params: idParamSchema }, ({ params }) => siteVisitService.get(params.id)),
);

fieldRouter.patch(
  '/site-visits/:id',
  authorize(P.FIELD_REPORTS_VERIFY),
  route({ params: idParamSchema, body: updateSiteVisitSchema }, ({ params, body }) =>
    siteVisitService.update(params.id, body),
  ),
);

// ---------- Daily operations report (FR-OPS-07, US-OP-004) ----------

fieldRouter.get(
  '/daily-ops/prefill',
  authorize(P.OPS_REPORTS_SUBMIT),
  route({ query: dailyOpsPrefillQuerySchema }, ({ query, user }) =>
    dailyOpsService.prefill(user, query.date),
  ),
);

fieldRouter.get(
  '/daily-ops',
  authorize(DAILY_OPS_ACCESS, 'any'),
  route({ query: dailyOpsListQuerySchema }, ({ query }) => dailyOpsService.list(query)),
);

fieldRouter.post(
  '/daily-ops',
  authorize(P.OPS_REPORTS_SUBMIT),
  route({ body: createDailyOpsSchema, status: 201 }, ({ body, user }) =>
    dailyOpsService.submit(user, body),
  ),
);

fieldRouter.get(
  '/daily-ops/:id',
  authorize(DAILY_OPS_ACCESS, 'any'),
  route({ params: idParamSchema }, ({ params }) => dailyOpsService.get(params.id)),
);

fieldRouter.patch(
  '/daily-ops/:id',
  authorize(P.OPS_REPORTS_SUBMIT),
  route({ params: idParamSchema, body: updateDailyOpsSchema }, ({ params, body, user }) =>
    dailyOpsService.update(user, params.id, body.comments ?? null),
  ),
);
