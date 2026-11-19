import { PROJECT_STATUSES, type ProjectStatus } from '../../db/enums.js';

/** Same ordering as `statusRank` in project-lifecycle.ts, kept I/O-free for unit tests. */
const statusRank = (s: ProjectStatus) => PROJECT_STATUSES.indexOf(s);

/**
 * Pure project rules (SRS 3.5). Free of I/O so they are unit-tested and shared by the
 * list, detail, dashboard-style summaries and the daily operations report.
 */

/** Statuses in which a project is no longer "running" (FR-PRJ-06). */
export const FINISHED_STATUSES: readonly ProjectStatus[] = ['completed', 'pl_analysed', 'closed'];

/**
 * % complete (FR-PRJ-05):
 *  1. the percent of the latest VERIFIED technician progress report, if there is one
 *     (Ops has confirmed the figure on site, FR-OPS-05);
 *  2. otherwise done tasks ÷ total tasks × 100 (rounded);
 *  3. null when there is neither a verified report nor any task.
 * A completed / analysed / closed project is always 100 %.
 */
export function projectPercentComplete(input: {
  status: ProjectStatus;
  latestVerifiedPercent: number | null | undefined;
  doneTasks: number;
  totalTasks: number;
}): number | null {
  if (FINISHED_STATUSES.includes(input.status)) return 100;
  if (input.latestVerifiedPercent !== null && input.latestVerifiedPercent !== undefined) {
    return Math.max(0, Math.min(100, Math.round(input.latestVerifiedPercent)));
  }
  if (input.totalTasks > 0) return Math.round((input.doneTasks / input.totalTasks) * 100);
  return null;
}

/** FR-PRJ-06: Delayed when the end date has passed and the project is not completed. */
export function isProjectDelayed(
  endDate: string | null | undefined,
  status: ProjectStatus,
  todayIso: string,
): boolean {
  if (!endDate) return false;
  return endDate < todayIso && !FINISHED_STATUSES.includes(status);
}

/** Statuses a user may set by hand through POST /projects/:id/status. */
export const MANUAL_STATUSES = ['in_execution', 'completed', 'closed'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/**
 * Lifecycle gates for manual transitions (FR-PRJ-02/03/08, BRL-07).
 * Returns null when allowed, otherwise the reason it is not.
 *
 *  - created → budgeted: only by creating a budget in Finance (FR-PRJ-03)
 *  - budgeted → tasks_assigned: automatic when the first task is assigned
 *  - funding_requested / funding_approved: set by the requests workflow
 *  - start execution: from Budgeted or later, before Completed
 *  - complete: from In Execution
 *  - P/L analysis: through POST /projects/:id/pl-analysis once Completed
 *  - close: only once the P/L analysis is done (BRL-07)
 */
export function transitionError(from: ProjectStatus, to: ProjectStatus): string | null {
  if (from === to) return `The project is already ${label(to)}`;
  if (from === 'closed') return 'A closed project cannot change status';
  switch (to) {
    case 'created':
      return 'A project cannot be moved back to Created';
    case 'budgeted':
      return 'A project becomes Budgeted when Finance records its budget';
    case 'tasks_assigned':
      return 'A project moves to Tasks assigned automatically when its first task is assigned';
    case 'funding_requested':
    case 'funding_approved':
      return 'Funding statuses are set by the request approval workflow';
    case 'pl_analysed':
      return from === 'completed'
        ? null
        : 'Profit/loss analysis can only be produced for a completed project';
    case 'in_execution':
      if (from === 'created')
        return 'A budget is required before the project can move beyond Created (FR-PRJ-03)';
      return statusRank(from) < statusRank('in_execution')
        ? null
        : 'Execution can only start before the project is completed';
    case 'completed':
      return from === 'in_execution' ? null : 'Only a project in execution can be completed';
    case 'closed':
      return from === 'pl_analysed'
        ? null
        : 'A project cannot be closed until its profit/loss analysis is complete (BRL-07)';
  }
}

export type LifecycleAction = 'start_execution' | 'complete' | 'pl_analysis' | 'close';

/** Lifecycle actions available from a status (the UI shows only these). */
export function availableLifecycleActions(status: ProjectStatus): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  if (!transitionError(status, 'in_execution')) actions.push('start_execution');
  if (!transitionError(status, 'completed')) actions.push('complete');
  // Re-running the analysis is allowed until the project is closed (e.g. a late cost).
  if (status === 'completed' || status === 'pl_analysed') actions.push('pl_analysis');
  if (!transitionError(status, 'closed')) actions.push('close');
  return actions;
}

function label(status: ProjectStatus): string {
  return status.replace(/_/g, ' ');
}
