import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import {
  createTaskSchema,
  myTasksQuerySchema,
  performanceQuerySchema,
  taskListQuerySchema,
  taskStatusSchema,
  updateTaskSchema,
} from './tasks.schema.js';
import { taskService } from './tasks.service.js';

const ANY_TASK_ACCESS = [P.TASKS_VIEW, P.TASKS_VIEW_ASSIGNED, P.TASKS_MANAGE] as const;

export const tasksRouter = Router();

/** US-TECH-004 — every signed-in user can list the tasks assigned to them. */
tasksRouter.get(
  '/mine',
  route({ query: myTasksQuerySchema }, ({ query, user }) =>
    taskService.mine(user, query.includeDone),
  ),
);

/** FR-TSK-04, US-BD-005 */
tasksRouter.get(
  '/performance',
  authorize([P.TASKS_VIEW, P.REPORTS_BUSINESS], 'any'),
  route({ query: performanceQuerySchema }, ({ query }) => taskService.performance(query)),
);

/** Visibility (all vs own) is enforced in the service. */
tasksRouter.get(
  '/',
  authorize(ANY_TASK_ACCESS, 'any'),
  route({ query: taskListQuerySchema }, ({ query, user }) => taskService.list(user, query)),
);

tasksRouter.post(
  '/',
  authorize(P.TASKS_MANAGE),
  route({ body: createTaskSchema, status: 201 }, ({ body, user }) =>
    taskService.create(user, body),
  ),
);

tasksRouter.get(
  '/:id',
  route({ params: idParamSchema }, ({ params, user }) => taskService.get(user, params.id)),
);

tasksRouter.patch(
  '/:id',
  authorize(P.TASKS_MANAGE),
  route({ params: idParamSchema, body: updateTaskSchema }, ({ params, body, user }) =>
    taskService.update(user, params.id, body),
  ),
);

/** FR-TSK-02 — assignee or manager (checked in the service). */
tasksRouter.post(
  '/:id/status',
  route({ params: idParamSchema, body: taskStatusSchema }, ({ params, body, user }) =>
    taskService.setStatus(user, params.id, body.status),
  ),
);

tasksRouter.delete(
  '/:id',
  authorize(P.TASKS_MANAGE),
  route({ params: idParamSchema, status: 204 }, async ({ params, user }) => {
    await taskService.remove(user, params.id);
  }),
);
