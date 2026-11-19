import { Router } from 'express';
import { z } from 'zod';
import { authorize, can } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import {
  changeStageSchema,
  contactParamSchema,
  contactSchema,
  convertLeadSchema,
  createCustomerSchema,
  createLeadSchema,
  customerListQuerySchema,
  interactionSchema,
  leadListQuerySchema,
  pipelineQuerySchema,
  ratingSchema,
  saleListQuerySchema,
  saleSchema,
  updateCustomerSchema,
  updateLeadSchema,
} from './crm.schema.js';
import { customerService } from './customers.service.js';
import { leadService } from './leads.service.js';

// Contracts, proposals and correspondence on the customer record (FR-BDV-05, FR-DOC-02).
registerDocumentEntity('customer', {
  label: 'Customer',
  canRead: async (user, id) => can(user, P.CRM_VIEW) && customerService.exists(id),
  canWrite: async (user, id) =>
    (can(user, P.CRM_MANAGE) || can(user, P.SALES_RECORD)) && customerService.exists(id),
});
// Proposals, quotations and meeting notes on a lead (PDF, Word, Excel or images).
registerDocumentEntity('lead', {
  label: 'Lead',
  canRead: async (user, id) => can(user, P.CRM_VIEW) && leadService.exists(id),
  canWrite: async (user, id) =>
    (can(user, P.CRM_MANAGE) || can(user, P.SALES_RECORD)) && leadService.exists(id),
});

export const crmRouter = Router();

const VIEW = authorize(P.CRM_VIEW);
const MANAGE = authorize(P.CRM_MANAGE);
/** Interactions and ratings: sales staff or CRM managers. */
const RECORD = authorize([P.SALES_RECORD, P.CRM_MANAGE], 'any');

// ---------------- Pipeline (FR-BDV-07) ----------------

crmRouter.get(
  '/pipeline',
  VIEW,
  route({ query: pipelineQuerySchema }, ({ query }) => leadService.pipeline(query)),
);

// ---------------- Leads (FR-BDV-01..04) ----------------

crmRouter.get(
  '/leads',
  VIEW,
  route({ query: leadListQuerySchema }, ({ query, user }) => leadService.list(user, query)),
);

crmRouter.get(
  '/leads/board',
  VIEW,
  route(
    { query: z.object({ ownerId: z.coerce.number().int().positive().optional() }) },
    ({ query }) => leadService.board(query),
  ),
);

crmRouter.get(
  '/leads/:id',
  VIEW,
  route({ params: idParamSchema }, ({ params }) => leadService.get(params.id)),
);

crmRouter.post(
  '/leads',
  MANAGE,
  route({ body: createLeadSchema, status: 201 }, ({ body, user }) =>
    leadService.create(user, body),
  ),
);

crmRouter.patch(
  '/leads/:id',
  MANAGE,
  route({ params: idParamSchema, body: updateLeadSchema }, ({ params, body, user }) =>
    leadService.update(user, params.id, body),
  ),
);

/** Stage change; Lost requires a reason, reopening a lost lead is allowed (FR-BDV-02). */
crmRouter.post(
  '/leads/:id/stage',
  MANAGE,
  route({ params: idParamSchema, body: changeStageSchema }, ({ params, body, user }) =>
    leadService.changeStage(user, params.id, body),
  ),
);

/** Won lead → customer + project in one transaction (FR-BDV-04, US-BD-004 AC3). */
crmRouter.post(
  '/leads/:id/convert',
  MANAGE,
  route({ params: idParamSchema, body: convertLeadSchema, status: 201 }, ({ params, body, user }) =>
    leadService.convert(user, params.id, body),
  ),
);

crmRouter.delete(
  '/leads/:id',
  MANAGE,
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await leadService.remove(params.id);
  }),
);

// ---------------- Interactions ----------------

crmRouter.post(
  '/interactions',
  RECORD,
  route({ body: interactionSchema, status: 201 }, ({ body, user }) =>
    customerService.logInteraction(user, body),
  ),
);

// ---------------- Customers (FR-BDV-05) ----------------

crmRouter.get(
  '/customers',
  VIEW,
  route({ query: customerListQuerySchema }, ({ query }) => customerService.list(query)),
);

crmRouter.get(
  '/customers/options',
  authorize([P.CRM_VIEW, P.SALES_RECORD], 'any'),
  route({}, () => customerService.options()),
);

crmRouter.get(
  '/customers/:id',
  VIEW,
  route({ params: idParamSchema }, ({ params }) => customerService.get(params.id)),
);

crmRouter.post(
  '/customers',
  MANAGE,
  route({ body: createCustomerSchema, status: 201 }, ({ body, user }) =>
    customerService.create(user, body),
  ),
);

crmRouter.patch(
  '/customers/:id',
  MANAGE,
  route({ params: idParamSchema, body: updateCustomerSchema }, ({ params, body }) =>
    customerService.update(params.id, body),
  ),
);

crmRouter.delete(
  '/customers/:id',
  MANAGE,
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await customerService.remove(params.id);
  }),
);

crmRouter.post(
  '/customers/:id/contacts',
  MANAGE,
  route({ params: idParamSchema, body: contactSchema, status: 201 }, ({ params, body }) =>
    customerService.addContact(params.id, body),
  ),
);

crmRouter.patch(
  '/customers/:id/contacts/:contactId',
  MANAGE,
  route({ params: contactParamSchema, body: contactSchema }, ({ params, body }) =>
    customerService.updateContact(params.id, params.contactId, body),
  ),
);

crmRouter.delete(
  '/customers/:id/contacts/:contactId',
  MANAGE,
  route({ params: contactParamSchema }, ({ params }) =>
    customerService.removeContact(params.id, params.contactId),
  ),
);

// ---------------- Sales (FR-BDV-06) ----------------

crmRouter.get(
  '/sales',
  VIEW,
  route({ query: saleListQuerySchema }, ({ query }) => customerService.listSales(query)),
);

crmRouter.post(
  '/sales',
  authorize(P.SALES_RECORD),
  route({ body: saleSchema, status: 201 }, ({ body, user }) =>
    customerService.recordSale(user, body),
  ),
);

crmRouter.delete(
  '/sales/:id',
  authorize(P.SALES_RECORD),
  route({ params: idParamSchema, status: 204 }, async ({ params }) => {
    await customerService.removeSale(params.id);
  }),
);

// ---------------- Satisfaction (FR-BDV-08) ----------------

crmRouter.get(
  '/ratings/summary',
  VIEW,
  route({}, () => customerService.ratingSummary()),
);

crmRouter.post(
  '/ratings',
  RECORD,
  route({ body: ratingSchema, status: 201 }, ({ body, user }) =>
    customerService.rateProject(user, body),
  ),
);
