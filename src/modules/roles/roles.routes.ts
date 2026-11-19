import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSION_GROUPS, PERMISSIONS as P } from '../../rbac/permissions.js';
import { createRoleSchema, updateRoleSchema } from './roles.schema.js';
import { rolesService } from './roles.service.js';

export const rolesRouter = Router();

/** Permission catalogue grouped by module, for the role editor. */
rolesRouter.get(
  '/permissions',
  authorize(P.ROLES_VIEW),
  route({}, () => PERMISSION_GROUPS),
);

rolesRouter.get(
  '/',
  authorize(P.ROLES_VIEW),
  route({}, () => rolesService.list()),
);

rolesRouter.get(
  '/:id',
  authorize(P.ROLES_VIEW),
  route({ params: idParamSchema }, ({ params }) => rolesService.get(params.id)),
);

rolesRouter.post(
  '/',
  authorize(P.ROLES_MANAGE),
  route({ body: createRoleSchema, status: 201 }, ({ body }) => rolesService.create(body)),
);

rolesRouter.patch(
  '/:id',
  authorize(P.ROLES_MANAGE),
  route({ params: idParamSchema, body: updateRoleSchema }, ({ params, body }) =>
    rolesService.update(params.id, body),
  ),
);

rolesRouter.delete(
  '/:id',
  authorize(P.ROLES_MANAGE),
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await rolesService.remove(params.id);
  }),
);
