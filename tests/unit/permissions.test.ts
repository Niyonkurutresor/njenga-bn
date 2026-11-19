import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from '../../src/rbac/permissions.js';
import { DEFAULT_ROLES, ROLE_CODES } from '../../src/rbac/default-roles.js';

// The frontend keeps a mirror of this catalogue. When both projects are checked out side by side
// (e.g. local development) the test verifies they match; a standalone backend checkout skips it.
const FRONTEND_CATALOGUE = new URL('../../../frontend/src/lib/permissions.ts', import.meta.url);

const P = PERMISSIONS;
const role = (code: string) => DEFAULT_ROLES.find((r) => r.code === code)!;

describe('permission catalogue', () => {
  it.skipIf(!existsSync(FRONTEND_CATALOGUE))(
    'frontend mirror matches the backend catalogue exactly',
    async () => {
      const frontend = (await import(FRONTEND_CATALOGUE.href)) as { PERMISSIONS: unknown };
      expect(frontend.PERMISSIONS).toEqual(PERMISSIONS);
    },
  );

  it('every permission appears exactly once in the role-editor groups', () => {
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    expect([...grouped].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('default roles only grant known permissions', () => {
    for (const r of DEFAULT_ROLES) {
      for (const p of r.permissions) expect(ALL_PERMISSIONS).toContain(p);
    }
  });
});

describe('default role matrix (SRS section 5)', () => {
  it('defines the seven NGL roles', () => {
    expect(DEFAULT_ROLES.map((r) => r.code).sort()).toEqual(Object.values(ROLE_CODES).sort());
  });

  it('Directors approve requests and manage users but do not disburse', () => {
    const d = role(ROLE_CODES.DIRECTOR).permissions;
    expect(d).toEqual(
      expect.arrayContaining([P.REQUESTS_APPROVE, P.USERS_MANAGE, P.ROLES_MANAGE, P.AUDIT_VIEW]),
    );
    expect(d).not.toContain(P.REQUESTS_DISBURSE);
  });

  it('only Directors can view the audit log or approve requests', () => {
    for (const r of DEFAULT_ROLES.filter((x) => x.code !== ROLE_CODES.DIRECTOR)) {
      expect(r.permissions).not.toContain(P.AUDIT_VIEW);
      expect(r.permissions).not.toContain(P.REQUESTS_APPROVE);
    }
  });

  it('Office Administrator reviews and disburses requests and manages finance', () => {
    expect(role(ROLE_CODES.OFFICE_ADMIN).permissions).toEqual(
      expect.arrayContaining([
        P.REQUESTS_REVIEW,
        P.REQUESTS_DISBURSE,
        P.FINANCE_MANAGE,
        P.PAYROLL_MANAGE,
      ]),
    );
  });

  it('every role can submit requests except Directors', () => {
    for (const r of DEFAULT_ROLES.filter((x) => x.code !== ROLE_CODES.DIRECTOR)) {
      expect(r.permissions).toContain(P.REQUESTS_CREATE);
    }
  });

  it('Technicians only see their own projects and tasks', () => {
    const t = role(ROLE_CODES.TECHNICIAN).permissions;
    expect(t).toEqual(
      expect.arrayContaining([
        P.PROJECTS_VIEW_ASSIGNED,
        P.TASKS_VIEW_ASSIGNED,
        P.FIELD_REPORTS_SUBMIT,
      ]),
    );
    expect(t).not.toContain(P.PROJECTS_VIEW);
    expect(t).not.toContain(P.FINANCE_VIEW);
  });
});
