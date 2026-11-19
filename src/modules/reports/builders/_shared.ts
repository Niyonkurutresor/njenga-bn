import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { transactions } from '../../../db/schema/index.js';
import { COST_CENTRE_TYPES } from '../../../db/enums.js';
import type { ReportFilterDef } from '../report.types.js';

export const optionalId = z.coerce.number().int().positive().optional();
export const noFilters = z.object({});

const t = transactions;
/** P&L income (FR-FIN-08): money in that affects profit and loss. */
export const incomeAmt = sql`CASE WHEN ${t.direction} = 'in' AND ${t.affectsPnl} = 1 THEN ${t.amount} ELSE 0 END`;
/** P&L costs: money out that affects profit and loss. */
export const costAmt = sql`CASE WHEN ${t.direction} = 'out' AND ${t.affectsPnl} = 1 THEN ${t.amount} ELSE 0 END`;
/** Signed cash movement (FR-FIN-09). */
export const cashAmt = sql`CASE WHEN ${t.affectsCash} = 1 THEN (CASE WHEN ${t.direction} = 'in' THEN ${t.amount} ELSE -${t.amount} END) ELSE 0 END`;

export const costCentreFilter: ReportFilterDef = {
  key: 'costCentreType',
  label: 'Cost centre',
  options: COST_CENTRE_TYPES.map((v) => ({ value: v, label: labelOf(v) })),
};
export const projectFilter: ReportFilterDef = {
  key: 'projectId',
  label: 'Project',
  source: 'projects',
};

/** "pending_approval" → "Pending approval". */
export function labelOf(value: string | null | undefined): string {
  if (!value) return '';
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** UTC bounds for DATETIME columns covering whole days. */
export function dayBounds(from: string, to: string): [Date, Date] {
  return [new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59.999Z`)];
}

/** Cost-centre label: project code/name or Farm / Office. */
export function centreLabel(
  type: string,
  projectCode?: string | null,
  projectName?: string | null,
) {
  if (type === 'project')
    return projectCode ? `${projectCode} ${projectName ?? ''}`.trim() : 'Project';
  return labelOf(type);
}
