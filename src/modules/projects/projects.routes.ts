import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  addMembersSchema,
  createProjectSchema,
  memberParamsSchema,
  plAnalysisSchema,
  profitabilityQuerySchema,
  projectListQuerySchema,
  projectOptionsQuerySchema,
  statusChangeSchema,
  updateProjectSchema,
  workloadQuerySchema,
} from './projects.schema.js';
import { projectService } from './projects.service.js';

// Contracts, drawings, handover documents (FR-DOC-02): readable by whoever sees the project.
registerDocumentEntity('project', {
  label: 'Project',
  canRead: (user, id) => projectService.canView(user, id),
  canWrite: (user, id) => projectService.canAttach(user, id),
});

const VIEW_ANY = [P.PROJECTS_VIEW, P.PROJECTS_VIEW_ASSIGNED] as const;

export const projectsRouter = Router();

/** Picker for forms (request form etc.). Visibility in the service; no permission → []. */
projectsRouter.get(
  '/options',
  route({ query: projectOptionsQuerySchema }, ({ query, user }) =>
    projectService.options(user, query.open),
  ),
);

/** US-BD-001 AC2 */
projectsRouter.get(
  '/workload',
  authorize([P.PROJECTS_VIEW, P.PROJECTS_MANAGE, P.TASKS_MANAGE], 'any'),
  route({ query: workloadQuerySchema }, ({ query }) => projectService.workload(query.search)),
);

/** US-OA-005, US-CEO-004 */
projectsRouter.get(
  '/profitability',
  authorize([P.PROJECTS_VIEW, P.REPORTS_PROJECTS], 'any'),
  route({ query: profitabilityQuerySchema }, ({ query }) => projectService.profitability(query)),
);

projectsRouter.get(
  '/',
  authorize(VIEW_ANY, 'any'),
  route({ query: projectListQuerySchema }, ({ query, user }) => projectService.list(user, query)),
);

projectsRouter.post(
  '/',
  authorize(P.PROJECTS_MANAGE),
  route({ body: createProjectSchema, status: 201 }, ({ body, user }) =>
    projectService.create(user, body),
  ),
);

projectsRouter.get(
  '/:id',
  authorize(VIEW_ANY, 'any'),
  route({ params: idParamSchema }, ({ params, user }) => projectService.get(user, params.id)),
);

projectsRouter.patch(
  '/:id',
  authorize(P.PROJECTS_MANAGE),
  route({ params: idParamSchema, body: updateProjectSchema }, ({ params, body, user }) =>
    projectService.update(user, params.id, body),
  ),
);

projectsRouter.delete(
  '/:id',
  authorize(P.PROJECTS_MANAGE),
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await projectService.remove(params.id);
  }),
);

/** FR-PRJ-04 */
projectsRouter.post(
  '/:id/members',
  authorize(P.PROJECTS_MANAGE),
  route({ params: idParamSchema, body: addMembersSchema }, ({ params, body, user }) =>
    projectService.addMembers(user, params.id, body.userIds),
  ),
);

projectsRouter.delete(
  '/:id/members/:userId',
  authorize(P.PROJECTS_MANAGE),
  route({ params: memberParamsSchema }, ({ params, user }) =>
    projectService.removeMember(user, params.id, params.userId),
  ),
);

/** FR-PRJ-02/03, BRL-07 — gates enforced in projects.rules.ts. */
projectsRouter.post(
  '/:id/status',
  authorize(P.PROJECTS_MANAGE),
  route({ params: idParamSchema, body: statusChangeSchema }, ({ params, body, user }) =>
    projectService.changeStatus(user, params.id, body.status, body.note),
  ),
);

/** FR-PRJ-08 */
projectsRouter.post(
  '/:id/pl-analysis',
  authorize(P.PROJECTS_MANAGE),
  route({ params: idParamSchema, body: plAnalysisSchema }, ({ params, body, user }) =>
    projectService.produceProfitLoss(user, params.id, body.note),
  ),
);
