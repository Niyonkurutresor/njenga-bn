import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, ROLE_CODES } from '../../src/rbac/default-roles.js';
import { availableActions, canPerform } from '../../src/modules/requests/requests.workflow.js';

const perms = (code: string) => DEFAULT_ROLES.find((r) => r.code === code)!.permissions;

const technician = { id: 10, permissions: perms(ROLE_CODES.TECHNICIAN) };
const officeAdmin = { id: 20, permissions: perms(ROLE_CODES.OFFICE_ADMIN) };
const director = { id: 30, permissions: perms(ROLE_CODES.DIRECTOR) };

const req = (status: Parameters<typeof canPerform>[2]['status']) => ({
  status,
  requesterId: technician.id,
});

describe('request workflow (SRS 3.2.1)', () => {
  it('Office Administrator forwards or returns submitted requests', () => {
    expect(availableActions(officeAdmin, req('submitted'))).toEqual([
      'forward',
      'return',
      'comment',
    ]);
    expect(canPerform('approve', officeAdmin, req('pending_approval'))).toBe(false);
  });

  it('only the requester resubmits a returned request', () => {
    expect(canPerform('resubmit', technician, req('returned'))).toBe(true);
    expect(canPerform('resubmit', officeAdmin, req('returned'))).toBe(false);
  });

  it('only Directors approve or reject pending requests', () => {
    expect(availableActions(director, req('pending_approval'))).toEqual([
      'approve',
      'reject',
      'comment',
    ]);
    expect(canPerform('approve', technician, req('pending_approval'))).toBe(false);
    expect(canPerform('approve', director, req('submitted'))).toBe(false);
  });

  it('payment is only possible after approval (BRL-01, FR-REQ-11)', () => {
    for (const status of [
      'submitted',
      'returned',
      'pending_approval',
      'rejected',
      'paid',
    ] as const) {
      expect(canPerform('pay', officeAdmin, req(status))).toBe(false);
    }
    expect(canPerform('pay', officeAdmin, req('approved'))).toBe(true);
    expect(canPerform('pay', director, req('approved'))).toBe(false);
  });

  it('closed requests accept no further actions', () => {
    expect(availableActions(director, req('rejected'))).toEqual([]);
    expect(availableActions(officeAdmin, req('paid'))).toEqual([]);
  });
});
