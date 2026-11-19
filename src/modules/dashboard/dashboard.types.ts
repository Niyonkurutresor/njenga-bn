import type { Permission } from '../../rbac/permissions.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { Period } from './dashboard.calc.js';

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

/** One headline figure. `link` opens the records behind it (FR-DSH-03). */
export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  format: 'money' | 'number' | 'percent';
  link?: string;
  tone?: Tone;
  hint?: string;
}

export interface DashboardContext {
  user: AuthUser;
  period: Period;
  /** Company-timezone date. */
  today: string;
  can(permission: Permission): boolean;
  canAny(...permissions: Permission[]): boolean;
}

/**
 * A dashboard section: shown only when `visible` (decided from permissions, never role codes,
 * so customised roles keep working — FR-DSH-01, NFR-13).
 */
export interface SectionBuilder<T = unknown> {
  key: string;
  visible(ctx: DashboardContext): boolean;
  build(ctx: DashboardContext): Promise<T>;
}
