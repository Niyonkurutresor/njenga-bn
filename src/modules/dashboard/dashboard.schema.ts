import type { z } from 'zod';
import { dateRangeSchema } from '../../common/http/pagination.js';

/** FR-DSH-03: date-range filter (defaults to the current month). */
export const dashboardQuerySchema = dateRangeSchema;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
