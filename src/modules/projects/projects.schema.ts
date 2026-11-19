import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { PROJECT_STATUSES } from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalId = z.coerce.number().int().positive().nullable().optional();

const projectFields = z.object({
  name: z.string().trim().min(2, 'Project name is required').max(191),
  customerId: optionalId,
  clientName: optionalText(191),
  location: optionalText(191),
  contractValue: z.coerce
    .number()
    .min(0, 'Contract value cannot be negative')
    .max(1_000_000_000_000)
    .transform((v) => Math.round(v * 100) / 100),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
  projectLeadId: optionalId,
  description: richText({ label: 'Description' }),
});

const datesInOrder = (v: { startDate?: string | null; endDate?: string | null }) =>
  !v.startDate || !v.endDate || v.endDate >= v.startDate;
const datesMessage = { message: 'End date must be on or after the start date', path: ['endDate'] };

/** FR-PRJ-01 */
export const createProjectSchema = projectFields
  .extend({ memberIds: z.array(z.coerce.number().int().positive()).max(50).optional() })
  .refine(datesInOrder, datesMessage);
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = projectFields.partial().refine(datesInOrder, datesMessage);
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

const statusList = z
  .union([z.enum(PROJECT_STATUSES), z.array(z.enum(PROJECT_STATUSES))])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .optional();

/** FR-PRJ-05/06, US-BD-003 */
export const projectListQuerySchema = listQuerySchema.extend({
  status: statusList,
  delayed: queryBoolean,
  /** Exclude closed projects. */
  open: queryBoolean,
  leadId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  memberId: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['createdAt', 'endDate', 'name', 'code', 'contractValue']).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

export const projectOptionsQuerySchema = z.object({ open: queryBoolean });

export const addMembersSchema = z.object({
  userIds: z.array(z.coerce.number().int().positive()).min(1, 'Select at least one person').max(50),
});

export const memberParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

export const statusChangeSchema = z.object({
  status: z.enum(PROJECT_STATUSES),
  note: z.string().trim().max(2000).optional(),
});

export const plAnalysisSchema = z.object({ note: z.string().trim().max(2000).optional() });

export const profitabilityQuerySchema = dateRangeSchema.extend({ status: statusList });
export type ProfitabilityQuery = z.infer<typeof profitabilityQuerySchema>;

export const workloadQuerySchema = z.object({ search: z.string().trim().max(100).optional() });
