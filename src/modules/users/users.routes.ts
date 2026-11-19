import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import {
  createUserSchema,
  setPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  userOptionsQuerySchema,
} from './users.schema.js';
import { usersService } from './users.service.js';

export const usersRouter = Router();

/** Any signed-in user may list active colleagues (id, name, role) for pickers. */
usersRouter.get(
  '/options',
  route({ query: userOptionsQuerySchema }, ({ query }) => usersService.options(query)),
);

usersRouter.get(
  '/',
  authorize(P.USERS_VIEW),
  route({ query: userListQuerySchema }, ({ query }) => usersService.list(query)),
);

usersRouter.get(
  '/:id',
  authorize(P.USERS_VIEW),
  route({ params: idParamSchema }, ({ params }) => usersService.get(params.id)),
);

usersRouter.post(
  '/',
  authorize(P.USERS_MANAGE),
  route({ body: createUserSchema, status: 201 }, ({ body }) => usersService.create(body)),
);

usersRouter.patch(
  '/:id',
  authorize(P.USERS_MANAGE),
  route({ params: idParamSchema, body: updateUserSchema }, ({ params, body }) =>
    usersService.update(params.id, body),
  ),
);

usersRouter.post(
  '/:id/deactivate',
  authorize(P.USERS_MANAGE),
  route({ params: idParamSchema }, ({ params, user }) =>
    usersService.setStatus(params.id, 'inactive', user.id),
  ),
);

usersRouter.post(
  '/:id/reactivate',
  authorize(P.USERS_MANAGE),
  route({ params: idParamSchema }, ({ params, user }) =>
    usersService.setStatus(params.id, 'active', user.id),
  ),
);

usersRouter.post(
  '/:id/password',
  authorize(P.USERS_MANAGE),
  route(
    { params: idParamSchema, body: setPasswordSchema, status: 204 },
    async ({ params, body }) => {
      await usersService.setPassword(params.id, body.password);
    },
  ),
);
