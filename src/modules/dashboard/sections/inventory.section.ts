import { and, asc, between, gt, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { materials, stockMovements } from '../../../db/schema/index.js';
import { toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { linkTo } from '../dashboard.calc.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface InventorySection {
  kpis: Kpi[];
  lowStock: {
    id: number;
    name: string;
    unit: string;
    quantityOnHand: number;
    reorderLevel: number;
    link: string;
  }[];
}

const lowStockWhere = and(
  isNull(materials.deletedAt),
  gt(materials.reorderLevel, 0),
  lte(materials.quantityOnHand, materials.reorderLevel),
);

/** FR-INV-04 low stock and the period's procurement (receipts) / issues. */
export const inventorySection: SectionBuilder<InventorySection> = {
  key: 'inventory',
  visible: (ctx) => ctx.can(P.INVENTORY_VIEW),
  async build({ period }) {
    const [rows, [count], [moves]] = await Promise.all([
      db
        .select({
          id: materials.id,
          name: materials.name,
          unit: materials.unit,
          quantityOnHand: materials.quantityOnHand,
          reorderLevel: materials.reorderLevel,
        })
        .from(materials)
        .where(lowStockWhere)
        .orderBy(asc(sql`${materials.quantityOnHand} / ${materials.reorderLevel}`))
        .limit(8),
      db
        .select({ n: sql<number>`count(*)` })
        .from(materials)
        .where(lowStockWhere),
      db
        .select({
          received: sql<string>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.totalCost} ELSE 0 END), 0)`,
          issued: sql<string>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'issue' THEN ABS(${stockMovements.totalCost}) ELSE 0 END), 0)`,
        })
        .from(stockMovements)
        .where(between(stockMovements.movementDate, period.from, period.to)),
    ]);
    const low = Number(count?.n ?? 0);
    const range = { from: period.from, to: period.to };
    return {
      kpis: [
        {
          key: 'lowStock',
          label: 'Materials below reorder level',
          value: low,
          format: 'number',
          tone: low ? 'red' : 'green',
          link: '/inventory?lowStock=true',
        },
        {
          key: 'received',
          label: 'Stock received (procurement)',
          value: toNumber(moves?.received),
          format: 'money',
          link: linkTo('/inventory/movements', { type: 'receipt', ...range }),
        },
        {
          key: 'issued',
          label: 'Stock issued',
          value: toNumber(moves?.issued),
          format: 'money',
          link: linkTo('/inventory/movements', { type: 'issue', ...range }),
        },
      ],
      lowStock: rows.map((r) => ({
        ...r,
        quantityOnHand: toNumber(r.quantityOnHand),
        reorderLevel: toNumber(r.reorderLevel),
        link: `/inventory/materials/${r.id}`,
      })),
    };
  },
};
