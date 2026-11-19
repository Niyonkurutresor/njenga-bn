import type { RequestStatus } from '../../db/enums.js';
import { PERMISSIONS as P, type Permission } from '../../rbac/permissions.js';

/**
 * Request status machine (SRS 3.2.1). Pure data + functions so the rules are unit-tested
 * and the UI can be told exactly which actions a user may take.
 */
export type RequestAction =
  'resubmit' | 'forward' | 'return' | 'approve' | 'reject' | 'pay' | 'comment';

interface Transition {
  from: readonly RequestStatus[];
  to: RequestStatus | null;
  /** Permission required, or 'requester' when only the person who raised it may act. */
  actor: Permission | 'requester';
}

export const TRANSITIONS: Record<Exclude<RequestAction, 'comment'>, Transition> = {
  resubmit: { from: ['returned'], to: 'submitted', actor: 'requester' },
  forward: { from: ['submitted'], to: 'pending_approval', actor: P.REQUESTS_REVIEW },
  return: { from: ['submitted'], to: 'returned', actor: P.REQUESTS_REVIEW },
  approve: { from: ['pending_approval'], to: 'approved', actor: P.REQUESTS_APPROVE },
  reject: { from: ['pending_approval'], to: 'rejected', actor: P.REQUESTS_APPROVE },
  // BRL-01 / FR-REQ-11: payment only after approval
  pay: { from: ['approved'], to: 'paid', actor: P.REQUESTS_DISBURSE },
};

/** Statuses in which discussion is still useful. */
const COMMENTABLE: readonly RequestStatus[] = [
  'submitted',
  'returned',
  'pending_approval',
  'approved',
];

export interface WorkflowActor {
  id: number;
  permissions: readonly string[];
}

export function canPerform(
  action: RequestAction,
  actor: WorkflowActor,
  request: { status: RequestStatus; requesterId: number },
): boolean {
  const isRequester = actor.id === request.requesterId;
  if (action === 'comment') {
    if (!COMMENTABLE.includes(request.status)) return false;
    return (
      isRequester ||
      [P.REQUESTS_REVIEW, P.REQUESTS_APPROVE, P.REQUESTS_DISBURSE].some((p) =>
        actor.permissions.includes(p),
      )
    );
  }
  const t = TRANSITIONS[action];
  if (!t.from.includes(request.status)) return false;
  return t.actor === 'requester' ? isRequester : actor.permissions.includes(t.actor);
}

export function availableActions(
  actor: WorkflowActor,
  request: { status: RequestStatus; requesterId: number },
): RequestAction[] {
  return (['resubmit', 'forward', 'return', 'approve', 'reject', 'pay', 'comment'] as const).filter(
    (a) => canPerform(a, actor, request),
  );
}

export function nextStatus(action: Exclude<RequestAction, 'comment'>): RequestStatus {
  return TRANSITIONS[action].to as RequestStatus;
}
