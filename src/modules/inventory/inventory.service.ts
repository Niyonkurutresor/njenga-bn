import { and, asc, desc, eq, gte, isNull, like, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { categories, materials, projects, stockMovements, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { round2, toNumber } from '../../common/utils/money.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { recordTransaction } from '../finance/ledger.js';
import { notificationService } from '../notifications/notifications.service.js';
import {
  addQuantity,
  isLowStock,
  issueCost,
  lowStockAction,
  weightedAverageCost,
} from './inventory.calc.js';
import type {
  AdjustInput,
  CreateMaterialInput,
  IssueInput,
  MaterialListQuery,
  MovementListQuery,
  ReceiveInput,
  UpdateMaterialInput,
} from './inventory.schema.js';

type MaterialRow = typeof materials.$inferSelect;

const link = (id: number) => `/inventory/materials/${id}`;

const lowStockSql = sql<number>`(${materials.reorderLevel} > 0 AND ${materials.quantityOnHand} < ${materials.reorderLevel})`;

const materialColumns = {
  id: materials.id,
  name: materials.name,
  sku: materials.sku,
  unit: materials.unit,
  quantityOnHand: materials.quantityOnHand,
  reorderLevel: materials.reorderLevel,
  averageUnitCost: materials.averageUnitCost,
  lowStockNotifiedAt: materials.lowStockNotifiedAt,
  createdAt: materials.createdAt,
  updatedAt: materials.updatedAt,
};

function withFlags<
  T extends { quantityOnHand: number; reorderLevel: number; averageUnitCost: number },
>(m: T) {
  return {
    ...m,
    isLowStock: isLowStock(m.quantityOnHand, m.reorderLevel),
    isOutOfStock: m.quantityOnHand <= 0,
    stockValue: round2(m.quantityOnHand * m.averageUnitCost),
  };
}

async function lockMaterial(tx: Executor, id: number): Promise<MaterialRow> {
  const [row] = await tx
    .select()
    .from(materials)
    .where(and(eq(materials.id, id), isNull(materials.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Material');
  return row;
}

async function assertSkuFree(tx: Executor, sku: string | null | undefined, exceptId?: number) {
  if (!sku) return;
  const [dup] = await tx
    .select({ id: materials.id })
    .from(materials)
    .where(and(eq(materials.sku, sku), exceptId ? ne(materials.id, exceptId) : undefined));
  if (dup) throw AppError.conflict(`SKU "${sku}" is already used by another material`);
}

async function categoryId(tx: Executor, name: string): Promise<number | null> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.kind, 'expense')));
  return row?.id ?? null;
}

function assertNotFuture(date: string) {
  if (date > today()) throw AppError.rule('The movement date cannot be in the future');
}

/**
 * FR-INV-04: after a change, alert stock managers once when a material drops below its
 * reorder level, and re-arm the alert once it is back above.
 */
async function syncLowStock(tx: Executor, m: MaterialRow, quantityOnHand: number) {
  const action = lowStockAction(quantityOnHand, m.reorderLevel, m.lowStockNotifiedAt);
  if (action === 'clear') {
    await tx.update(materials).set({ lowStockNotifiedAt: null }).where(eq(materials.id, m.id));
  } else if (action === 'notify') {
    await tx
      .update(materials)
      .set({ lowStockNotifiedAt: new Date() })
      .where(eq(materials.id, m.id));
    await notificationService.notify(
      {
        userIds: await notificationService.userIdsWithPermission(P.INVENTORY_MANAGE, tx),
        type: 'inventory.low_stock',
        title: `Low stock: ${m.name}`,
        body: `${quantityOnHand} ${m.unit} left (reorder level ${m.reorderLevel} ${m.unit})`,
        link: link(m.id),
        entityType: 'material',
        entityId: m.id,
        email: true,
      },
      tx,
    );
  }
}

export const inventoryService = {
  async list(query: MaterialListQuery) {
    const filters: SQL[] = [isNull(materials.deletedAt)];
    if (query.lowStock) filters.push(sql`${lowStockSql}`);
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(materials.name, term), like(materials.sku, term))!);
    }
    const where = and(...filters);
    const sortCol =
      query.sortBy === 'quantityOnHand'
        ? materials.quantityOnHand
        : query.sortBy === 'updatedAt'
          ? materials.updatedAt
          : materials.name;
    const dir = query.sortBy ? query.sortDir : 'asc';
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(materialColumns)
        .from(materials)
        .where(where)
        // Low-stock items first so they are not missed.
        .orderBy(desc(lowStockSql), dir === 'asc' ? asc(sortCol) : desc(sortCol))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(materials)
        .where(where),
    ]);
    return paginated(rows.map(withFlags), Number(total), query);
  },

  async options() {
    const rows = await db
      .select({
        id: materials.id,
        name: materials.name,
        unit: materials.unit,
        quantityOnHand: materials.quantityOnHand,
      })
      .from(materials)
      .where(isNull(materials.deletedAt))
      .orderBy(asc(materials.name));
    return rows;
  },

  /** Counts for the inventory header and Ops dashboard (procurement widget). */
  async summary() {
    const [row] = await db
      .select({
        materials: sql<number>`count(*)`,
        lowStock: sql<number>`SUM(CASE WHEN ${lowStockSql} THEN 1 ELSE 0 END)`,
        outOfStock: sql<number>`SUM(CASE WHEN ${materials.quantityOnHand} <= 0 THEN 1 ELSE 0 END)`,
        stockValue: sql<string>`COALESCE(SUM(${materials.quantityOnHand} * ${materials.averageUnitCost}), 0)`,
      })
      .from(materials)
      .where(isNull(materials.deletedAt));
    return {
      materials: Number(row?.materials ?? 0),
      lowStock: Number(row?.lowStock ?? 0),
      outOfStock: Number(row?.outOfStock ?? 0),
      stockValue: round2(toNumber(row?.stockValue)),
    };
  },

  async get(id: number) {
    const [row] = await db
      .select(materialColumns)
      .from(materials)
      .where(and(eq(materials.id, id), isNull(materials.deletedAt)));
    if (!row) throw AppError.notFound('Material');
    return withFlags(row);
  },

  async create(input: CreateMaterialInput) {
    const id = await db.transaction(async (tx) => {
      await assertSkuFree(tx, input.sku);
      const [res] = await tx.insert(materials).values({
        name: input.name,
        sku: input.sku ?? null,
        unit: input.unit,
        reorderLevel: input.reorderLevel ?? 0,
      });
      await auditService.log(
        { action: 'create', entityType: 'material', entityId: res.insertId, newValues: input },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateMaterialInput) {
    await db.transaction(async (tx) => {
      const row = await lockMaterial(tx, id);
      if (input.sku !== undefined && input.sku !== row.sku) await assertSkuFree(tx, input.sku, id);
      const changes = diff(row, input as Partial<MaterialRow>);
      if (!changes) return;
      await tx
        .update(materials)
        .set(input as Partial<MaterialRow>)
        .where(eq(materials.id, id));
      await auditService.log(
        { action: 'update', entityType: 'material', entityId: id, ...changes },
        tx,
      );
      if (input.reorderLevel !== undefined) {
        await syncLowStock(tx, { ...row, ...input } as MaterialRow, row.quantityOnHand);
      }
    });
    return this.get(id);
  },

  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockMaterial(tx, id);
      if (row.quantityOnHand > 0) {
        throw AppError.rule('Issue or adjust the remaining stock before deleting this material');
      }
      await tx.update(materials).set({ deletedAt: new Date() }).where(eq(materials.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'material', entityId: id, oldValues: { name: row.name } },
        tx,
      );
    });
  },

  async movements(query: MovementListQuery) {
    const filters: SQL[] = [];
    if (query.materialId) filters.push(eq(stockMovements.materialId, query.materialId));
    if (query.type) filters.push(eq(stockMovements.type, query.type));
    if (query.projectId) filters.push(eq(stockMovements.projectId, query.projectId));
    if (query.costCentreType) filters.push(eq(stockMovements.costCentreType, query.costCentreType));
    if (query.from) filters.push(gte(stockMovements.movementDate, query.from));
    if (query.to) filters.push(lte(stockMovements.movementDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(materials.name, term),
          like(stockMovements.supplier, term),
          like(stockMovements.shipmentReference, term),
          like(stockMovements.notes, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          id: stockMovements.id,
          type: stockMovements.type,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
          totalCost: stockMovements.totalCost,
          supplier: stockMovements.supplier,
          isImported: stockMovements.isImported,
          shipmentReference: stockMovements.shipmentReference,
          costCentreType: stockMovements.costCentreType,
          movementDate: stockMovements.movementDate,
          notes: stockMovements.notes,
          transactionId: stockMovements.transactionId,
          createdAt: stockMovements.createdAt,
          material: { id: materials.id, name: materials.name, unit: materials.unit },
          project: { id: projects.id, code: projects.code, name: projects.name },
          performedBy: { id: users.id, name: users.name },
        })
        .from(stockMovements)
        .innerJoin(materials, eq(materials.id, stockMovements.materialId))
        .innerJoin(users, eq(users.id, stockMovements.performedBy))
        .leftJoin(projects, eq(projects.id, stockMovements.projectId))
        .where(where)
        .orderBy(
          query.sortDir === 'asc'
            ? asc(stockMovements.movementDate)
            : desc(stockMovements.movementDate),
          desc(stockMovements.id),
        )
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(stockMovements)
        .innerJoin(materials, eq(materials.id, stockMovements.materialId))
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  /**
   * FR-INV-02: receive stock, update quantity and weighted average cost; the purchase is
   * a cash outflow on the office ledger that does not hit P&L until the stock is issued.
   */
  async receive(user: AuthUser, id: number, input: ReceiveInput) {
    assertNotFuture(input.movementDate);
    await db.transaction(async (tx) => {
      const m = await lockMaterial(tx, id);
      const totalCost = round2(input.quantity * input.unitCost);
      const quantityOnHand = addQuantity(m.quantityOnHand, input.quantity);
      const averageUnitCost = weightedAverageCost(
        m.quantityOnHand,
        m.averageUnitCost,
        input.quantity,
        input.unitCost,
      );
      const [res] = await tx.insert(stockMovements).values({
        materialId: id,
        type: 'receipt',
        quantity: input.quantity,
        unitCost: input.unitCost,
        totalCost,
        supplier: input.supplier ?? null,
        isImported: input.isImported,
        shipmentReference: input.shipmentReference ?? null,
        movementDate: input.movementDate,
        notes: input.notes ?? null,
        performedBy: user.id,
      });
      const movementId = res.insertId;
      if (totalCost > 0) {
        const transactionId = await recordTransaction(tx, {
          direction: 'out',
          transactionDate: input.movementDate,
          amount: totalCost,
          categoryId: await categoryId(tx, 'Inventory purchase'),
          costCentreType: 'office',
          paymentMethod: input.paymentMethod ?? null,
          description:
            `Stock received: ${input.quantity} ${m.unit} ${m.name}` +
            (input.supplier ? ` from ${input.supplier}` : '') +
            (input.shipmentReference ? ` (shipment ${input.shipmentReference})` : ''),
          source: 'stock_purchase',
          sourceId: movementId,
          affectsPnl: false,
          recordedBy: user.id,
        });
        await tx
          .update(stockMovements)
          .set({ transactionId })
          .where(eq(stockMovements.id, movementId));
      }
      await tx
        .update(materials)
        .set({ quantityOnHand, averageUnitCost })
        .where(eq(materials.id, id));
      await auditService.log(
        {
          action: 'stock_receive',
          entityType: 'material',
          entityId: id,
          oldValues: { quantityOnHand: m.quantityOnHand, averageUnitCost: m.averageUnitCost },
          newValues: { quantityOnHand, averageUnitCost, movementId, ...input },
        },
        tx,
      );
      await syncLowStock(tx, m, quantityOnHand);
    });
    return this.get(id);
  },

  /** FR-INV-02/03: issue to a project or the farm and post the cost there. */
  async issue(user: AuthUser, id: number, input: IssueInput) {
    assertNotFuture(input.movementDate);
    await db.transaction(async (tx) => {
      const m = await lockMaterial(tx, id);
      if (input.quantity > m.quantityOnHand) {
        throw AppError.rule(
          `Only ${m.quantityOnHand} ${m.unit} of ${m.name} in stock; cannot issue ${input.quantity}`,
        );
      }
      const projectId = input.costCentreType === 'project' ? (input.projectId ?? null) : null;
      let projectLabel = 'the farm';
      if (projectId) {
        const [p] = await tx
          .select({ status: projects.status, code: projects.code })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
        if (!p) throw AppError.rule('Project does not exist');
        if (p.status === 'closed') {
          throw AppError.rule('Materials cannot be issued to a closed project');
        }
        projectLabel = p.code;
      }
      const totalCost = issueCost(m.averageUnitCost, input.quantity);
      const quantityOnHand = addQuantity(m.quantityOnHand, -input.quantity);
      const [res] = await tx.insert(stockMovements).values({
        materialId: id,
        type: 'issue',
        quantity: -input.quantity,
        unitCost: m.averageUnitCost,
        totalCost,
        costCentreType: input.costCentreType,
        projectId,
        movementDate: input.movementDate,
        notes: input.notes ?? null,
        performedBy: user.id,
      });
      const movementId = res.insertId;
      if (totalCost > 0) {
        // Non-cash cost: the cash left when the stock was bought (FR-INV-03).
        const transactionId = await recordTransaction(tx, {
          direction: 'out',
          transactionDate: input.movementDate,
          amount: totalCost,
          categoryId: await categoryId(tx, 'Materials'),
          costCentreType: input.costCentreType,
          projectId,
          description: `Materials issued: ${input.quantity} ${m.unit} ${m.name} to ${projectLabel}`,
          source: 'stock_issue',
          sourceId: movementId,
          affectsCash: false,
          affectsPnl: true,
          recordedBy: user.id,
        });
        await tx
          .update(stockMovements)
          .set({ transactionId })
          .where(eq(stockMovements.id, movementId));
      }
      await tx.update(materials).set({ quantityOnHand }).where(eq(materials.id, id));
      await auditService.log(
        {
          action: 'stock_issue',
          entityType: 'material',
          entityId: id,
          oldValues: { quantityOnHand: m.quantityOnHand },
          newValues: { quantityOnHand, movementId, totalCost, ...input },
        },
        tx,
      );
      await syncLowStock(tx, m, quantityOnHand);
    });
    return this.get(id);
  },

  /** Stock count correction (+/−) with a reason; no ledger entry. */
  async adjust(user: AuthUser, id: number, input: AdjustInput) {
    assertNotFuture(input.movementDate);
    await db.transaction(async (tx) => {
      const m = await lockMaterial(tx, id);
      const quantityOnHand = addQuantity(m.quantityOnHand, input.quantity);
      if (quantityOnHand < 0) {
        throw AppError.rule(`Adjustment would leave negative stock (${quantityOnHand} ${m.unit})`);
      }
      const [res] = await tx.insert(stockMovements).values({
        materialId: id,
        type: 'adjustment',
        quantity: input.quantity,
        unitCost: m.averageUnitCost,
        totalCost: issueCost(m.averageUnitCost, input.quantity),
        movementDate: input.movementDate,
        notes: input.reason,
        performedBy: user.id,
      });
      await tx.update(materials).set({ quantityOnHand }).where(eq(materials.id, id));
      await auditService.log(
        {
          action: 'stock_adjust',
          entityType: 'material',
          entityId: id,
          oldValues: { quantityOnHand: m.quantityOnHand },
          newValues: { quantityOnHand, movementId: res.insertId, ...input },
        },
        tx,
      );
      await syncLowStock(tx, m, quantityOnHand);
    });
    return this.get(id);
  },
};
