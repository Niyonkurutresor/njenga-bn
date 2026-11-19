import { today } from '../../common/utils/dates.js';
import { hasPermissions, type Permission } from '../../rbac/permissions.js';
import type { AuthUser } from '../auth/auth.types.js';
import { resolvePeriod } from './dashboard.calc.js';
import type { DashboardQuery } from './dashboard.schema.js';
import type { DashboardContext, SectionBuilder } from './dashboard.types.js';
import { approvalsSection } from './sections/approvals.section.js';
import { businessSection } from './sections/business.section.js';
import { departmentalSection } from './sections/departmental.section.js';
import { farmSection } from './sections/farm.section.js';
import { fieldSection } from './sections/field.section.js';
import { financeSection } from './sections/finance.section.js';
import { inventorySection } from './sections/inventory.section.js';
import { meetingsSection } from './sections/meetings.section.js';
import { payrollSection } from './sections/payroll.section.js';
import { projectsSection } from './sections/projects.section.js';
import { tasksSection } from './sections/tasks.section.js';

/**
 * Every dashboard section, in display order. A section is included when the user's
 * permissions allow it, so customised roles compose their own dashboard (FR-DSH-01).
 */
export const SECTIONS: readonly SectionBuilder[] = [
  financeSection,
  approvalsSection,
  departmentalSection,
  projectsSection,
  tasksSection,
  fieldSection,
  farmSection,
  businessSection,
  inventorySection,
  payrollSection,
  meetingsSection,
];

export function dashboardContext(
  user: AuthUser,
  query: DashboardQuery,
  on = today(),
): DashboardContext {
  return {
    user,
    today: on,
    period: resolvePeriod(query, on, 'month'),
    can: (p: Permission) => user.permissions.includes(p),
    canAny: (...ps: Permission[]) => hasPermissions(user.permissions, ps, 'any'),
  };
}

export const dashboardService = {
  /** One response with the sections this user may see (FR-DSH-01..05). Queries run in parallel (NFR-01). */
  async get(user: AuthUser, query: DashboardQuery) {
    const ctx = dashboardContext(user, query);
    const visible = SECTIONS.filter((s) => s.visible(ctx));
    const built = await Promise.all(visible.map((s) => s.build(ctx)));
    return {
      period: ctx.period,
      today: ctx.today,
      generatedAt: new Date().toISOString(),
      user: { id: user.id, name: user.name, roleName: user.roleName },
      sections: Object.fromEntries(visible.map((s, i) => [s.key, built[i]])),
    };
  },
};
