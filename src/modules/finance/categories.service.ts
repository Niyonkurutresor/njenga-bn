import { and, asc, eq, ne } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { categories } from '../../db/schema/index.js';
import type { CategoryKind } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { diff } from '../../common/utils/diff.js';
import { auditService } from '../audit/audit.service.js';
import type { CategoryQuery, CreateCategoryInput, UpdateCategoryInput } from './finance.schema.js';

const columns = {
  id: categories.id,
  name: categories.name,
  kind: categories.kind,
  isActive: categories.isActive,
};

/** Id of a seeded category such as "Salaries" (FR-PAY-06), or null when it was removed/renamed. */
export async function categoryIdByName(
  tx: Executor,
  name: string,
  kind: CategoryKind,
): Promise<number | null> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.kind, kind)));
  return row?.id ?? null;
}

/** Validates that a category exists, is active and matches the money direction. */
export async function assertCategory(
  tx: Executor,
  id: number,
  kind: CategoryKind,
  allowInactive = false,
): Promise<void> {
  const [row] = await tx.select(columns).from(categories).where(eq(categories.id, id));
  if (!row) throw AppError.rule('Category does not exist');
  if (row.kind !== kind) {
    throw AppError.rule(
      kind === 'expense' ? 'Choose an expense category' : 'Choose an income category',
    );
  }
  if (!row.isActive && !allowInactive) throw AppError.rule(`Category "${row.name}" is inactive`);
}

/** Configurable categories (FR-FIN-02, NFR-13). Never hard-deleted — deactivate instead. */
export const categoryService = {
  /** Contract with the frontend `useCategoryOptions`: `{ id, name, kind, isActive }[]`. */
  async list(query: CategoryQuery) {
    return db
      .select(columns)
      .from(categories)
      .where(
        and(
          query.kind ? eq(categories.kind, query.kind) : undefined,
          query.active === undefined ? undefined : eq(categories.isActive, query.active),
        ),
      )
      .orderBy(asc(categories.kind), asc(categories.name));
  },

  async get(id: number) {
    const [row] = await db.select(columns).from(categories).where(eq(categories.id, id));
    if (!row) throw AppError.notFound('Category');
    return row;
  },

  async create(input: CreateCategoryInput) {
    const id = await db.transaction(async (tx) => {
      const [dupe] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.name, input.name), eq(categories.kind, input.kind)));
      if (dupe) throw AppError.conflict(`An ${input.kind} category "${input.name}" already exists`);
      const [res] = await tx.insert(categories).values({ ...input, isActive: true });
      await auditService.log(
        { action: 'create', entityType: 'category', entityId: res.insertId, newValues: input },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateCategoryInput) {
    await db.transaction(async (tx) => {
      const [row] = await tx.select(columns).from(categories).where(eq(categories.id, id));
      if (!row) throw AppError.notFound('Category');
      if (input.name && input.name !== row.name) {
        const [dupe] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.name, input.name),
              eq(categories.kind, row.kind),
              ne(categories.id, id),
            ),
          );
        if (dupe) throw AppError.conflict(`An ${row.kind} category "${input.name}" already exists`);
      }
      const changes = diff(row, input);
      if (!changes) return;
      await tx.update(categories).set(input).where(eq(categories.id, id));
      await auditService.log(
        {
          action: input.isActive === false ? 'deactivate' : 'update',
          entityType: 'category',
          entityId: id,
          ...changes,
        },
        tx,
      );
    });
    return this.get(id);
  },
};
