import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  attendance,
  farmReportEntries,
  farmReports,
  greenhouses,
  harvests,
  inspections,
  users,
} from '../../db/schema/index.js';
import type { CropHealth, ObservationSeverity } from '../../db/enums.js';
import { addDays, monthRange, today } from '../../common/utils/dates.js';
import { healthCounts, worstSeverity } from './farm.calc.js';
import { latestObservations, openCaseCounts } from './farm.shared.js';
import type { CropReportQuery } from './farm.schema.js';

const LIST_LIMIT = 20;

const inspectionSummary = {
  id: inspections.id,
  inspectionDate: inspections.inspectionDate,
  diseaseIdentified: inspections.diseaseIdentified,
  severity: inspections.severity,
  status: inspections.status,
  followUpDate: inspections.followUpDate,
  findings: inspections.findings,
  greenhouse: { id: greenhouses.id, name: greenhouses.name },
  agronomist: { id: users.id, name: users.name },
};

export const farmService = {
  /** Farm landing page (Farm Manager dashboard widgets, SRS 3.12). */
  async overview(date: string = today()) {
    const month = monthRange(date);
    const plots = await db
      .select({
        id: greenhouses.id,
        name: greenhouses.name,
        kind: greenhouses.kind,
        status: greenhouses.status,
        currentCrop: greenhouses.currentCrop,
        plantingDate: greenhouses.plantingDate,
      })
      .from(greenhouses)
      .where(isNull(greenhouses.deletedAt))
      .orderBy(asc(greenhouses.name));
    const ids = plots.map((p) => p.id);

    const [[report], latest, cases, openHigh, due, harvestTotals, recentHarvests, [present]] =
      await Promise.all([
        db
          .select({
            id: farmReports.id,
            createdAt: farmReports.createdAt,
            updatedAt: farmReports.updatedAt,
            submittedBy: { id: users.id, name: users.name },
          })
          .from(farmReports)
          .innerJoin(users, eq(users.id, farmReports.submittedBy))
          .where(eq(farmReports.reportDate, date)),
        latestObservations(ids, date),
        openCaseCounts(ids),
        db
          .select(inspectionSummary)
          .from(inspections)
          .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
          .innerJoin(users, eq(users.id, inspections.agronomistId))
          .where(
            and(
              isNull(inspections.deletedAt),
              eq(inspections.severity, 'high'),
              ne(inspections.status, 'closed'),
            ),
          )
          .orderBy(desc(inspections.inspectionDate))
          .limit(LIST_LIMIT),
        db
          .select(inspectionSummary)
          .from(inspections)
          .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
          .innerJoin(users, eq(users.id, inspections.agronomistId))
          .where(
            and(
              isNull(inspections.deletedAt),
              isNotNull(inspections.followUpDate),
              lte(inspections.followUpDate, date),
              ne(inspections.status, 'closed'),
            ),
          )
          .orderBy(asc(inspections.followUpDate))
          .limit(LIST_LIMIT),
        db
          .select({ unit: harvests.unit, total: sql<string>`sum(${harvests.quantity})` })
          .from(harvests)
          .where(
            and(
              isNull(harvests.deletedAt),
              gte(harvests.harvestDate, month.from),
              lte(harvests.harvestDate, month.to),
            ),
          )
          .groupBy(harvests.unit),
        db
          .select({
            id: harvests.id,
            crop: harvests.crop,
            quantity: harvests.quantity,
            unit: harvests.unit,
            grade: harvests.grade,
            harvestDate: harvests.harvestDate,
            greenhouse: { id: greenhouses.id, name: greenhouses.name },
          })
          .from(harvests)
          .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
          .where(isNull(harvests.deletedAt))
          .orderBy(desc(harvests.harvestDate), desc(harvests.id))
          .limit(5),
        db
          .select({ n: sql<number>`count(*)` })
          .from(attendance)
          .where(
            and(
              eq(attendance.workDate, date),
              eq(attendance.siteType, 'farm'),
              eq(attendance.present, true),
            ),
          ),
      ]);

    const greenhouseCards = plots.map((p) => ({
      ...p,
      latest: latest.get(p.id) ?? null,
      openCases: cases.get(p.id)?.open ?? 0,
      openHighCases: cases.get(p.id)?.high ?? 0,
    }));
    const active = greenhouseCards.filter((g) => g.status === 'active');
    const sumUnit = (u: string) => Number(harvestTotals.find((h) => h.unit === u)?.total ?? 0);

    return {
      date,
      report: report ? { submitted: true, ...report } : { submitted: false, id: null },
      cropHealth: healthCounts(active.map((g) => g.latest?.cropHealth)),
      greenhouseStatus: {
        active: active.length,
        fallow: plots.filter((p) => p.status === 'fallow').length,
        maintenance: plots.filter((p) => p.status === 'maintenance').length,
      },
      greenhouses: greenhouseCards,
      openCases: [...cases.values()].reduce((n, c) => n + c.open, 0),
      openHighSeverity: openHigh,
      inspectionsDue: due,
      harvestThisMonth: {
        from: month.from,
        to: month.to,
        kg: sumUnit('kg'),
        units: sumUnit('units'),
      },
      recentHarvests,
      attendanceToday: Number(present?.n ?? 0),
    };
  },

  /**
   * Crop inspection report for a period (US-AG-002): findings, diseases, treatments and
   * fertiliser per greenhouse, with the daily-report pest observations alongside.
   */
  async cropReport(query: CropReportQuery) {
    const to = query.to ?? today();
    const from = query.from ?? addDays(to, -29);

    const [inspectionRows, observationRows] = await Promise.all([
      db
        .select({
          id: inspections.id,
          greenhouseId: inspections.greenhouseId,
          inspectionDate: inspections.inspectionDate,
          findings: inspections.findings,
          diseaseIdentified: inspections.diseaseIdentified,
          severity: inspections.severity,
          recommendedTreatment: inspections.recommendedTreatment,
          recommendedFertiliser: inspections.recommendedFertiliser,
          followUpDate: inspections.followUpDate,
          status: inspections.status,
          agronomist: { id: users.id, name: users.name },
        })
        .from(inspections)
        .innerJoin(users, eq(users.id, inspections.agronomistId))
        .where(
          and(
            isNull(inspections.deletedAt),
            gte(inspections.inspectionDate, from),
            lte(inspections.inspectionDate, to),
          ),
        )
        .orderBy(asc(inspections.inspectionDate), asc(inspections.id)),
      db
        .select({
          greenhouseId: farmReportEntries.greenhouseId,
          reportDate: farmReports.reportDate,
          cropHealth: farmReportEntries.cropHealth,
          severity: farmReportEntries.severity,
          pestsObserved: farmReportEntries.pestsObserved,
        })
        .from(farmReportEntries)
        .innerJoin(farmReports, eq(farmReports.id, farmReportEntries.reportId))
        .where(and(gte(farmReports.reportDate, from), lte(farmReports.reportDate, to)))
        .orderBy(asc(farmReports.reportDate)),
    ]);

    const involved = new Set([
      ...inspectionRows.map((r) => r.greenhouseId),
      ...observationRows.map((r) => r.greenhouseId),
    ]);
    const plots = await db
      .select({
        id: greenhouses.id,
        name: greenhouses.name,
        kind: greenhouses.kind,
        currentCrop: greenhouses.currentCrop,
        status: greenhouses.status,
        deletedAt: greenhouses.deletedAt,
      })
      .from(greenhouses)
      .orderBy(asc(greenhouses.name));

    const rows = plots
      .filter((p) => (!p.deletedAt && p.status === 'active') || involved.has(p.id))
      .map(({ deletedAt: _d, ...p }) => {
        const found = inspectionRows.filter((r) => r.greenhouseId === p.id);
        const seen = observationRows.filter((r) => r.greenhouseId === p.id);
        const pests = seen.filter((o) => o.severity !== 'none' || o.pestsObserved);
        const severities: ObservationSeverity[] = [
          ...found.map((r) => r.severity),
          ...seen.map((r) => r.severity),
        ];
        return {
          greenhouse: p,
          inspectionCount: found.length,
          openCases: found.filter((r) => r.status !== 'closed' && r.severity !== 'none').length,
          worstSeverity: worstSeverity(severities),
          diseases: [
            ...new Set(found.map((r) => r.diseaseIdentified).filter((d): d is string => !!d)),
          ],
          health: healthCounts(seen.map((o) => o.cropHealth as CropHealth)),
          latestHealth: seen.at(-1)?.cropHealth ?? null,
          inspections: found.map(({ greenhouseId: _g, ...r }) => r),
          pestObservations: pests.map((o) => ({
            reportDate: o.reportDate,
            severity: o.severity,
            pestsObserved: o.pestsObserved,
            cropHealth: o.cropHealth,
          })),
        };
      });

    return {
      from,
      to,
      totals: {
        inspections: inspectionRows.length,
        highSeverity: inspectionRows.filter((r) => r.severity === 'high').length,
        openCases: inspectionRows.filter((r) => r.status !== 'closed' && r.severity !== 'none')
          .length,
        diseases: [
          ...new Set(
            inspectionRows.map((r) => r.diseaseIdentified).filter((d): d is string => !!d),
          ),
        ],
        treatments: inspectionRows.filter((r) => r.recommendedTreatment).length,
        pestObservations: observationRows.filter((o) => o.severity !== 'none').length,
      },
      greenhouses: rows,
    };
  },
};
