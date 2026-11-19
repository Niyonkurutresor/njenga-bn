import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import {
  COST_CENTRE_TYPES,
  PAYMENT_METHODS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
} from '../../db/enums.js';

const amount = z.coerce
  .number()
  .positive('Amount must be greater than zero')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const requestFields = z.object({
  type: z.enum(REQUEST_TYPES),
  amount,
  purpose: z.string().trim().min(5, 'Describe the purpose').max(2000),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  costCentreType: z.enum(COST_CENTRE_TYPES),
  projectId: z.coerce.number().int().positive().nullable().optional(),
  neededBy: z.iso.date().nullable().optional(),
});

const projectRequired = <
  T extends { costCentreType?: string; projectId?: number | null | undefined },
>(
  v: T,
) => v.costCentreType !== 'project' || Boolean(v.projectId);

/** FR-REQ-01 */
export const createRequestSchema = requestFields.refine(projectRequired, {
  message: 'Select the project this request is for',
  path: ['projectId'],
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

/** Correct-and-resubmit after the request was returned. */
export const resubmitRequestSchema = requestFields
  .partial()
  .extend({ comment: z.string().trim().max(2000).optional() })
  .refine((v) => v.costCentreType === undefined || projectRequired(v), {
    message: 'Select the project this request is for',
    path: ['projectId'],
  });
export type ResubmitRequestInput = z.infer<typeof resubmitRequestSchema>;

export const optionalCommentSchema = z.object({ comment: z.string().trim().max(2000).optional() });
export const requiredCommentSchema = z.object({
  comment: z.string().trim().min(3, 'A comment is required').max(2000),
});
/** BRL-02: a rejection must include a reason. */
export const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'A rejection reason is required').max(2000),
});

/** FR-REQ-07 */
export const disburseSchema = z.object({
  amount,
  paidOn: z.iso.date(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentReference: z.string().trim().min(1).max(100),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  /** Set after the user has seen the "possible duplicate" warning. */
  confirmDuplicate: z.boolean().default(false),
});
export type DisburseInput = z.infer<typeof disburseSchema>;

export const requestListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  status: z
    .union([z.enum(REQUEST_STATUSES), z.array(z.enum(REQUEST_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  type: z.enum(REQUEST_TYPES).optional(),
  requesterId: z.coerce.number().int().positive().optional(),
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  /** Only the current user's own requests. */
  mine: queryBoolean,
  sortBy: z.enum(['createdAt', 'amount', 'neededBy']).optional(),
});
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;
