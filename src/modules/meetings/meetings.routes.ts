import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  actionPointParamSchema,
  actionPointSchema,
  actionPointTaskSchema,
  cancelMeetingSchema,
  createMeetingSchema,
  meetingListQuerySchema,
  minutesSchema,
  updateActionPointSchema,
  updateMeetingSchema,
} from './meetings.schema.js';
import { meetingService } from './meetings.service.js';

// Presentations and signed minutes follow the meeting's visibility (FR-DOC-02).
registerDocumentEntity('meeting', {
  label: 'Meeting',
  canRead: (user, id) => meetingService.canView(user, id),
  canWrite: (user, id) => meetingService.canAttach(user, id),
});

export const meetingsRouter = Router();

const MANAGE = authorize(P.MEETINGS_MANAGE);

/** Every signed-in user sees the meetings they organise or attend (Directors: all). */
meetingsRouter.get(
  '/',
  route({ query: meetingListQuerySchema }, ({ query, user }) => meetingService.list(user, query)),
);

meetingsRouter.get(
  '/:id',
  route({ params: idParamSchema }, ({ params, user }) => meetingService.get(user, params.id)),
);

/** FR-MTG-01/02. Edits are limited to the organizer or a Director in the service. */
meetingsRouter.post(
  '/',
  MANAGE,
  route({ body: createMeetingSchema, status: 201 }, ({ body, user }) =>
    meetingService.create(user, body),
  ),
);

meetingsRouter.patch(
  '/:id',
  MANAGE,
  route({ params: idParamSchema, body: updateMeetingSchema }, ({ params, body, user }) =>
    meetingService.update(user, params.id, body),
  ),
);

meetingsRouter.post(
  '/:id/cancel',
  MANAGE,
  route({ params: idParamSchema, body: cancelMeetingSchema }, ({ params, body, user }) =>
    meetingService.cancel(user, params.id, body.reason),
  ),
);

meetingsRouter.delete(
  '/:id',
  MANAGE,
  route({ params: idParamSchema, status: 204 }, async ({ params, user }) => {
    await meetingService.remove(user, params.id);
  }),
);

// ---------------- Minutes & action points (FR-MTG-03) ----------------

meetingsRouter.put(
  '/:id/minutes',
  MANAGE,
  route({ params: idParamSchema, body: minutesSchema }, ({ params, body, user }) =>
    meetingService.saveMinutes(user, params.id, body),
  ),
);

meetingsRouter.post(
  '/:id/action-points',
  MANAGE,
  route({ params: idParamSchema, body: actionPointSchema, status: 201 }, ({ params, body, user }) =>
    meetingService.addActionPoint(user, params.id, body),
  ),
);

meetingsRouter.patch(
  '/:id/action-points/:apId',
  MANAGE,
  route(
    { params: actionPointParamSchema, body: updateActionPointSchema },
    ({ params, body, user }) =>
      meetingService.updateActionPoint(user, params.id, params.apId, body),
  ),
);

meetingsRouter.delete(
  '/:id/action-points/:apId',
  MANAGE,
  route({ params: actionPointParamSchema }, ({ params, user }) =>
    meetingService.removeActionPoint(user, params.id, params.apId),
  ),
);

meetingsRouter.post(
  '/:id/action-points/:apId/task',
  MANAGE,
  route(
    { params: actionPointParamSchema, body: actionPointTaskSchema, status: 201 },
    ({ params, body, user }) => meetingService.convertToTask(user, params.id, params.apId, body),
  ),
);
