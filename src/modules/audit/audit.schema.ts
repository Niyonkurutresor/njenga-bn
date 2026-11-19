import { z } from 'zod';
import { dateRangeSchema, listQuerySchema } from '../../common/http/pagination.js';
import { RESTORABLE_ENTITY_TYPES } from './restorable.js';

export const auditListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  userId: z.coerce.number().int().positive().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(64).optional(),
  action: z.string().max(40).optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const deletedQuerySchema = z.object({ entityType: z.enum(RESTORABLE_ENTITY_TYPES) });

export const restoreSchema = z.object({
  entityType: z.enum(RESTORABLE_ENTITY_TYPES),
  entityId: z.coerce.number().int().positive(),
});
