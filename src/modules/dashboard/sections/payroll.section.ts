import { and, between, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { casualWorkers, payrollRuns, transactions } from '../../../db/schema/index.js';
import { toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface PayrollSection {
  kpis: Kpi[];
}

/** Salaries and casual pay posted to the ledger in the period (FR-PAY-06). */
export const payrollSection: SectionBuilder<PayrollSection> = {
  key: 'payroll',
  visible: (ctx) => ctx.can(P.PAYROLL_VIEW),
  async build({ period }) {
    const t = transactions;
    const [[paid], [drafts], [workers]] = await Promise.all([
      db
        .select({
          salaries: sql<string>`COALESCE(SUM(CASE WHEN ${t.source} = 'payroll' THEN ${t.amount} ELSE 0 END), 0)`,
          casual: sql<string>`COALESCE(SUM(CASE WHEN ${t.source} = 'casual_payroll' THEN ${t.amount} ELSE 0 END), 0)`,
        })
        .from(t)
        .where(
          and(
            isNull(t.deletedAt),
            eq(t.direction, 'out'),
            between(t.transactionDate, period.from, period.to),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)` })
        .from(payrollRuns)
        .where(eq(payrollRuns.status, 'draft')),
      db
        .select({ n: sql<number>`count(*)` })
        .from(casualWorkers)
        .where(and(isNull(casualWorkers.deletedAt), eq(casualWorkers.status, 'active'))),
    ]);
    const draftRuns = Number(drafts?.n ?? 0);
    return {
      kpis: [
        {
          key: 'salaries',
          label: 'Salaries paid',
          value: toNumber(paid?.salaries),
          format: 'money',
          hint: draftRuns ? `${draftRuns} payroll run(s) awaiting payment` : undefined,
          tone: draftRuns ? 'amber' : 'neutral',
          link: '/payroll',
        },
        {
          key: 'casual',
          label: 'Casual worker pay',
          value: toNumber(paid?.casual),
          format: 'money',
          hint: `${Number(workers?.n ?? 0)} active casual workers`,
          link: '/payroll/casual',
        },
      ],
    };
  },
};
