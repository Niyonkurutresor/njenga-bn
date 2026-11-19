import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import {
  CROP_HEALTH,
  HARVEST_GRADES,
  HARVEST_UNITS,
  INSPECTION_STATUSES,
  OBSERVATION_SEVERITIES,
  PLOT_KINDS,
  PLOT_STATUSES,
} from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

const id = z.coerce.number().int().positive();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.iso.date();

// ---------- Greenhouses / field blocks (FR-FRM-01) ----------

const greenhouseFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  kind: z.enum(PLOT_KINDS).default('greenhouse'),
  sizeSqm: z.coerce.number().positive().max(100_000_000).nullable().optional(),
  currentCrop: optionalText(100),
  plantingDate: isoDate.nullable().optional(),
  status: z.enum(PLOT_STATUSES).default('active'),
  notes: optionalText(5000),
});

export const createGreenhouseSchema = greenhouseFields;
export type CreateGreenhouseInput = z.infer<typeof createGreenhouseSchema>;

export const updateGreenhouseSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(PLOT_KINDS).optional(),
  sizeSqm: z.coerce.number().positive().max(100_000_000).nullable().optional(),
  currentCrop: optionalText(100),
  plantingDate: isoDate.nullable().optional(),
  status: z.enum(PLOT_STATUSES).optional(),
  notes: optionalText(5000),
});
export type UpdateGreenhouseInput = z.infer<typeof updateGreenhouseSchema>;

export const greenhouseListQuerySchema = listQuerySchema.extend({
  status: z.enum(PLOT_STATUSES).optional(),
  kind: z.enum(PLOT_KINDS).optional(),
  sortBy: z.enum(['name', 'createdAt', 'plantingDate']).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type GreenhouseListQuery = z.infer<typeof greenhouseListQuerySchema>;

// ---------- Daily farm report (FR-FRM-02, US-FM-001/002) ----------

export const reportEntrySchema = z.object({
  greenhouseId: id,
  greenhouseStatus: optionalText(191),
  cropHealth: z.enum(CROP_HEALTH).default('good'),
  irrigationDone: z.boolean().default(false),
  pestsObserved: optionalText(2000),
  severity: z.enum(OBSERVATION_SEVERITIES).default('none'),
});
export type ReportEntryInput = z.infer<typeof reportEntrySchema>;

export const submitFarmReportSchema = z
  .object({
    reportDate: isoDate.optional(),
    irrigationNotes: optionalText(5000),
    visitors: optionalText(5000),
    equipmentCondition: optionalText(5000),
    /** The main report body, written in the in-app editor (sanitised HTML). */
    generalNotes: richText({ label: 'Report' }),
    /** Generated on the device; a retry with the same value returns the stored report. */
    clientRef: z.string().trim().min(8).max(64).optional(),
    entries: z.array(reportEntrySchema).min(1, 'Add at least one greenhouse').max(500),
  })
  .refine((v) => new Set(v.entries.map((e) => e.greenhouseId)).size === v.entries.length, {
    message: 'Each greenhouse can appear only once',
    path: ['entries'],
  });
export type SubmitFarmReportInput = z.infer<typeof submitFarmReportSchema>;

export const dailyReportQuerySchema = z.object({ date: isoDate.optional() });

export const reportListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  sortBy: z.enum(['reportDate']).optional(),
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

// ---------- Harvests (FR-FRM-03, FR-FRM-09) ----------

export const createHarvestSchema = z.object({
  greenhouseId: id,
  /** Defaults to the greenhouse's current crop. */
  crop: z.string().trim().min(1).max(100).optional(),
  quantity: z.coerce
    .number()
    .positive('Quantity must be greater than zero')
    .max(100_000_000)
    .transform((v) => Math.round(v * 1000) / 1000),
  unit: z.enum(HARVEST_UNITS).default('kg'),
  grade: z.enum(HARVEST_GRADES).default('A'),
  harvestDate: isoDate,
  notes: optionalText(2000),
});
export type CreateHarvestInput = z.infer<typeof createHarvestSchema>;

export const updateHarvestSchema = z.object({
  greenhouseId: id.optional(),
  crop: z.string().trim().min(1).max(100).optional(),
  quantity: z.coerce
    .number()
    .positive()
    .max(100_000_000)
    .transform((v) => Math.round(v * 1000) / 1000)
    .optional(),
  unit: z.enum(HARVEST_UNITS).optional(),
  grade: z.enum(HARVEST_GRADES).optional(),
  harvestDate: isoDate.optional(),
  notes: optionalText(2000),
});
export type UpdateHarvestInput = z.infer<typeof updateHarvestSchema>;

export const harvestListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  greenhouseId: id.optional(),
  crop: z.string().trim().max(100).optional(),
  unit: z.enum(HARVEST_UNITS).optional(),
  grade: z.enum(HARVEST_GRADES).optional(),
  sortBy: z.enum(['harvestDate', 'quantity', 'createdAt']).optional(),
});
export type HarvestListQuery = z.infer<typeof harvestListQuerySchema>;

export const harvestSummaryQuerySchema = dateRangeSchema.extend({
  greenhouseId: id.optional(),
});
export type HarvestSummaryQuery = z.infer<typeof harvestSummaryQuerySchema>;

// ---------- Inspections (FR-FRM-06..08, US-AG-001) ----------

export const createInspectionSchema = z
  .object({
    greenhouseId: id,
    inspectionDate: isoDate,
    /** Required unless a report file is attached (`withReportFile`). */
    findings: richText({ label: 'Findings' }),
    diseaseIdentified: optionalText(191),
    severity: z.enum(OBSERVATION_SEVERITIES).default('none'),
    recommendedTreatment: richText({ label: 'Recommended treatment' }),
    recommendedFertiliser: richText({ label: 'Recommended fertiliser' }),
    followUpDate: isoDate.nullable().optional(),
    status: z.enum(INSPECTION_STATUSES).default('open'),
    /** The client attaches the inspection report as a file right after saving. */
    withReportFile: z.boolean().default(false),
  })
  .refine((v) => v.withReportFile || Boolean(v.findings), {
    message: 'Describe the findings or attach the report file',
    path: ['findings'],
  });
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>;

export const updateInspectionSchema = z.object({
  greenhouseId: id.optional(),
  inspectionDate: isoDate.optional(),
  findings: richText({ label: 'Findings' }),
  diseaseIdentified: optionalText(191),
  severity: z.enum(OBSERVATION_SEVERITIES).optional(),
  recommendedTreatment: richText({ label: 'Recommended treatment' }),
  recommendedFertiliser: richText({ label: 'Recommended fertiliser' }),
  followUpDate: isoDate.nullable().optional(),
  status: z.enum(INSPECTION_STATUSES).optional(),
  withReportFile: z.boolean().optional(),
});
export type UpdateInspectionInput = z.infer<typeof updateInspectionSchema>;

export const inspectionListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  status: z.enum(INSPECTION_STATUSES).optional(),
  severity: z.enum(OBSERVATION_SEVERITIES).optional(),
  greenhouseId: id.optional(),
  agronomistId: id.optional(),
  /** Only the current user's inspections. */
  mine: queryBoolean,
  /** Follow-up date on or before today and not closed. */
  due: queryBoolean,
  sortBy: z.enum(['inspectionDate', 'followUpDate', 'createdAt']).optional(),
});
export type InspectionListQuery = z.infer<typeof inspectionListQuerySchema>;

// ---------- Reports & overview ----------

export const cropReportQuerySchema = dateRangeSchema;
export type CropReportQuery = z.infer<typeof cropReportQuerySchema>;

export const overviewQuerySchema = z.object({ date: isoDate.optional() });
