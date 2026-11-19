import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { farmReportEntries, farmReports, greenhouses, inspections } from '../../db/schema/index.js';
import type { CropHealth, ObservationSeverity } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { addDays } from '../../common/utils/dates.js';

/** How far back "latest crop health" looks; older observations are treated as unknown. */
const LATEST_WINDOW_DAYS = 90;

export interface LatestObservation {
  reportDate: string;
  cropHealth: CropHealth;
  severity: ObservationSeverity;
  greenhouseStatus: string | null;
  pestsObserved: string | null;
}

/** Most recent daily-report observation per greenhouse, on or before `asOf`. */
export async function latestObservations(
  greenhouseIds: readonly number[],
  asOf: string,
  tx: Executor = db,
): Promise<Map<number, LatestObservation>> {
  const out = new Map<number, LatestObservation>();
  if (!greenhouseIds.length) return out;
  const rows = await tx
    .select({
      greenhouseId: farmReportEntries.greenhouseId,
      reportDate: farmReports.reportDate,
      cropHealth: farmReportEntries.cropHealth,
      severity: farmReportEntries.severity,
      greenhouseStatus: farmReportEntries.greenhouseStatus,
      pestsObserved: farmReportEntries.pestsObserved,
    })
    .from(farmReportEntries)
    .innerJoin(farmReports, eq(farmReports.id, farmReportEntries.reportId))
    .where(
      and(
        inArray(farmReportEntries.greenhouseId, [...greenhouseIds]),
        lte(farmReports.reportDate, asOf),
        gte(farmReports.reportDate, addDays(asOf, -LATEST_WINDOW_DAYS)),
      ),
    )
    .orderBy(desc(farmReports.reportDate));
  for (const { greenhouseId, ...obs } of rows) {
    if (!out.has(greenhouseId)) out.set(greenhouseId, obs);
  }
  return out;
}

/** Open disease/pest cases (severity above none, not closed) per greenhouse. */
export async function openCaseCounts(
  greenhouseIds: readonly number[],
  tx: Executor = db,
): Promise<Map<number, { open: number; high: number }>> {
  const out = new Map<number, { open: number; high: number }>();
  if (!greenhouseIds.length) return out;
  const rows = await tx
    .select({
      greenhouseId: inspections.greenhouseId,
      open: sql<number>`count(*)`,
      high: sql<number>`sum(case when ${inspections.severity} = 'high' then 1 else 0 end)`,
    })
    .from(inspections)
    .where(
      and(
        inArray(inspections.greenhouseId, [...greenhouseIds]),
        isNull(inspections.deletedAt),
        ne(inspections.status, 'closed'),
        ne(inspections.severity, 'none'),
      ),
    )
    .groupBy(inspections.greenhouseId);
  for (const r of rows)
    out.set(r.greenhouseId, { open: Number(r.open), high: Number(r.high ?? 0) });
  return out;
}

/** Loads a live (not deleted) greenhouse or fails with a business-rule error. */
export async function requireGreenhouse(tx: Executor, id: number) {
  const [row] = await tx
    .select()
    .from(greenhouses)
    .where(and(eq(greenhouses.id, id), isNull(greenhouses.deletedAt)));
  if (!row) throw AppError.rule('Greenhouse does not exist');
  return row;
}

export function assertNotFuture(date: string, today: string, what: string) {
  if (date > today) throw AppError.rule(`${what} cannot be in the future`);
}
