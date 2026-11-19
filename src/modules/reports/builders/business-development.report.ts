import {
  and,
  asc,
  between,
  eq,
  gte,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import { leads, sales, users } from '../../../db/schema/index.js';
import { LEAD_STAGES } from '../../../db/enums.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { winRate } from '../../dashboard/dashboard.calc.js';
import { clip, computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { dayBounds, labelOf, optionalId } from './_shared.js';

const filterSchema = z.object({ ownerId: optionalId });
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'title', label: 'Lead', type: 'text' },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'owner', label: 'Owner', type: 'text' },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'stage', label: 'Stage', type: 'text' },
  { key: 'value', label: 'Estimated value', type: 'money' },
  { key: 'expectedClose', label: 'Expected close', type: 'date' },
  { key: 'followUp', label: 'Next follow-up', type: 'date' },
  { key: 'lostReason', label: 'Lost reason', type: 'text' },
];

const stageColumns: ReportColumn[] = [
  { key: 'stage', label: 'Stage', type: 'text' },
  { key: 'count', label: 'Leads', type: 'number' },
  { key: 'value', label: 'Value', type: 'money' },
];

/**
 * Business development report (BRD 6, FR-BDV-07): leads active in the period, deals won
 * and lost, pipeline value by stage and sales.
 */
export const businessDevelopmentReport: ReportDefinition<Filters> = {
  key: 'business-development',
  title: 'Business development report',
  description: 'Leads, deals won and lost, pipeline value by stage and sales',
  department: 'business',
  permissions: [P.REPORTS_BUSINESS],
  defaultPeriod: 'month',
  filters: [{ key: 'ownerId', label: 'Owner', source: 'users' }],
  filterSchema,
  async build({ from, to, filters }) {
    const [start, end] = dayBounds(from, to);
    const where: SQL[] = [
      isNull(leads.deletedAt),
      lte(leads.createdAt, end),
      // Still open, or touched (created/closed) during the period.
      or(notInArray(leads.stage, ['won', 'lost']), gte(leads.updatedAt, start))!,
    ];
    if (filters.ownerId) where.push(eq(leads.ownerId, filters.ownerId));

    const [leadRows, [sold]] = await Promise.all([
      db
        .select({
          title: leads.title,
          company: leads.companyName,
          owner: users.name,
          source: leads.source,
          stage: leads.stage,
          value: leads.estimatedValue,
          expectedClose: leads.expectedCloseDate,
          followUp: leads.followUpDate,
          lostReason: leads.lostReason,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
        })
        .from(leads)
        .innerJoin(users, eq(users.id, leads.ownerId))
        .where(and(...where))
        .orderBy(
          asc(
            sql`FIELD(${leads.stage}, 'new','contacted','proposal_sent','negotiation','won','lost')`,
          ),
          asc(leads.companyName),
        ),
      db
        .select({ n: sql<number>`count(*)`, total: sql<string>`COALESCE(SUM(${sales.amount}), 0)` })
        .from(sales)
        .where(and(isNull(sales.deletedAt), between(sales.saleDate, from, to))),
    ]);

    const rows = leadRows.map((l) => ({
      title: l.title,
      company: l.company,
      owner: l.owner,
      source: l.source,
      stage: labelOf(l.stage),
      value: toNumber(l.value),
      expectedClose: l.expectedClose,
      followUp: l.followUp,
      lostReason: clip(l.lostReason, 200),
    }));
    const inPeriod = (d: Date) => d >= start && d <= end;
    const won = leadRows.filter((l) => l.stage === 'won' && inPeriod(l.updatedAt));
    const lost = leadRows.filter((l) => l.stage === 'lost' && inPeriod(l.updatedAt));
    const open = leadRows.filter((l) => l.stage !== 'won' && l.stage !== 'lost');
    const valueOf = (list: typeof leadRows) =>
      round2(list.reduce((a, l) => a + toNumber(l.value), 0));
    const stageRows = LEAD_STAGES.map((s) => {
      const list = leadRows.filter((l) => l.stage === s);
      return { stage: labelOf(s), count: list.length, value: valueOf(list) };
    });

    return {
      columns,
      rows,
      totals: computeTotals(columns, rows),
      summary: [
        {
          label: 'New leads',
          value: leadRows.filter((l) => inPeriod(l.createdAt)).length,
          type: 'number',
        },
        { label: 'Open leads', value: open.length, type: 'number' },
        { label: 'Pipeline value (open)', value: valueOf(open), type: 'money' },
        { label: 'Deals won', value: won.length, type: 'number' },
        { label: 'Value won', value: valueOf(won), type: 'money' },
        { label: 'Deals lost', value: lost.length, type: 'number' },
        { label: 'Win rate', value: winRate(won.length, lost.length), type: 'percent' },
        { label: 'Sales recorded', value: toNumber(sold?.total), type: 'money' },
      ],
      sections: [
        {
          key: 'pipeline',
          title: 'Pipeline by stage',
          columns: stageColumns,
          rows: stageRows,
          totals: computeTotals(stageColumns, stageRows, ['count', 'value']),
        },
      ],
    };
  },
};
