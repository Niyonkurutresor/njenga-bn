import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { CUSTOMER_TYPES, INTERACTION_TYPES, LEAD_STAGES } from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

const money = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const positiveMoney = z.coerce
  .number()
  .positive('Amount must be greater than zero')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalEmail = z
  .union([z.literal(''), z.email('Enter a valid email')])
  .nullable()
  .optional();
const optionalId = z.coerce.number().int().positive().nullable().optional();
const optionalDate = z.iso.date().nullable().optional();

/** "" → null for optional fields posted from forms. */
function emptyToNull<T extends Record<string, unknown>>(v: T): T {
  const out: Record<string, unknown> = { ...v };
  for (const [k, val] of Object.entries(out)) if (val === '') out[k] = null;
  return out as T;
}

// ---------------- Leads (FR-BDV-01..04) ----------------

const leadFields = z.object({
  title: z.string().trim().min(2, 'Give the opportunity a title').max(191),
  companyName: z.string().trim().min(2, 'Company name is required').max(191),
  contactName: optionalText(150),
  contactPhone: optionalText(30),
  contactEmail: optionalEmail,
  source: optionalText(100),
  estimatedValue: money.optional(),
  expectedCloseDate: optionalDate,
  followUpDate: optionalDate,
  ownerId: optionalId,
  customerId: optionalId,
});

export const createLeadSchema = leadFields.transform(emptyToNull);
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = leadFields.partial().transform(emptyToNull);
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

/** FR-BDV-02: Lost requires a reason. */
export const changeStageSchema = z
  .object({
    stage: z.enum(LEAD_STAGES),
    lostReason: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.stage !== 'lost' || (v.lostReason?.length ?? 0) >= 3, {
    message: 'A reason is required when a lead is lost',
    path: ['lostReason'],
  });
export type ChangeStageInput = z.infer<typeof changeStageSchema>;

/** FR-BDV-04: optional overrides; everything else comes from the lead. */
export const convertLeadSchema = z.object({
  /** Link an existing customer instead of creating one. */
  customerId: optionalId,
  projectName: z.string().trim().min(2).max(191).optional(),
  location: optionalText(191),
  startDate: optionalDate,
  endDate: optionalDate,
  projectLeadId: optionalId,
});
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

export const leadListQuerySchema = listQuerySchema.extend({
  stage: z
    .union([z.enum(LEAD_STAGES), z.array(z.enum(LEAD_STAGES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  /** Open leads only (not won or lost). */
  open: queryBoolean,
  /** Open leads with a follow-up due on or before today. */
  followUpDue: queryBoolean,
  mine: queryBoolean,
  sortBy: z
    .enum(['createdAt', 'estimatedValue', 'expectedCloseDate', 'followUpDate', 'updatedAt'])
    .optional(),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const pipelineQuerySchema = dateRangeSchema.extend({
  ownerId: z.coerce.number().int().positive().optional(),
});
export type PipelineQuery = z.infer<typeof pipelineQuerySchema>;

// ---------------- Customers (FR-BDV-05) ----------------

const customerFields = z.object({
  name: z.string().trim().min(2, 'Customer name is required').max(191),
  type: z.enum(CUSTOMER_TYPES).optional(),
  email: optionalEmail,
  phone: optionalText(30),
  address: optionalText(255),
  notes: richText({ label: 'Notes' }),
});

export const createCustomerSchema = customerFields.transform(emptyToNull);
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const updateCustomerSchema = customerFields.partial().transform(emptyToNull);
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const contactSchema = z
  .object({
    name: z.string().trim().min(2, 'Contact name is required').max(150),
    position: optionalText(100),
    phone: optionalText(30),
    email: optionalEmail,
  })
  .transform(emptyToNull);
export type ContactInput = z.infer<typeof contactSchema>;

export const contactParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  contactId: z.coerce.number().int().positive(),
});

export const customerListQuerySchema = listQuerySchema.extend({
  type: z.enum(CUSTOMER_TYPES).optional(),
  sortBy: z.enum(['name', 'createdAt']).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

// ---------------- Interactions ----------------

export const interactionSchema = z
  .object({
    customerId: optionalId,
    leadId: optionalId,
    type: z.enum(INTERACTION_TYPES),
    summary: richText({ required: true, label: 'Summary' }),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    /** Sets the lead's next follow-up date (FR-BDV-03). */
    nextFollowUpDate: optionalDate,
  })
  .refine((v) => Boolean(v.customerId) || Boolean(v.leadId), {
    message: 'Choose a customer or a lead',
    path: ['customerId'],
  });
export type InteractionInput = z.infer<typeof interactionSchema>;

// ---------------- Sales (FR-BDV-06) ----------------

export const saleSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  projectId: optionalId,
  amount: positiveMoney,
  saleDate: z.iso.date(),
  description: optionalText(2000),
});
export type SaleInput = z.infer<typeof saleSchema>;

export const saleListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  customerId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['saleDate', 'amount', 'createdAt']).optional(),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

// ---------------- Satisfaction (FR-BDV-08) ----------------

export const ratingSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  rating: z.coerce.number().int().min(1, 'Rate from 1 to 5').max(5, 'Rate from 1 to 5'),
  comment: optionalText(2000),
});
export type RatingInput = z.infer<typeof ratingSchema>;
