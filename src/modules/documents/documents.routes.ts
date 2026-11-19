import { Router } from 'express';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { MAX_FILES_PER_UPLOAD, upload } from '../../common/middleware/upload.js';
import { registeredDocumentEntities } from './document-registry.js';
import { documentSearchSchema, entityRefSchema } from './documents.schema.js';
import { documentsService } from './documents.service.js';

/**
 * Attachments for any registered record. Access is delegated to the owning module's policy,
 * so these routes only require authentication.
 */
export const documentsRouter = Router();

documentsRouter.get(
  '/entity-types',
  route({}, () => registeredDocumentEntities()),
);

documentsRouter.get(
  '/search',
  route({ query: documentSearchSchema }, ({ query, user }) => documentsService.search(user, query)),
);

documentsRouter.get(
  '/',
  route({ query: entityRefSchema }, ({ query, user }) =>
    documentsService.list(user, query.entityType, query.entityId),
  ),
);

/** multipart/form-data: entityType, entityId, files[] (max 10, 10 MB each). */
documentsRouter.post(
  '/',
  upload.array('files', MAX_FILES_PER_UPLOAD),
  route({ body: entityRefSchema, status: 201 }, ({ body, user, req }) =>
    documentsService.upload(
      user,
      body.entityType,
      body.entityId,
      (req.files as Express.Multer.File[]) ?? [],
    ),
  ),
);

documentsRouter.delete(
  '/:id',
  route({ params: idParamSchema, status: 204 }, async ({ params, user }) => {
    await documentsService.remove(user, params.id);
  }),
);
