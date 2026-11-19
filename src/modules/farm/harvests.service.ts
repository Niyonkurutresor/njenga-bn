import { and, asc, desc, eq, gte, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { greenhouses, harvests, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { today } from '../../common/utils/dates.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { summariseHarvests } from './farm.calc.js';
import { assertNotFuture, requireGreenhouse } from './farm.shared.js';
import type {
  CreateHarvestInput,
  HarvestListQuery,
  HarvestSummaryQuery,
  UpdateHarvestInput,
} from './farm.schema.js';

const columns = {
  id: harvests.id,
  greenhouseId: harvests.greenhouseId,
  crop: harvests.crop,
  quantity: harvests.quantity,
  unit: harvests.unit,
  grade: harvests.grade,
  harvestDate: harvests.harvestDate,
  notes: harvests.notes,
  createdAt: harvests.createdAt,
  updatedAt: harvests.updatedAt,
  greenhouse: { id: greenhouses.id, name: greenhouses.name, kind: greenhouses.kind },
  recordedBy: { id: users.id, name: users.name },
};

const SORTS = {
  harvestDate: harvests.harvestDate,
  quantity: harvests.quantity,
  createdAt: harvests.createdAt,
} as const;

async function findLive(id: number) {
  const [row] = await db
    .select()
    .from(harvests)
    .where(and(eq(harvests.id, id), isNull(harvests.deletedAt)));
  if (!row) throw AppError.notFound('Harvest');
  return row;
}

export const harvestService = {
  /** Harvest records with filters (FR-FRM-03). */
  async list(query: HarvestListQuery) {
    const filters: SQL[] = [isNull(harvests.deletedAt)];
    if (query.greenhouseId) filters.push(eq(harvests.greenhouseId, query.greenhouseId));
    if (query.crop) filters.push(eq(harvests.crop, query.crop));
    if (query.unit) filters.push(eq(harvests.unit, query.unit));
    if (query.grade) filters.push(eq(harvests.grade, query.grade));
    if (query.from) filters.push(gte(harvests.harvestDate, query.from));
    if (query.to) filters.push(lte(harvests.harvestDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(harvests.crop, term), like(greenhouses.name, term), like(harvests.notes, term))!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'harvestDate'];
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(columns)
        .from(harvests)
        .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
        .innerJoin(users, eq(users.id, harvests.recordedBy))
        .where(where)
        .orderBy(query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol), desc(harvests.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(harvests)
        .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async get(id: number) {
    const [row] = await db
      .select(columns)
      .from(harvests)
      .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
      .innerJoin(users, eq(users.id, harvests.recordedBy))
      .where(and(eq(harvests.id, id), isNull(harvests.deletedAt)));
    if (!row) throw AppError.notFound('Harvest');
    return row;
  },

  /** Distinct crops ever harvested (filter options). */
  async crops() {
    const rows = await db
      .selectDistinct({ crop: harvests.crop })
      .from(harvests)
      .where(isNull(harvests.deletedAt))
      .orderBy(asc(harvests.crop));
    return rows.map((r) => r.crop);
  },

  /** Totals by crop, greenhouse and month; kg and units separately, by grade (FR-FRM-09). */
  async summary(query: HarvestSummaryQuery) {
    const filters: SQL[] = [isNull(harvests.deletedAt)];
    if (query.from) filters.push(gte(harvests.harvestDate, query.from));
    if (query.to) filters.push(lte(harvests.harvestDate, query.to));
    if (query.greenhouseId) filters.push(eq(harvests.greenhouseId, query.greenhouseId));
    const month = sql<string>`date_format(${harvests.harvestDate}, '%Y-%m')`;
    const rows = await db
      .select({
        crop: harvests.crop,
        greenhouseId: harvests.greenhouseId,
        greenhouseName: greenhouses.name,
        month,
        unit: harvests.unit,
        grade: harvests.grade,
        quantity: sql<string>`sum(${harvests.quantity})`,
      })
      .from(harvests)
      .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
      .where(and(...filters))
      .groupBy(
        harvests.crop,
        harvests.greenhouseId,
        greenhouses.name,
        month,
        harvests.unit,
        harvests.grade,
      );
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      ...summariseHarvests(rows.map((r) => ({ ...r, quantity: Number(r.quantity) }))),
    };
  },

  async create(user: AuthUser, input: CreateHarvestInput) {
    assertNotFuture(input.harvestDate, today(), 'The harvest date');
    const id = await db.transaction(async (tx) => {
      const gh = await requireGreenhouse(tx, input.greenhouseId);
      const crop = input.crop ?? gh.currentCrop;
      if (!crop) throw AppError.rule('Enter the crop harvested');
      const values = {
        greenhouseId: input.greenhouseId,
        crop,
        quantity: input.quantity,
        unit: input.unit,
        grade: input.grade,
        harvestDate: input.harvestDate,
        notes: input.notes ?? null,
        recordedBy: user.id,
      };
      const [res] = await tx.insert(harvests).values(values);
      await auditService.log(
        { action: 'create', entityType: 'harvest', entityId: res.insertId, newValues: values },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(_user: AuthUser, id: number, input: UpdateHarvestInput) {
    const row = await findLive(id);
    if (input.harvestDate) assertNotFuture(input.harvestDate, today(), 'The harvest date');
    const changes = diff(row, input);
    if (changes) {
      await db.transaction(async (tx) => {
        if (input.greenhouseId && input.greenhouseId !== row.greenhouseId)
          await requireGreenhouse(tx, input.greenhouseId);
        await tx.update(harvests).set(changes.newValues).where(eq(harvests.id, id));
        await auditService.log(
          { action: 'update', entityType: 'harvest', entityId: id, ...changes },
          tx,
        );
      });
    }
    return this.get(id);
  },

  async remove(_user: AuthUser, id: number) {
    const row = await findLive(id);
    await db.transaction(async (tx) => {
      const deletedAt = new Date();
      await tx.update(harvests).set({ deletedAt }).where(eq(harvests.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'harvest',
          entityId: id,
          oldValues: { crop: row.crop, quantity: row.quantity, unit: row.unit },
          newValues: { deletedAt },
        },
        tx,
      );
    });
  },
};
