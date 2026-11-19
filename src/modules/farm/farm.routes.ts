import { Router } from 'express';
import { z } from 'zod';
import { authorize, can } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema, queryBoolean } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  createGreenhouseSchema,
  createHarvestSchema,
  createInspectionSchema,
  cropReportQuerySchema,
  dailyReportQuerySchema,
  greenhouseListQuerySchema,
  harvestListQuerySchema,
  harvestSummaryQuerySchema,
  inspectionListQuerySchema,
  overviewQuerySchema,
  reportListQuerySchema,
  submitFarmReportSchema,
  updateGreenhouseSchema,
  updateHarvestSchema,
  updateInspectionSchema,
} from './farm.schema.js';
import { farmService } from './farm.service.js';
import { farmReportService } from './farm-reports.service.js';
import { greenhouseService } from './greenhouses.service.js';
import { harvestService } from './harvests.service.js';
import { inspectionService } from './inspections.service.js';

// Daily report photos and report files (FR-FRM-02, PDF/Word/Excel/images): anyone with farm
// access sees them, Farm Managers add them.
registerDocumentEntity('farm_report', {
  label: 'Daily farm report',
  canRead: async (user) => can(user, P.FARM_VIEW),
  canWrite: async (user) => can(user, P.FARM_MANAGE),
  maxFiles: 10,
});

// Inspection photos and report files (FR-FRM-06): the inspecting agronomist adds them.
registerDocumentEntity('inspection', {
  label: 'Crop inspection',
  canRead: async (user) => can(user, P.FARM_VIEW),
  canWrite: (user, id) => inspectionService.canAttach(user, id),
  maxFiles: 10,
});

export const farmRouter = Router();

const view = authorize(P.FARM_VIEW);
const manage = authorize(P.FARM_MANAGE);
const inspect = authorize(P.INSPECTIONS_CREATE);

// ---------- Overview & reports ----------
farmRouter.get(
  '/overview',
  view,
  route({ query: overviewQuerySchema }, ({ query }) => farmService.overview(query.date)),
);

farmRouter.get(
  '/crop-report',
  view,
  route({ query: cropReportQuerySchema }, ({ query }) => farmService.cropReport(query)),
);

// ---------- Greenhouses (FR-FRM-01, FR-FRM-08) ----------
farmRouter.get(
  '/greenhouses/options',
  view,
  route({}, () => greenhouseService.options()),
);

farmRouter.get(
  '/greenhouses',
  view,
  route({ query: greenhouseListQuerySchema }, ({ query }) => greenhouseService.list(query)),
);

farmRouter.get(
  '/greenhouses/:id',
  view,
  route({ params: idParamSchema }, ({ params }) => greenhouseService.get(params.id)),
);

farmRouter.post(
  '/greenhouses',
  manage,
  route({ body: createGreenhouseSchema, status: 201 }, ({ body, user }) =>
    greenhouseService.create(user, body),
  ),
);

farmRouter.patch(
  '/greenhouses/:id',
  manage,
  route({ params: idParamSchema, body: updateGreenhouseSchema }, ({ params, body, user }) =>
    greenhouseService.update(user, params.id, body),
  ),
);

farmRouter.delete(
  '/greenhouses/:id',
  manage,
  route({ params: idParamSchema, status: 204 }, ({ params, user }) =>
    greenhouseService.remove(user, params.id),
  ),
);

// ---------- Daily farm report (FR-FRM-02, US-FM-001/002) ----------
farmRouter.get(
  '/reports/daily',
  view,
  route({ query: dailyReportQuerySchema }, ({ query }) => farmReportService.daily(query.date)),
);

farmRouter.get(
  '/reports',
  view,
  route({ query: reportListQuerySchema }, ({ query }) => farmReportService.list(query)),
);

farmRouter.get(
  '/reports/:id',
  view,
  route({ params: idParamSchema }, ({ params }) => farmReportService.getById(params.id)),
);

/** Create or update the report for its date; idempotent on `clientRef`. */
farmRouter.post(
  '/reports',
  manage,
  route({ body: submitFarmReportSchema, status: 201 }, ({ body, user }) =>
    farmReportService.submit(user, body),
  ),
);

// ---------- Harvests (FR-FRM-03, FR-FRM-09) ----------
farmRouter.get(
  '/harvests',
  view,
  route({ query: harvestListQuerySchema }, ({ query }) => harvestService.list(query)),
);

farmRouter.get(
  '/harvests/summary',
  view,
  route({ query: harvestSummaryQuerySchema }, ({ query }) => harvestService.summary(query)),
);

farmRouter.get(
  '/harvests/crops',
  view,
  route({}, () => harvestService.crops()),
);

farmRouter.get(
  '/harvests/:id',
  view,
  route({ params: idParamSchema }, ({ params }) => harvestService.get(params.id)),
);

farmRouter.post(
  '/harvests',
  manage,
  route({ body: createHarvestSchema, status: 201 }, ({ body, user }) =>
    harvestService.create(user, body),
  ),
);

farmRouter.patch(
  '/harvests/:id',
  manage,
  route({ params: idParamSchema, body: updateHarvestSchema }, ({ params, body, user }) =>
    harvestService.update(user, params.id, body),
  ),
);

farmRouter.delete(
  '/harvests/:id',
  manage,
  route({ params: idParamSchema, status: 204 }, ({ params, user }) =>
    harvestService.remove(user, params.id),
  ),
);

// ---------- Inspections (FR-FRM-06..08, US-AG-001) ----------
farmRouter.get(
  '/inspections',
  view,
  route({ query: inspectionListQuerySchema }, ({ query, user }) =>
    inspectionService.list(user, query),
  ),
);

farmRouter.get(
  '/inspections/summary',
  view,
  route({ query: z.object({ mine: queryBoolean }) }, ({ query, user }) =>
    inspectionService.statusCounts(user, query.mine),
  ),
);

farmRouter.get(
  '/inspections/:id',
  view,
  route({ params: idParamSchema }, ({ params, user }) => inspectionService.get(user, params.id)),
);

farmRouter.post(
  '/inspections',
  inspect,
  route({ body: createInspectionSchema, status: 201 }, ({ body, user }) =>
    inspectionService.create(user, body),
  ),
);

/** Own inspections only — enforced in the service. */
farmRouter.patch(
  '/inspections/:id',
  inspect,
  route({ params: idParamSchema, body: updateInspectionSchema }, ({ params, body, user }) =>
    inspectionService.update(user, params.id, body),
  ),
);

farmRouter.delete(
  '/inspections/:id',
  inspect,
  route({ params: idParamSchema, status: 204 }, ({ params, user }) =>
    inspectionService.remove(user, params.id),
  ),
);
