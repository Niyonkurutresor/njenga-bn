import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import { db } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from './audit.service.js';

interface SoftDeletableTable {
  id: MySqlColumn;
  deletedAt: MySqlColumn;
}

/**
 * Every soft-deletable entity, with the column used to label it in the "deleted records" view.
 * Deletion is always soft (BRL-10); Directors restore from here (FR-AUD-04).
 */
const RESTORABLE = {
  request: { table: s.requests, label: s.requests.reference },
  transaction: { table: s.transactions, label: s.transactions.description },
  budget: { table: s.budgets, label: s.budgets.name },
  loan: { table: s.loans, label: s.loans.lender },
  employee: { table: s.employees, label: s.employees.fullName },
  casual_worker: { table: s.casualWorkers, label: s.casualWorkers.fullName },
  project: { table: s.projects, label: s.projects.name },
  task: { table: s.tasks, label: s.tasks.title },
  greenhouse: { table: s.greenhouses, label: s.greenhouses.name },
  harvest: { table: s.harvests, label: s.harvests.crop },
  inspection: { table: s.inspections, label: s.inspections.findings },
  customer: { table: s.customers, label: s.customers.name },
  lead: { table: s.leads, label: s.leads.title },
  sale: { table: s.sales, label: s.sales.description },
  material: { table: s.materials, label: s.materials.name },
  meeting: { table: s.meetings, label: s.meetings.title },
  document: { table: s.documents, label: s.documents.fileName },
} as const satisfies Record<string, { table: SoftDeletableTable; label: MySqlColumn }>;

export type RestorableEntityType = keyof typeof RESTORABLE;
export const RESTORABLE_ENTITY_TYPES = Object.keys(RESTORABLE) as [
  RestorableEntityType,
  ...RestorableEntityType[],
];

export const restoreService = {
  async listDeleted(entityType: RestorableEntityType) {
    const { table, label } = RESTORABLE[entityType];
    return db
      .select({ id: table.id, label, deletedAt: table.deletedAt })
      .from(table)
      .where(isNotNull(table.deletedAt))
      .orderBy(desc(table.deletedAt))
      .limit(200);
  },

  async restore(entityType: RestorableEntityType, entityId: number): Promise<void> {
    const { table } = RESTORABLE[entityType];
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, entityId), isNotNull(table.deletedAt)));
      if (!row) throw AppError.notFound('Deleted record');
      await tx.update(table).set({ deletedAt: null }).where(eq(table.id, entityId));
      await auditService.log({ action: 'restore', entityType, entityId }, tx);
    });
  },
};
