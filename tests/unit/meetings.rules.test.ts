import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, ROLE_CODES } from '../../src/rbac/default-roles.js';
import { canEditMeeting } from '../../src/modules/meetings/meetings.rules.js';

const perms = (code: string) => DEFAULT_ROLES.find((r) => r.code === code)!.permissions;

const bdm = { id: 1, roleCode: ROLE_CODES.BDM, permissions: perms(ROLE_CODES.BDM) };
const ops = { id: 2, roleCode: ROLE_CODES.OPS_MANAGER, permissions: perms(ROLE_CODES.OPS_MANAGER) };
const director = { id: 3, roleCode: ROLE_CODES.DIRECTOR, permissions: perms(ROLE_CODES.DIRECTOR) };
const tech = { id: 4, roleCode: ROLE_CODES.TECHNICIAN, permissions: perms(ROLE_CODES.TECHNICIAN) };

describe('meeting edit rights (FR-MTG-01)', () => {
  it('the organizer and Directors may edit; others may not', () => {
    const meeting = { organizerId: bdm.id };
    expect(canEditMeeting(bdm, meeting)).toBe(true);
    expect(canEditMeeting(director, meeting)).toBe(true);
    expect(canEditMeeting(ops, meeting)).toBe(false);
  });

  it('organizing requires meetings:manage', () => {
    expect(canEditMeeting(tech, { organizerId: tech.id })).toBe(
      tech.permissions.includes('meetings:manage'),
    );
  });
});
