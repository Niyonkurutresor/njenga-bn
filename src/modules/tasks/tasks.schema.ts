import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import { PRIORITIES, TASK_STATUSES } from '../../db/enums.js';

const taskFields = z.object({
  title: z.string().trim().min(3, 'Give the task a title').max(191),
  description: z.string().trim().max(5000).nullable().optional(),
  projectId: z.coerce.number().int().positive().nullable().optional(),
  assigneeId: z.coerce.number().int().positive({ message: 'Choose who does the task' }),
  priority: z.enum(PRIORITIES).default('medium'),
  deadline: z.iso.date().nullable().optional(),
});

/** FR-TSK-01 */
export const createTaskSchema = taskFields;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = taskFields
  .extend({ priority: z.enum(PRIORITIES), status: z.enum(TASK_STATUSES) })
  .partial();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** FR-TSK-02 */
export const taskStatusSchema = z.object({ status: z.enum(TASK_STATUSES) });

const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values), z.array(z.enum(values))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional();

export const taskListQuerySchema = listQuerySchema.extend({
  status: enumList(TASK_STATUSES),
  priority: enumList(PRIORITIES),
  assigneeId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  overdue: queryBoolean,
  /** Only tasks assigned to the current user. */
  mine: queryBoolean,
  sortBy: z.enum(['deadline', 'createdAt', 'priority', 'title']).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const myTasksQuerySchema = z.object({
  /** Include done tasks completed in the last 7 days. */
  includeDone: queryBoolean,
});

export const performanceQuerySchema = dateRangeSchema;
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;
