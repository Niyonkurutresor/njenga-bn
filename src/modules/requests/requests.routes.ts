import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  createRequestSchema,
  disburseSchema,
  optionalCommentSchema,
  rejectSchema,
  requestListQuerySchema,
  requiredCommentSchema,
  resubmitRequestSchema,
} from './requests.schema.js';
import { requestService } from './requests.service.js';

// Attachments (quotes, receipts) follow the request's own access rules (FR-DOC-02).
registerDocumentEntity('request', {
  label: 'Request',
  canRead: (user, id) => requestService.canView(user, id),
  canWrite: (user, id) => requestService.canAttach(user, id),
});

export const requestsRouter = Router();

/** Visibility is enforced in the service: own requests, or all with a reviewing permission. */
requestsRouter.get(
  '/',
  route({ query: requestListQuerySchema }, ({ query, user }) => requestService.list(user, query)),
);

requestsRouter.get(
  '/summary',
  route({}, ({ user }) => requestService.statusCounts(user)),
);

requestsRouter.get(
  '/:id',
  route({ params: idParamSchema }, ({ params, user }) => requestService.get(user, params.id)),
);

requestsRouter.post(
  '/',
  authorize(P.REQUESTS_CREATE),
  route({ body: createRequestSchema, status: 201 }, ({ body, user }) =>
    requestService.create(user, body),
  ),
);

/** Workflow actions; each re-checks status and actor in the service (SRS 3.2.1). */
requestsRouter.post(
  '/:id/resubmit',
  route({ params: idParamSchema, body: resubmitRequestSchema }, ({ params, body, user }) =>
    requestService.resubmit(user, params.id, body),
  ),
);

requestsRouter.post(
  '/:id/forward',
  authorize(P.REQUESTS_REVIEW),
  route({ params: idParamSchema, body: optionalCommentSchema }, ({ params, body, user }) =>
    requestService.forward(user, params.id, body.comment),
  ),
);

requestsRouter.post(
  '/:id/return',
  authorize(P.REQUESTS_REVIEW),
  route({ params: idParamSchema, body: requiredCommentSchema }, ({ params, body, user }) =>
    requestService.returnForCorrection(user, params.id, body.comment),
  ),
);

requestsRouter.post(
  '/:id/approve',
  authorize(P.REQUESTS_APPROVE),
  route({ params: idParamSchema, body: optionalCommentSchema }, ({ params, body, user }) =>
    requestService.approve(user, params.id, body.comment),
  ),
);

requestsRouter.post(
  '/:id/reject',
  authorize(P.REQUESTS_APPROVE),
  route({ params: idParamSchema, body: rejectSchema }, ({ params, body, user }) =>
    requestService.reject(user, params.id, body.reason),
  ),
);

requestsRouter.post(
  '/:id/disburse',
  authorize(P.REQUESTS_DISBURSE),
  route({ params: idParamSchema, body: disburseSchema }, ({ params, body, user }) =>
    requestService.disburse(user, params.id, body),
  ),
);

requestsRouter.post(
  '/:id/comments',
  route({ params: idParamSchema, body: requiredCommentSchema }, ({ params, body, user }) =>
    requestService.comment(user, params.id, body.comment),
  ),
);
