import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { PAYMENT_METHODS, STOCK_MOVEMENT_TYPES } from '../../db/enums.js';

const qty = (message = 'Quantity must be greater than zero') =>
  z.coerce
    .number()
    .positive(message)
    .max(100_000_000)
    .transform((v) => Math.round(v * 1000) / 1000);

const nonNegativeQty = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(100_000_000)
  .transform((v) => Math.round(v * 1000) / 1000);

const unitCost = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const movementDate = z.iso.date();

// ---------------- Materials (FR-INV-01) ----------------

const materialFields = z.object({
  name: z.string().trim().min(2, 'Material name is required').max(150),
  sku: optionalText(60),
  unit: z.string().trim().min(1, 'Unit is required').max(20),
  reorderLevel: nonNegativeQty.optional(),
});

export const createMaterialSchema = materialFields;
export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;
export const updateMaterialSchema = materialFields.partial();
export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;

export const materialListQuerySchema = listQuerySchema.extend({
  lowStock: queryBoolean,
  sortBy: z.enum(['name', 'quantityOnHand', 'updatedAt']).optional(),
});
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>;

// ---------------- Movements (FR-INV-02..03) ----------------

/** Stock received, incl. imports with supplier and shipment reference (FR-INV-02). */
export const receiveSchema = z.object({
  quantity: qty(),
  unitCost,
  supplier: optionalText(150),
  isImported: z.boolean().default(false),
  shipmentReference: optionalText(100),
  movementDate,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  notes: optionalText(2000),
});
export type ReceiveInput = z.infer<typeof receiveSchema>;

/** Issued to a project or the farm; cost posted there (FR-INV-02, FR-INV-03). */
export const issueSchema = z
  .object({
    quantity: qty(),
    costCentreType: z.enum(['project', 'farm']),
    projectId: z.coerce.number().int().positive().nullable().optional(),
    movementDate,
    notes: optionalText(2000),
  })
  .refine((v) => v.costCentreType !== 'project' || Boolean(v.projectId), {
    message: 'Select the project receiving the material',
    path: ['projectId'],
  });
export type IssueInput = z.infer<typeof issueSchema>;

/** Stock count corrections: + or −, always with a reason. */
export const adjustSchema = z.object({
  quantity: z.coerce
    .number()
    .refine((v) => v !== 0, 'Adjustment cannot be zero')
    .refine((v) => Math.abs(v) <= 100_000_000, 'Too large')
    .transform((v) => Math.round(v * 1000) / 1000),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment').max(2000),
  movementDate,
});
export type AdjustInput = z.infer<typeof adjustSchema>;

export const movementListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  materialId: z.coerce.number().int().positive().optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  costCentreType: z.enum(['project', 'farm', 'office']).optional(),
});
export type MovementListQuery = z.infer<typeof movementListQuerySchema>;
