import { Router } from 'express';
import { z } from 'zod';
import { route } from '../../common/http/route.js';
import { idParamSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { notificationService } from './notifications.service.js';

/** Every authenticated user manages their own notifications. */
export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  route({ query: listQuerySchema.extend({ unread: queryBoolean }) }, ({ query, user }) =>
    notificationService.list(user.id, query),
  ),
);

notificationsRouter.get(
  '/unread-count',
  route({}, async ({ user }) => ({ count: await notificationService.unreadCount(user.id) })),
);

notificationsRouter.post(
  '/read-all',
  route({ status: 204 }, async ({ user }) => {
    await notificationService.markAllRead(user.id);
  }),
);

notificationsRouter.post(
  '/:id/read',
  route({ params: idParamSchema, status: 204 }, async ({ params, user }) => {
    await notificationService.markRead(user.id, params.id);
  }),
);

notificationsRouter.get(
  '/preferences',
  route({}, ({ user }) => notificationService.getPreferences(user.id)),
);

notificationsRouter.put(
  '/preferences',
  route(
    {
      body: z.object({
        type: z.string().min(1).max(60),
        emailEnabled: z.boolean(),
        smsEnabled: z.boolean(),
      }),
      status: 204,
    },
    async ({ body, user }) => {
      await notificationService.setPreference(user.id, body);
    },
  ),
);
