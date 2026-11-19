import { and, asc, between, desc, eq, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  attendance,
  farmReportEntries,
  farmReports,
  greenhouses,
  harvests,
  inspections,
  users,
} from '../../../db/schema/index.js';
import { CROP_HEALTH, PLOT_STATUSES, type CropHealth, type PlotStatus } from '../../../db/enums.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { countBy, fillMonthly, lastMonths, linkTo, monthOf } from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface FarmSection {
  kpis: Kpi[];
  todayReport: { id: number; submittedBy: string; createdAt: Date } | null;
  latestReportDate: string | null;
  cropHealth: Record<CropHealth, number>;
  greenhousesByStatus: Record<PlotStatus, number>;
  harvestByCrop: { crop: string; unit: string; quantity: number }[];
  harvestTrend: { month: string; kg: number; units: number }[];
  agronomy: {
    followUpsDue: {
      id: number;
      greenhouse: string;
      disease: string | null;
      followUpDate: string | null;
      severity: string;
      link: string;
    }[];
    greenhousePerformance: {
      id: number;
      name: string;
      crop: string | null;
      harvestKg: number;
      openCases: number;
      link: string;
    }[];
  } | null;
}

const liveInspection = isNull(inspections.deletedAt);
const openCase = and(
  liveInspection,
  ne(inspections.status, 'closed'),
  or(isNotNull(inspections.diseaseIdentified), ne(inspections.severity, 'none')),
);

/**
 * Farm Manager / Director farm status (FR-DSH-02, FR-FRM-02..04, FR-FRM-09) plus the agronomist
 * block (inspections due, open disease cases, greenhouse performance).
 */
export const farmSection: SectionBuilder<FarmSection> = {
  key: 'farm',
  visible: (ctx) => ctx.can(P.FARM_VIEW),
  async build(ctx) {
    const { period, today } = ctx;
    const months = lastMonths(period.to, 12);
    const monthExpr = sql<string>`DATE_FORMAT(${harvests.harvestDate}, '%Y-%m')`;
    const agronomist = ctx.can(P.INSPECTIONS_CREATE);
    const liveHarvest = isNull(harvests.deletedAt);

    const [
      todayRows,
      latest,
      ghStatus,
      [cases],
      byCrop,
      trendRows,
      [att],
      dueRows,
      perfHarvest,
      perfCases,
      ghList,
    ] = await Promise.all([
      db
        .select({ id: farmReports.id, submittedBy: users.name, createdAt: farmReports.createdAt })
        .from(farmReports)
        .innerJoin(users, eq(users.id, farmReports.submittedBy))
        .where(eq(farmReports.reportDate, today))
        .limit(1),
      db
        .select({ id: farmReports.id, reportDate: farmReports.reportDate })
        .from(farmReports)
        .orderBy(desc(farmReports.reportDate))
        .limit(1),
      db
        .select({ key: greenhouses.status, n: sql<number>`count(*)` })
        .from(greenhouses)
        .where(isNull(greenhouses.deletedAt))
        .groupBy(greenhouses.status),
      db
        .select({
          open: sql<number>`count(*)`,
          high: sql<number>`SUM(CASE WHEN ${inspections.severity} = 'high' THEN 1 ELSE 0 END)`,
        })
        .from(inspections)
        .where(openCase),
      db
        .select({
          crop: harvests.crop,
          unit: harvests.unit,
          quantity: sql<string>`COALESCE(SUM(${harvests.quantity}), 0)`,
        })
        .from(harvests)
        .where(and(liveHarvest, between(harvests.harvestDate, period.from, period.to)))
        .groupBy(harvests.crop, harvests.unit)
        .orderBy(desc(sql`SUM(${harvests.quantity})`)),
      db
        .select({
          month: monthExpr,
          kg: sql<string>`COALESCE(SUM(CASE WHEN ${harvests.unit} = 'kg' THEN ${harvests.quantity} ELSE 0 END), 0)`,
          units: sql<string>`COALESCE(SUM(CASE WHEN ${harvests.unit} = 'units' THEN ${harvests.quantity} ELSE 0 END), 0)`,
        })
        .from(harvests)
        .where(
          and(liveHarvest, between(harvests.harvestDate, `${months[0]}-01`, monthOf(period.to).to)),
        )
        .groupBy(monthExpr),
      db
        .select({
          recorded: sql<number>`count(*)`,
          present: sql<number>`SUM(CASE WHEN ${attendance.present} = 1 THEN 1 ELSE 0 END)`,
        })
        .from(attendance)
        .where(and(eq(attendance.workDate, today), eq(attendance.siteType, 'farm'))),
      agronomist
        ? db
            .select({
              id: inspections.id,
              greenhouse: greenhouses.name,
              disease: inspections.diseaseIdentified,
              followUpDate: inspections.followUpDate,
              severity: inspections.severity,
            })
            .from(inspections)
            .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
            .where(
              and(
                liveInspection,
                ne(inspections.status, 'closed'),
                lte(inspections.followUpDate, today),
              ),
            )
            .orderBy(asc(inspections.followUpDate))
            .limit(8)
        : [],
      agronomist
        ? db
            .select({
              id: harvests.greenhouseId,
              kg: sql<string>`COALESCE(SUM(${harvests.quantity}), 0)`,
            })
            .from(harvests)
            .where(
              and(
                liveHarvest,
                eq(harvests.unit, 'kg'),
                between(harvests.harvestDate, period.from, period.to),
              ),
            )
            .groupBy(harvests.greenhouseId)
        : [],
      agronomist
        ? db
            .select({ id: inspections.greenhouseId, n: sql<number>`count(*)` })
            .from(inspections)
            .where(openCase)
            .groupBy(inspections.greenhouseId)
        : [],
      agronomist
        ? db
            .select({ id: greenhouses.id, name: greenhouses.name, crop: greenhouses.currentCrop })
            .from(greenhouses)
            .where(isNull(greenhouses.deletedAt))
            .orderBy(asc(greenhouses.name))
        : [],
    ]);

    const latestReport = latest[0] ?? null;
    const healthRows = latestReport
      ? await db
          .select({ key: farmReportEntries.cropHealth, n: sql<number>`count(*)` })
          .from(farmReportEntries)
          .where(eq(farmReportEntries.reportId, latestReport.id))
          .groupBy(farmReportEntries.cropHealth)
      : [];
    const cropHealth = countBy(CROP_HEALTH, healthRows);
    const greenhousesByStatus = countBy(PLOT_STATUSES, ghStatus);
    const todayReport = todayRows[0] ?? null;
    const highCases = Number(cases?.high ?? 0);
    const harvestKg = round2(
      byCrop.filter((r) => r.unit === 'kg').reduce((a, r) => a + toNumber(r.quantity), 0),
    );
    const recorded = Number(att?.recorded ?? 0);
    const present = Number(att?.present ?? 0);
    const range = { from: period.from, to: period.to };

    const kpis: Kpi[] = [
      {
        key: 'todayReport',
        label: "Today's farm report",
        value: todayReport ? 1 : 0,
        format: 'number',
        tone: todayReport ? 'green' : 'amber',
        hint: todayReport ? `Submitted by ${todayReport.submittedBy}` : 'Not submitted yet',
        link: todayReport ? `/farm/reports/${todayReport.id}` : '/farm/reports/new',
      },
      {
        key: 'poorHealth',
        label: 'Greenhouses in poor health',
        value: cropHealth.poor,
        format: 'number',
        tone: cropHealth.poor ? 'red' : cropHealth.fair ? 'amber' : 'green',
        hint: latestReport ? `From report of ${latestReport.reportDate}` : 'No reports yet',
        link: latestReport ? `/farm/reports/${latestReport.id}` : '/farm/reports',
      },
      {
        key: 'highCases',
        label: 'Open high-severity cases',
        value: highCases,
        format: 'number',
        tone: highCases ? 'red' : 'green',
        hint: `${Number(cases?.open ?? 0)} open disease/pest cases`,
        link: '/farm/inspections?status=open&severity=high',
      },
      {
        key: 'harvest',
        label: 'Harvest (kg)',
        value: harvestKg,
        format: 'number',
        tone: 'green',
        link: linkTo('/farm/harvests', range),
      },
      {
        key: 'attendance',
        label: 'Farm workers present today',
        value: present,
        format: 'number',
        hint: recorded ? `${recorded - present} absent` : 'Attendance not recorded',
        tone: recorded ? 'neutral' : 'amber',
        link: linkTo('/payroll/attendance', { date: today, siteType: 'farm' }),
      },
    ];

    let agronomy: FarmSection['agronomy'] = null;
    if (agronomist) {
      const kg = new Map(perfHarvest.map((r) => [r.id, toNumber(r.kg)]));
      const open = new Map(perfCases.map((r) => [r.id, Number(r.n)]));
      agronomy = {
        followUpsDue: dueRows.map((r) => ({ ...r, link: `/farm/inspections/${r.id}` })),
        greenhousePerformance: ghList.map((g) => ({
          ...g,
          harvestKg: kg.get(g.id) ?? 0,
          openCases: open.get(g.id) ?? 0,
          link: `/farm/greenhouses/${g.id}`,
        })),
      };
      kpis.push({
        key: 'followUps',
        label: 'Inspections / follow-ups due',
        value: dueRows.length,
        format: 'number',
        tone: dueRows.length ? 'amber' : 'green',
        link: linkTo('/farm/inspections', { followUpDue: 'true' }),
      });
    }

    return {
      kpis,
      todayReport,
      latestReportDate: latestReport?.reportDate ?? null,
      cropHealth,
      greenhousesByStatus,
      harvestByCrop: byCrop.map((r) => ({ ...r, quantity: toNumber(r.quantity) })),
      harvestTrend: fillMonthly(
        months,
        trendRows.map((r) => ({ month: r.month, kg: toNumber(r.kg), units: toNumber(r.units) })),
        ['kg', 'units'] as const,
      ),
      agronomy,
    };
  },
};
