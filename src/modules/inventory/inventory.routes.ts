import { Router } from 'express';
import { authorize, can } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  adjustSchema,
  createMaterialSchema,
  issueSchema,
  materialListQuerySchema,
  movementListQuerySchema,
  receiveSchema,
  updateMaterialSchema,
} from './inventory.schema.js';
import { inventoryService } from './inventory.service.js';

// Delivery notes, invoices and import documents on a material (FR-DOC-02).
registerDocumentEntity('material', {
  label: 'Material',
  canRead: async (user) => can(user, P.INVENTORY_VIEW),
  canWrite: async (user) => can(user, P.INVENTORY_MANAGE),
});

export const inventoryRouter = Router();

const VIEW = authorize(P.INVENTORY_VIEW);
const MANAGE = authorize(P.INVENTORY_MANAGE);

inventoryRouter.get(
  '/summary',
  VIEW,
  route({}, () => inventoryService.summary()),
);

inventoryRouter.get(
  '/movements',
  VIEW,
  route({ query: movementListQuerySchema }, ({ query }) => inventoryService.movements(query)),
);

// ---------------- Materials (FR-INV-01) ----------------

inventoryRouter.get(
  '/materials',
  VIEW,
  route({ query: materialListQuerySchema }, ({ query }) => inventoryService.list(query)),
);

inventoryRouter.get(
  '/materials/options',
  VIEW,
  route({}, () => inventoryService.options()),
);

inventoryRouter.get(
  '/materials/:id',
  VIEW,
  route({ params: idParamSchema }, ({ params }) => inventoryService.get(params.id)),
);

inventoryRouter.get(
  '/materials/:id/movements',
  VIEW,
  route({ params: idParamSchema, query: movementListQuerySchema }, ({ params, query }) =>
    inventoryService.movements({ ...query, materialId: params.id }),
  ),
);

inventoryRouter.post(
  '/materials',
  MANAGE,
  route({ body: createMaterialSchema, status: 201 }, ({ body }) => inventoryService.create(body)),
);

inventoryRouter.patch(
  '/materials/:id',
  MANAGE,
  route({ params: idParamSchema, body: updateMaterialSchema }, ({ params, body }) =>
    inventoryService.update(params.id, body),
  ),
);

inventoryRouter.delete(
  '/materials/:id',
  MANAGE,
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await inventoryService.remove(params.id);
  }),
);

// ---------------- Stock movements (FR-INV-02..04) ----------------

inventoryRouter.post(
  '/materials/:id/receive',
  MANAGE,
  route({ params: idParamSchema, body: receiveSchema }, ({ params, body, user }) =>
    inventoryService.receive(user, params.id, body),
  ),
);

inventoryRouter.post(
  '/materials/:id/issue',
  MANAGE,
  route({ params: idParamSchema, body: issueSchema }, ({ params, body, user }) =>
    inventoryService.issue(user, params.id, body),
  ),
);

inventoryRouter.post(
  '/materials/:id/adjust',
  MANAGE,
  route({ params: idParamSchema, body: adjustSchema }, ({ params, body, user }) =>
    inventoryService.adjust(user, params.id, body),
  ),
);
