import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditListQuerySchema, deletedQuerySchema, restoreSchema } from './audit.schema.js';
import { auditService } from './audit.service.js';
import { restoreService } from './restorable.js';

export const auditRouter = Router();

auditRouter.get(
  '/',
  authorize(P.AUDIT_VIEW),
  route({ query: auditListQuerySchema }, ({ query }) => auditService.list(query)),
);

auditRouter.get(
  '/deleted',
  authorize(P.RECORDS_RESTORE),
  route({ query: deletedQuerySchema }, ({ query }) => restoreService.listDeleted(query.entityType)),
);

auditRouter.post(
  '/restore',
  authorize(P.RECORDS_RESTORE),
  route({ body: restoreSchema, status: 204 }, async ({ body }) => {
    await restoreService.restore(body.entityType, body.entityId);
  }),
);
