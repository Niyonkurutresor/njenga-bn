import { and, asc, desc, eq, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  farmReportEntries,
  farmReports,
  greenhouses,
  harvests,
  inspections,
  users,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { today } from '../../common/utils/dates.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { summariseHarvests } from './farm.calc.js';
import { latestObservations, openCaseCounts } from './farm.shared.js';
import type {
  CreateGreenhouseInput,
  GreenhouseListQuery,
  UpdateGreenhouseInput,
} from './farm.schema.js';

const HISTORY_LIMIT = 200;

const SORTS = {
  name: greenhouses.name,
  createdAt: greenhouses.createdAt,
  plantingDate: greenhouses.plantingDate,
} as const;

async function assertNameFree(name: string, exceptId?: number) {
  const [clash] = await db
    .select({ id: greenhouses.id, deletedAt: greenhouses.deletedAt })
    .from(greenhouses)
    .where(and(eq(greenhouses.name, name), exceptId ? ne(greenhouses.id, exceptId) : undefined));
  if (clash) {
    throw AppError.conflict(
      clash.deletedAt
        ? `A deleted greenhouse is already named "${name}" — choose another name`
        : `A greenhouse named "${name}" already exists`,
    );
  }
}

async function findLive(id: number) {
  const [row] = await db
    .select()
    .from(greenhouses)
    .where(and(eq(greenhouses.id, id), isNull(greenhouses.deletedAt)));
  if (!row) throw AppError.notFound('Greenhouse');
  return row;
}

export const greenhouseService = {
  /** Contract for `useGreenhouseOptions`: active plots only. */
  async options() {
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
  },

  /** Register with latest crop health and open disease cases (FR-FRM-01). */
  async list(query: GreenhouseListQuery) {
    const filters: SQL[] = [isNull(greenhouses.deletedAt)];
    if (query.status) filters.push(eq(greenhouses.status, query.status));
    if (query.kind) filters.push(eq(greenhouses.kind, query.kind));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(greenhouses.name, term), like(greenhouses.currentCrop, term))!);
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'name'];
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select()
        .from(greenhouses)
        .where(where)
        .orderBy(query.sortDir === 'desc' ? desc(sortCol) : asc(sortCol), asc(greenhouses.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(greenhouses)
        .where(where),
    ]);
    const ids = rows.map((r) => r.id);
    const [latest, cases] = await Promise.all([
      latestObservations(ids, today()),
      openCaseCounts(ids),
    ]);
    const data = rows.map(({ deletedAt: _d, ...g }) => ({
      ...g,
      latest: latest.get(g.id) ?? null,
      openCases: cases.get(g.id)?.open ?? 0,
      openHighCases: cases.get(g.id)?.high ?? 0,
    }));
    return paginated(data, Number(total), query);
  },

  /** Greenhouse with its full history: inspections & treatments, observations, harvests (FR-FRM-08). */
  async get(id: number) {
    const { deletedAt: _d, ...g } = await findLive(id);
    const [inspectionRows, observationRows, harvestRows, latest, cases] = await Promise.all([
      db
        .select({
          id: inspections.id,
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
        .where(and(eq(inspections.greenhouseId, id), isNull(inspections.deletedAt)))
        .orderBy(desc(inspections.inspectionDate), desc(inspections.id))
        .limit(HISTORY_LIMIT),
      db
        .select({
          id: farmReportEntries.id,
          reportId: farmReports.id,
          reportDate: farmReports.reportDate,
          greenhouseStatus: farmReportEntries.greenhouseStatus,
          cropHealth: farmReportEntries.cropHealth,
          irrigationDone: farmReportEntries.irrigationDone,
          pestsObserved: farmReportEntries.pestsObserved,
          severity: farmReportEntries.severity,
        })
        .from(farmReportEntries)
        .innerJoin(farmReports, eq(farmReports.id, farmReportEntries.reportId))
        .where(eq(farmReportEntries.greenhouseId, id))
        .orderBy(desc(farmReports.reportDate))
        .limit(HISTORY_LIMIT),
      db
        .select({
          id: harvests.id,
          crop: harvests.crop,
          quantity: harvests.quantity,
          unit: harvests.unit,
          grade: harvests.grade,
          harvestDate: harvests.harvestDate,
          notes: harvests.notes,
          recordedBy: { id: users.id, name: users.name },
        })
        .from(harvests)
        .innerJoin(users, eq(users.id, harvests.recordedBy))
        .where(and(eq(harvests.greenhouseId, id), isNull(harvests.deletedAt)))
        .orderBy(desc(harvests.harvestDate), desc(harvests.id))
        .limit(HISTORY_LIMIT),
      latestObservations([id], today()),
      openCaseCounts([id]),
    ]);
    const harvestTotals = summariseHarvests(
      harvestRows.map((h) => ({
        crop: h.crop,
        greenhouseId: id,
        greenhouseName: g.name,
        month: h.harvestDate.slice(0, 7),
        unit: h.unit,
        grade: h.grade,
        quantity: h.quantity,
      })),
    );
    return {
      ...g,
      latest: latest.get(id) ?? null,
      openCases: cases.get(id)?.open ?? 0,
      openHighCases: cases.get(id)?.high ?? 0,
      inspections: inspectionRows,
      observations: observationRows,
      harvests: harvestRows,
      harvestTotals: { totals: harvestTotals.totals, byCrop: harvestTotals.byCrop },
    };
  },

  async create(_user: AuthUser, input: CreateGreenhouseInput) {
    await assertNameFree(input.name);
    const id = await db.transaction(async (tx) => {
      const [res] = await tx.insert(greenhouses).values({
        name: input.name,
        kind: input.kind,
        sizeSqm: input.sizeSqm ?? null,
        currentCrop: input.currentCrop ?? null,
        plantingDate: input.plantingDate ?? null,
        status: input.status,
        notes: input.notes ?? null,
      });
      await auditService.log(
        { action: 'create', entityType: 'greenhouse', entityId: res.insertId, newValues: input },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(_user: AuthUser, id: number, input: UpdateGreenhouseInput) {
    const row = await findLive(id);
    if (input.name && input.name !== row.name) await assertNameFree(input.name, id);
    const changes = diff(row, input);
    if (changes) {
      await db.transaction(async (tx) => {
        await tx.update(greenhouses).set(changes.newValues).where(eq(greenhouses.id, id));
        await auditService.log(
          { action: 'update', entityType: 'greenhouse', entityId: id, ...changes },
          tx,
        );
      });
    }
    return this.get(id);
  },

  /** Soft delete (BRL-10); history stays linked to the record. */
  async remove(_user: AuthUser, id: number) {
    await findLive(id);
    await db.transaction(async (tx) => {
      const deletedAt = new Date();
      await tx.update(greenhouses).set({ deletedAt }).where(eq(greenhouses.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'greenhouse', entityId: id, newValues: { deletedAt } },
        tx,
      );
    });
  },
};
