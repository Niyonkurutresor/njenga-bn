import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import { reportRequestService } from './report-requests.service.js';
import {
  createReportRequestSchema,
  deliverReportRequestSchema,
  departmentalQuerySchema,
  exportQuerySchema,
  reportKeyParamSchema,
  reportQuerySchema,
  reportRequestListSchema,
  snapshotDateParamSchema,
  snapshotQuerySchema,
} from './reports.schema.js';
import { reportsService } from './reports.service.js';

// Delivered report files: readable by requester / assignee / report requesters; the assignee uploads.
registerDocumentEntity('report_request', {
  label: 'Report request',
  canRead: (user, id) => reportRequestService.canView(user, id),
  canWrite: (user, id) => reportRequestService.canAttach(user, id),
  maxFiles: 20,
});

const ANY_REPORT = [
  P.REPORTS_FINANCE,
  P.REPORTS_PROJECTS,
  P.REPORTS_OPERATIONS,
  P.REPORTS_FARM,
  P.REPORTS_BUSINESS,
] as const;

export const reportsRouter = Router();

/** Catalogue of the reports this user may open (FR-RPT-01). */
reportsRouter.get(
  '/',
  route({}, ({ user }) => reportsService.catalogue(user)),
);

/** US-CEO-002: latest report per department; missing daily reports flagged. */
reportsRouter.get(
  '/departmental',
  authorize([P.REPORT_REQUESTS_CREATE, ...ANY_REPORT], 'any'),
  route({ query: departmentalQuerySchema }, ({ query }) => reportsService.departmental(query.date)),
);

/** FR-RPT-02: stored daily financial reports. */
reportsRouter.get(
  '/daily-financial/snapshots',
  authorize(P.REPORTS_FINANCE),
  route({ query: snapshotQuerySchema }, ({ query }) => reportsService.snapshots(query)),
);

reportsRouter.get(
  '/daily-financial/snapshots/:date',
  authorize(P.REPORTS_FINANCE),
  route({ params: snapshotDateParamSchema }, ({ params }) => reportsService.snapshot(params.date)),
);

// ---------- Report requests (FR-RPT-04). Anyone can be an assignee; the service checks access.

reportsRouter.get(
  '/requests',
  route({ query: reportRequestListSchema }, ({ query, user }) =>
    reportRequestService.list(user, query),
  ),
);

reportsRouter.get(
  '/requests/counts',
  route({}, ({ user }) => reportRequestService.counts(user)),
);

reportsRouter.post(
  '/requests',
  authorize(P.REPORT_REQUESTS_CREATE),
  route({ body: createReportRequestSchema, status: 201 }, ({ body, user }) =>
    reportRequestService.create(user, body),
  ),
);

reportsRouter.get(
  '/requests/:id',
  route({ params: idParamSchema }, ({ params, user }) => reportRequestService.get(user, params.id)),
);

reportsRouter.post(
  '/requests/:id/deliver',
  route({ params: idParamSchema, body: deliverReportRequestSchema }, ({ params, body, user }) =>
    reportRequestService.deliver(user, params.id, body),
  ),
);

reportsRouter.post(
  '/requests/:id/cancel',
  route({ params: idParamSchema }, ({ params, user }) =>
    reportRequestService.cancel(user, params.id),
  ),
);

// ---------- Report data and exports (registered last: `/:key` is a catch-all).

reportsRouter.get(
  '/:key',
  authorize([...ANY_REPORT], 'any'),
  route({ params: reportKeyParamSchema, query: reportQuerySchema }, ({ params, query, user }) =>
    reportsService.run(user, params.key, query),
  ),
);

/** FR-RPT-03: PDF / Excel download (also needs the report's own permission). */
reportsRouter.get(
  '/:key/export',
  authorize(P.REPORTS_EXPORT),
  route(
    { params: reportKeyParamSchema, query: exportQuerySchema },
    ({ params, query, user, res }) => reportsService.export(user, params.key, query, res),
  ),
);
