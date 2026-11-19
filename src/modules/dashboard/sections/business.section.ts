import { and, asc, between, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { leads, sales, satisfactionRatings, users } from '../../../db/schema/index.js';
import { LEAD_STAGES, type LeadStage } from '../../../db/enums.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { linkTo, winRate } from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface BusinessSection {
  kpis: Kpi[];
  pipeline: { stage: LeadStage; count: number; value: number; link: string }[];
  followUpsDue: {
    id: number;
    title: string;
    companyName: string;
    followUpDate: string | null;
    owner: string;
    link: string;
  }[];
}

const CLOSED: LeadStage[] = ['won', 'lost'];

/** Utc bounds for DATETIME columns covering whole company days. */
export function dayBounds(from: string, to: string): [Date, Date] {
  return [new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59.999Z`)];
}

/** BDM / Ops: leads, pipeline by stage (FR-BDV-07), deals won/lost, follow-ups, sales, satisfaction. */
export const businessSection: SectionBuilder<BusinessSection> = {
  key: 'business',
  visible: (ctx) => ctx.can(P.CRM_VIEW),
  async build({ period, today }) {
    const [start, end] = dayBounds(period.from, period.to);
    const live = isNull(leads.deletedAt);

    const [stageRows, [closed], [created], dueRows, [sold], [rating]] = await Promise.all([
      db
        .select({
          stage: leads.stage,
          n: sql<number>`count(*)`,
          value: sql<string>`COALESCE(SUM(${leads.estimatedValue}), 0)`,
        })
        .from(leads)
        .where(live)
        .groupBy(leads.stage),
      // No stage-change timestamp exists: a lead closed in the period is one won/lost and last
      // updated in the period.
      db
        .select({
          won: sql<number>`SUM(CASE WHEN ${leads.stage} = 'won' THEN 1 ELSE 0 END)`,
          wonValue: sql<string>`COALESCE(SUM(CASE WHEN ${leads.stage} = 'won' THEN ${leads.estimatedValue} ELSE 0 END), 0)`,
          lost: sql<number>`SUM(CASE WHEN ${leads.stage} = 'lost' THEN 1 ELSE 0 END)`,
        })
        .from(leads)
        .where(
          and(
            live,
            inArray(leads.stage, CLOSED),
            gte(leads.updatedAt, start),
            lte(leads.updatedAt, end),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(and(live, gte(leads.createdAt, start), lte(leads.createdAt, end))),
      db
        .select({
          id: leads.id,
          title: leads.title,
          companyName: leads.companyName,
          followUpDate: leads.followUpDate,
          owner: users.name,
        })
        .from(leads)
        .innerJoin(users, eq(users.id, leads.ownerId))
        .where(and(live, notInArray(leads.stage, CLOSED), lte(leads.followUpDate, today)))
        .orderBy(asc(leads.followUpDate))
        .limit(8),
      db
        .select({ n: sql<number>`count(*)`, total: sql<string>`COALESCE(SUM(${sales.amount}), 0)` })
        .from(sales)
        .where(and(isNull(sales.deletedAt), between(sales.saleDate, period.from, period.to))),
      db
        .select({
          avg: sql<string | null>`AVG(${satisfactionRatings.rating})`,
          n: sql<number>`count(*)`,
        })
        .from(satisfactionRatings),
    ]);

    const byStage = new Map(stageRows.map((r) => [r.stage, r]));
    const pipeline = LEAD_STAGES.map((stage) => ({
      stage,
      count: Number(byStage.get(stage)?.n ?? 0),
      value: toNumber(byStage.get(stage)?.value),
      link: `/crm/pipeline?view=list&stage=${stage}`,
    }));
    const active = pipeline.filter((p) => !CLOSED.includes(p.stage));
    const won = Number(closed?.won ?? 0);
    const lost = Number(closed?.lost ?? 0);
    const avgRating = rating?.avg == null ? null : Math.round(toNumber(rating.avg) * 10) / 10;
    const range = { from: period.from, to: period.to };

    const kpis: Kpi[] = [
      {
        key: 'activeLeads',
        label: 'Active leads',
        value: active.reduce((a, p) => a + p.count, 0),
        format: 'number',
        hint: `${Number(created?.n ?? 0)} new this period`,
        link: '/crm/pipeline?view=list&open=true',
      },
      {
        key: 'pipelineValue',
        label: 'Pipeline value',
        value: round2(active.reduce((a, p) => a + p.value, 0)),
        format: 'money',
        link: '/crm/pipeline?view=list&open=true',
      },
      {
        key: 'won',
        label: 'Deals won',
        value: won,
        format: 'number',
        tone: 'green',
        hint: `RWF ${toNumber(closed?.wonValue).toLocaleString('en-US')} · win rate ${winRate(won, lost) ?? '—'}%`,
        link: '/crm/pipeline?view=list&stage=won',
      },
      {
        key: 'lost',
        label: 'Deals lost',
        value: lost,
        format: 'number',
        tone: lost ? 'red' : 'neutral',
        link: '/crm/pipeline?view=list&stage=lost',
      },
      {
        key: 'followUps',
        label: 'Follow-ups due',
        value: dueRows.length,
        format: 'number',
        tone: dueRows.length ? 'amber' : 'green',
        link: '/crm/pipeline?view=list&followUpDue=true',
      },
      {
        key: 'sales',
        label: 'Sales',
        value: toNumber(sold?.total),
        format: 'money',
        hint: `${Number(sold?.n ?? 0)} sales`,
        link: linkTo('/crm/sales', range),
      },
      {
        key: 'satisfaction',
        label: 'Customer satisfaction',
        value: avgRating,
        format: 'number',
        hint: `Average of ${Number(rating?.n ?? 0)} ratings (1–5)`,
        tone:
          avgRating === null
            ? 'neutral'
            : avgRating >= 4
              ? 'green'
              : avgRating >= 3
                ? 'amber'
                : 'red',
        link: '/crm/customers',
      },
    ];

    return {
      kpis,
      pipeline,
      followUpsDue: dueRows.map((r) => ({ ...r, link: `/crm/leads/${r.id}` })),
    };
  },
};
