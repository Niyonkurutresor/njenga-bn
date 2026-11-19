import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { ISSUE_STATUSES, PROGRESS_REPORT_STATUSES, SEVERITIES } from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

const id = z.coerce.number().int().positive();

/**
 * Number of files (photos, Word/PDF/Excel report files) the client will attach right after
 * creating the record. The offline outbox creates the record first and uploads files second,
 * so the "narrative OR at least one attachment" rule is checked against this declared count.
 */
const attachmentCount = z.coerce.number().int().min(0).max(20).default(0);

/** A report needs its main narrative or at least one attached file. */
const narrativeOrFile =
  <K extends string>(key: K, message: string) =>
  <T extends Record<K, string | null | undefined> & { attachmentCount: number }>(
    schema: z.ZodType<T>,
  ) =>
    schema.refine((v) => Boolean(v[key]) || v.attachmentCount > 0, { message, path: [key] });

// ---------- Progress reports (FR-OPS-01..05, FR-OPS-08) ----------

export const createProgressReportSchema = narrativeOrFile(
  'workCompleted',
  'Describe the work completed or attach a report file',
)(
  z.object({
    projectId: id,
    reportDate: z.iso.date().optional(),
    workCompleted: richText({ label: 'Work completed' }),
    pendingWork: richText({ label: 'Pending work' }),
    percentComplete: z.coerce.number().int().min(0).max(100),
    issuesSummary: richText({ label: 'Issues' }),
    latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
    longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
    /** Client-generated id; a retried offline submission returns the existing report. */
    clientRef: z.string().trim().min(8).max(64).optional(),
    attachmentCount,
  }),
);
export type CreateProgressReportInput = z.infer<typeof createProgressReportSchema>;

export const progressReportListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  status: z
    .union([z.enum(PROGRESS_REPORT_STATUSES), z.array(z.enum(PROGRESS_REPORT_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  projectId: id.optional(),
  technicianId: id.optional(),
  mine: queryBoolean,
  sortBy: z.enum(['reportDate', 'createdAt', 'percentComplete']).optional(),
});
export type ProgressReportListQuery = z.infer<typeof progressReportListQuerySchema>;

export const verifyReportSchema = z.object({ comment: z.string().trim().max(2000).optional() });
export const queryReportSchema = z.object({
  comment: z.string().trim().min(3, 'Say what needs clarifying').max(2000),
});
/** US-OP-003 AC2: technician answers a query, optionally correcting the figures. */
export const respondReportSchema = z.object({
  response: z.string().trim().min(2, 'Write a response').max(5000),
  workCompleted: richText({ label: 'Work completed' }),
  pendingWork: richText({ label: 'Pending work' }),
  percentComplete: z.coerce.number().int().min(0).max(100).optional(),
});
export type RespondReportInput = z.infer<typeof respondReportSchema>;

// ---------- Issues (FR-OPS-04) ----------

export const createIssueSchema = z.object({
  projectId: id,
  progressReportId: id.nullable().optional(),
  title: z.string().trim().min(3, 'Give the issue a short title').max(191),
  description: richText({ label: 'Description' }),
  severity: z.enum(SEVERITIES),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const resolveIssueSchema = z.object({
  resolution: richText({ required: true, label: 'Resolution' }),
});

export const issueListQuerySchema = listQuerySchema.extend({
  status: z.enum(ISSUE_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  projectId: id.optional(),
  mine: queryBoolean,
});
export type IssueListQuery = z.infer<typeof issueListQuerySchema>;

// ---------- Site visits (FR-OPS-06) ----------

const siteVisitFields = z.object({
  projectId: id,
  visitDate: z.iso.date(),
  findings: richText({ label: 'Findings' }),
  attachmentCount,
});
export const siteVisitSchema = narrativeOrFile(
  'findings',
  'Record the findings or attach the inspection report',
)(siteVisitFields);
export type SiteVisitInput = z.infer<typeof siteVisitSchema>;
/** Edits keep findings optional: the visit may already have its report attached. */
export const updateSiteVisitSchema = siteVisitFields.omit({ attachmentCount: true }).partial();
export type UpdateSiteVisitInput = z.infer<typeof updateSiteVisitSchema>;

export const siteVisitListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  projectId: id.optional(),
  visitedBy: id.optional(),
});
export type SiteVisitListQuery = z.infer<typeof siteVisitListQuerySchema>;

// ---------- Daily operations report (FR-OPS-07, US-OP-004) ----------

export const dailyOpsPrefillQuerySchema = z.object({ date: z.iso.date().optional() });

export const createDailyOpsSchema = z.object({
  reportDate: z.iso.date().optional(),
  comments: richText({ label: 'Comments' }),
});
export type CreateDailyOpsInput = z.infer<typeof createDailyOpsSchema>;

export const updateDailyOpsSchema = z.object({
  comments: richText({ label: 'Comments' }),
});

export const dailyOpsListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  submittedBy: id.optional(),
});
export type DailyOpsListQuery = z.infer<typeof dailyOpsListQuerySchema>;
