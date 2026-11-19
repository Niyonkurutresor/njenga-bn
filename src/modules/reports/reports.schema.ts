import { z } from 'zod';
import { dateRangeSchema, listQuerySchema } from '../../common/http/pagination.js';
import { REPORT_REQUEST_STATUSES } from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

export const reportKeyParamSchema = z.object({ key: z.string().trim().min(1).max(60) });

/** `?from&to&...filters` — report-specific filters are validated by the report itself. */
export const reportQuerySchema = z.looseObject(dateRangeSchema.shape);
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const exportQuerySchema = z.looseObject({
  ...dateRangeSchema.shape,
  format: z.enum(['pdf', 'xlsx']).default('pdf'),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const snapshotQuerySchema = dateRangeSchema;
export const snapshotDateParamSchema = z.object({ date: z.iso.date() });

export const departmentalQuerySchema = z.object({ date: z.iso.date().optional() });

// ---------- Report requests (FR-RPT-04, US-CEO-006) ----------

export const createReportRequestSchema = z.object({
  title: z.string().trim().min(3, 'Give the request a title').max(191),
  /** Rich text (sanitised HTML). */
  description: richText({ label: 'Description' }),
  assigneeId: z.coerce.number().int().positive(),
  dueDate: z.iso.date().nullable().optional(),
});
export type CreateReportRequestInput = z.infer<typeof createReportRequestSchema>;

export const deliverReportRequestSchema = z.object({
  /**
   * Report written in the in-app editor (sanitised HTML). Optional when files are attached:
   * delivery needs a body or at least one attachment (checked in the service).
   */
  response: richText({ label: 'Response' }),
});
export type DeliverReportRequestInput = z.infer<typeof deliverReportRequestSchema>;

export const reportRequestListSchema = listQuerySchema.extend({
  /** sent = I requested it; assigned = I must deliver it. */
  box: z.enum(['sent', 'assigned']).default('assigned'),
  status: z.enum(REPORT_REQUEST_STATUSES).optional(),
  sortBy: z.enum(['createdAt', 'dueDate']).optional(),
});
export type ReportRequestListQuery = z.infer<typeof reportRequestListSchema>;
