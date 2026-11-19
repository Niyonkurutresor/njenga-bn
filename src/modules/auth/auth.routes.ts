import { Router } from 'express';
import { authenticate } from '../../common/middleware/authenticate.js';
import { authRateLimit } from '../../common/middleware/rate-limit.js';
import { route } from '../../common/http/route.js';
import { auditService } from '../audit/audit.service.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schema.js';
import { authService } from './auth.service.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  authRateLimit,
  route({ body: loginSchema }, ({ body }) => authService.login(body)),
);

authRouter.post(
  '/forgot-password',
  authRateLimit,
  route({ body: forgotPasswordSchema, status: 204 }, async ({ body }) => {
    await authService.forgotPassword(body.identifier);
  }),
);

authRouter.post(
  '/reset-password',
  authRateLimit,
  route({ body: resetPasswordSchema, status: 204 }, async ({ body }) => {
    await authService.resetPassword(body.token, body.password);
  }),
);

authRouter.get(
  '/me',
  authenticate,
  route({}, ({ user }) => authService.session(user.id)),
);

authRouter.patch(
  '/me',
  authenticate,
  route({ body: updateProfileSchema }, ({ body, user }) =>
    authService.updateProfile(user.id, body),
  ),
);

authRouter.post(
  '/change-password',
  authenticate,
  route({ body: changePasswordSchema, status: 204 }, async ({ body, user }) => {
    await authService.changePassword(user.id, body.currentPassword, body.newPassword);
  }),
);

/** JWTs are stateless; logout is recorded for the audit trail and the client drops the token. */
authRouter.post(
  '/logout',
  authenticate,
  route({ status: 204 }, async ({ user }) => {
    await auditService.log({ action: 'logout', entityType: 'user', entityId: user.id });
  }),
);
