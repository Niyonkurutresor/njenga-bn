import type { ReportRequestStatus } from '../../db/enums.js';

/** Pure rules for report requests (FR-RPT-04, US-CEO-006), unit-tested. */

export type ReportRequestAction = 'deliver' | 'cancel' | 'attach';

/** Open past its due date. */
export function isReportRequestOverdue(
  row: { status: ReportRequestStatus; dueDate: string | null },
  on: string,
): boolean {
  return row.status === 'open' && Boolean(row.dueDate && row.dueDate < on);
}

/** Actions the viewer can take, so the UI shows only valid buttons. */
export function reportRequestActions(
  user: { id: number },
  row: { status: ReportRequestStatus; requestedBy: number; assigneeId: number },
): ReportRequestAction[] {
  if (row.status !== 'open') return [];
  const actions: ReportRequestAction[] = [];
  if (row.assigneeId === user.id) actions.push('deliver', 'attach');
  if (row.requestedBy === user.id) actions.push('cancel');
  return actions;
}
