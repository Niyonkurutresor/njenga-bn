import { Router } from 'express';
import { route } from '../../common/http/route.js';
import { dashboardQuerySchema } from './dashboard.schema.js';
import { dashboardService } from './dashboard.service.js';

export const dashboardRouter = Router();

/**
 * Every signed-in user has a dashboard; its sections come from their permissions
 * (FR-DSH-01) and the optional `from`/`to` range (FR-DSH-03).
 */
dashboardRouter.get(
  '/',
  route({ query: dashboardQuerySchema }, ({ query, user }) => dashboardService.get(user, query)),
);
