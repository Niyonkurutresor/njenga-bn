import type { TaskStatus } from '../../db/enums.js';

/** Pure task rules (SRS 3.6), unit-tested. */

/** FR-TSK-03: a task is overdue when its deadline has passed and it is not done. */
export function isTaskOverdue(
  deadline: string | null | undefined,
  status: TaskStatus,
  todayIso: string,
): boolean {
  return Boolean(deadline) && status !== 'done' && (deadline as string) < todayIso;
}

/**
 * FR-TSK-04: "completed on time" = done on or before the deadline (tasks without a deadline
 * count as on time). `completedOn` is the company-timezone date the task was completed.
 */
export function completedOnTime(deadline: string | null | undefined, completedOn: string): boolean {
  return !deadline || completedOn <= deadline;
}

/** Order used by "My tasks": earliest deadline first, tasks without a deadline last. */
export function compareByDeadline(
  a: { deadline: string | null; id: number },
  b: { deadline: string | null; id: number },
): number {
  if (a.deadline === b.deadline) return a.id - b.id;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline < b.deadline ? -1 : 1;
}
