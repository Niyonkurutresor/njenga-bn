import { PERMISSIONS as P, type Permission } from '../../rbac/permissions.js';
import { ROLE_CODES } from '../../rbac/default-roles.js';

/** FR-MTG-01: only the organizer or a Director may change a meeting (with meetings:manage). */
export function canEditMeeting(
  user: { id: number; roleCode: string; permissions: readonly Permission[] },
  meeting: { organizerId: number },
): boolean {
  return (
    user.permissions.includes(P.MEETINGS_MANAGE) &&
    (meeting.organizerId === user.id || user.roleCode === ROLE_CODES.DIRECTOR)
  );
}
