import { z } from 'zod';
import { dateRangeSchema } from '../../common/http/pagination.js';

export const entityRefSchema = z.object({
  entityType: z.string().min(1).max(60),
  entityId: z.coerce.number().int().positive(),
});

export const documentSearchSchema = dateRangeSchema.extend({
  search: z.string().trim().max(100).optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  /** Prefix match, e.g. "image" or "application/pdf". */
  mimeType: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DocumentSearchQuery = z.infer<typeof documentSearchSchema>;
