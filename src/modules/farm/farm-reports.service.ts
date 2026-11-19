import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { outerColumn } from '../../common/utils/sql.js';
import { db, type Executor } from '../../db/client.js';
import { farmReportEntries, farmReports, greenhouses, users } from '../../db/schema/index.js';
import type { ObservationSeverity } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { becameHigh, healthCounts, worstSeverity } from './farm.calc.js';
import { agronomistIds, directorIds, farmManagerIds } from './farm.recipients.js';
import { assertNotFuture } from './farm.shared.js';
import type { ReportListQuery, SubmitFarmReportInput } from './farm.schema.js';

const headerColumns = {
  id: farmReports.id,
  reportDate: farmReports.reportDate,
  irrigationNotes: farmReports.irrigationNotes,
  visitors: farmReports.visitors,
  equipmentCondition: farmReports.equipmentCondition,
  generalNotes: farmReports.generalNotes,
  clientRef: farmReports.clientRef,
  createdAt: farmReports.createdAt,
  updatedAt: farmReports.updatedAt,
  submittedBy: { id: users.id, name: users.name },
};

const reportLink = (date: string) => `/farm/reports/daily?date=${date}`;

async function entriesOf(reportId: number, tx: Executor = db) {
  return tx
    .select({
      greenhouse: {
        id: greenhouses.id,
        name: greenhouses.name,
        kind: greenhouses.kind,
        currentCrop: greenhouses.currentCrop,
      },
      greenhouseStatus: farmReportEntries.greenhouseStatus,
      cropHealth: farmReportEntries.cropHealth,
      irrigationDone: farmReportEntries.irrigationDone,
      pestsObserved: farmReportEntries.pestsObserved,
      severity: farmReportEntries.severity,
    })
    .from(farmReportEntries)
    .innerJoin(greenhouses, eq(greenhouses.id, farmReportEntries.greenhouseId))
    .where(eq(farmReportEntries.reportId, reportId))
    .orderBy(asc(greenhouses.name));
}

async function activeGreenhouses() {
  return db
    .select({
      id: greenhouses.id,
      name: greenhouses.name,
      kind: greenhouses.kind,
      currentCrop: greenhouses.currentCrop,
    })
    .from(greenhouses)
    .where(and(isNull(greenhouses.deletedAt), eq(greenhouses.status, 'active')))
    .orderBy(asc(greenhouses.name));
}

/** FR-FRM-07 / US-FM-002: high-severity pests or disease alert the Agronomist, Farm Managers and Directors. */
async function alertHighSeverity(
  tx: Executor,
  user: AuthUser,
  reportId: number,
  reportDate: string,
  high: { name: string; pestsObserved: string | null | undefined }[],
) {
  if (!high.length) return;
  const [agro, managers, directors] = await Promise.all([
    agronomistIds(tx),
    farmManagerIds(tx),
    directorIds(tx),
  ]);
  const names = high.map((h) => h.name).join(', ');
  const detail = high
    .map((h) => (h.pestsObserved ? `${h.name}: ${h.pestsObserved}` : h.name))
    .join('; ');
  await notificationService.notify(
    {
      userIds: [...agro, ...managers, ...directors],
      excludeUserId: user.id,
      type: 'farm.high_severity',
      title: `High-severity pests/disease reported: ${names}`.slice(0, 200),
      body: `Daily farm report ${reportDate} by ${user.name}. ${detail}`.slice(0, 2000),
      link: reportLink(reportDate),
      entityType: 'farm_report',
      entityId: reportId,
      email: true,
      sms: true,
      critical: true,
    },
    tx,
  );
}

export const farmReportService = {
  async getById(id: number) {
    const [header] = await db
      .select(headerColumns)
      .from(farmReports)
      .innerJoin(users, eq(users.id, farmReports.submittedBy))
      .where(eq(farmReports.id, id));
    if (!header) throw AppError.notFound('Farm report');
    const entries = await entriesOf(id);
    return {
      ...header,
      submitted: true as const,
      summary: {
        health: healthCounts(entries.map((e) => e.cropHealth)),
        worstSeverity: worstSeverity(entries.map((e) => e.severity)),
        irrigated: entries.filter((e) => e.irrigationDone).length,
      },
      entries,
    };
  },

  /**
   * The report for a date (US-FM-001): the submitted one, with any active greenhouse it does not
   * cover appended, or a blank template listing every active greenhouse.
   */
  async daily(date: string = today()) {
    const [existing] = await db
      .select({ id: farmReports.id })
      .from(farmReports)
      .where(eq(farmReports.reportDate, date));
    const active = await activeGreenhouses();
    const blank = (g: (typeof active)[number]) => ({
      greenhouse: g,
      greenhouseStatus: null,
      cropHealth: 'good' as const,
      irrigationDone: false,
      pestsObserved: null,
      severity: 'none' as const,
    });
    if (!existing) {
      return {
        id: null,
        reportDate: date,
        submitted: false as const,
        irrigationNotes: null,
        visitors: null,
        equipmentCondition: null,
        generalNotes: null,
        clientRef: null,
        createdAt: null,
        updatedAt: null,
        submittedBy: null,
        summary: null,
        entries: active.map(blank),
      };
    }
    const report = await this.getById(existing.id);
    const covered = new Set(report.entries.map((e) => e.greenhouse.id));
    return {
      ...report,
      entries: [...report.entries, ...active.filter((g) => !covered.has(g.id)).map(blank)],
    };
  },

  /** Reports for a date range, newest first (Daily farm report, BRD section 6). */
  async list(query: ReportListQuery) {
    const filters: SQL[] = [];
    if (query.from) filters.push(gte(farmReports.reportDate, query.from));
    if (query.to) filters.push(lte(farmReports.reportDate, query.to));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          ...headerColumns,
          entryCount: sql<number>`(select count(*) from ${farmReportEntries} e where e.report_id = ${outerColumn(farmReports.id)})`,
          poorCount: sql<number>`(select count(*) from ${farmReportEntries} e where e.report_id = ${outerColumn(farmReports.id)} and e.crop_health = 'poor')`,
          highCount: sql<number>`(select count(*) from ${farmReportEntries} e where e.report_id = ${outerColumn(farmReports.id)} and e.severity = 'high')`,
        })
        .from(farmReports)
        .innerJoin(users, eq(users.id, farmReports.submittedBy))
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(farmReports.reportDate) : desc(farmReports.reportDate),
        )
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(farmReports)
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({
        ...r,
        entryCount: Number(r.entryCount),
        poorCount: Number(r.poorCount),
        highCount: Number(r.highCount),
      })),
      Number(total),
      query,
    );
  },

  /**
   * Submits (or updates) the daily report for a date (FR-FRM-02, US-FM-001). Idempotent for
   * offline retries: a `clientRef` already stored returns that report unchanged (NFR-10).
   */
  async submit(user: AuthUser, input: SubmitFarmReportInput) {
    const reportDate = input.reportDate ?? today();
    assertNotFuture(reportDate, today(), 'The report date');

    if (input.clientRef) {
      const [dup] = await db
        .select({ id: farmReports.id })
        .from(farmReports)
        .where(eq(farmReports.clientRef, input.clientRef));
      if (dup) return this.getById(dup.id);
    }

    const ids = input.entries.map((e) => e.greenhouseId);
    const known = await db
      .select({ id: greenhouses.id, name: greenhouses.name })
      .from(greenhouses)
      .where(and(inArray(greenhouses.id, ids), isNull(greenhouses.deletedAt)));
    if (known.length !== ids.length) throw AppError.rule('One of the greenhouses does not exist');
    const nameOf = new Map(known.map((g) => [g.id, g.name]));

    const header = {
      irrigationNotes: input.irrigationNotes ?? null,
      visitors: input.visitors ?? null,
      equipmentCondition: input.equipmentCondition ?? null,
      generalNotes: input.generalNotes ?? null,
    };

    const reportId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(farmReports)
        .where(eq(farmReports.reportDate, reportDate))
        .for('update');

      let id: number;
      const previous = new Map<number, ObservationSeverity>();
      if (existing) {
        id = existing.id;
        const before = await tx
          .select({
            greenhouseId: farmReportEntries.greenhouseId,
            severity: farmReportEntries.severity,
          })
          .from(farmReportEntries)
          .where(eq(farmReportEntries.reportId, id));
        for (const b of before) previous.set(b.greenhouseId, b.severity);
        await tx
          .update(farmReports)
          .set({ ...header, ...(input.clientRef ? { clientRef: input.clientRef } : {}) })
          .where(eq(farmReports.id, id));
      } else {
        const [res] = await tx.insert(farmReports).values({
          reportDate,
          submittedBy: user.id,
          clientRef: input.clientRef ?? null,
          ...header,
        });
        id = res.insertId;
      }

      await tx
        .insert(farmReportEntries)
        .values(
          input.entries.map((e) => ({
            reportId: id,
            greenhouseId: e.greenhouseId,
            greenhouseStatus: e.greenhouseStatus ?? null,
            cropHealth: e.cropHealth,
            irrigationDone: e.irrigationDone,
            pestsObserved: e.pestsObserved ?? null,
            severity: e.severity,
          })),
        )
        .onDuplicateKeyUpdate({
          set: {
            greenhouseStatus: sql`values(${farmReportEntries.greenhouseStatus})`,
            cropHealth: sql`values(${farmReportEntries.cropHealth})`,
            irrigationDone: sql`values(${farmReportEntries.irrigationDone})`,
            pestsObserved: sql`values(${farmReportEntries.pestsObserved})`,
            severity: sql`values(${farmReportEntries.severity})`,
          },
        });

      await auditService.log(
        {
          action: existing ? 'update' : 'submit',
          entityType: 'farm_report',
          entityId: id,
          oldValues: existing
            ? {
                irrigationNotes: existing.irrigationNotes,
                visitors: existing.visitors,
                equipmentCondition: existing.equipmentCondition,
                generalNotes: existing.generalNotes,
                severities: Object.fromEntries(previous),
              }
            : null,
          newValues: { reportDate, ...header, entries: input.entries },
        },
        tx,
      );

      const high = input.entries
        .filter((e) => becameHigh(previous.get(e.greenhouseId), e.severity))
        .map((e) => ({
          name: nameOf.get(e.greenhouseId) ?? `#${e.greenhouseId}`,
          pestsObserved: e.pestsObserved,
        }));
      await alertHighSeverity(tx, user, id, reportDate, high);
      return id;
    });
    return this.getById(reportId);
  },

  /** Whether a report exists for the date (reminder job, overview). */
  async isSubmitted(date: string, tx: Executor = db): Promise<boolean> {
    const [row] = await tx
      .select({ id: farmReports.id })
      .from(farmReports)
      .where(eq(farmReports.reportDate, date));
    return Boolean(row);
  },
};
