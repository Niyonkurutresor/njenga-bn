import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import type { CostCentreType } from '../../db/enums.js';
import { budgetLines, budgets, categories, projects, transactions } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { round2, toNumber } from '../../common/utils/money.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { markProjectBudgeted } from '../projects/project-lifecycle.js';
import { budgetSpendFilter, budgetSpentSql } from './budget-usage.js';
import { budgetUsage } from './finance.calc.js';
import type { BudgetListQuery, CreateBudgetInput, UpdateBudgetInput } from './finance.schema.js';

type BudgetRow = typeof budgets.$inferSelect;

const listColumns = {
  id: budgets.id,
  name: budgets.name,
  costCentreType: budgets.costCentreType,
  projectId: budgets.projectId,
  periodStart: budgets.periodStart,
  periodEnd: budgets.periodEnd,
  amount: budgets.amount,
  notes: budgets.notes,
  createdAt: budgets.createdAt,
  updatedAt: budgets.updatedAt,
  project: { id: projects.id, code: projects.code, name: projects.name, status: projects.status },
  spent: budgetSpentSql,
};

const SORTS = {
  name: budgets.name,
  amount: budgets.amount,
  createdAt: budgets.createdAt,
  periodStart: budgets.periodStart,
} as const;

function withUsage<T extends { amount: number; spent: string | number }>(row: T) {
  const { spent, ...rest } = row;
  return { ...rest, usage: budgetUsage(row.amount, toNumber(spent)) };
}

/** Budgets that are "live": open projects, or farm/office periods that have not ended. */
function currentFilter(): SQL {
  const now = today();
  return or(
    and(eq(budgets.costCentreType, 'project'), ne(projects.status, 'closed')),
    and(
      ne(budgets.costCentreType, 'project'),
      or(isNull(budgets.periodStart), lte(budgets.periodStart, now)),
      or(isNull(budgets.periodEnd), gte(budgets.periodEnd, now)),
    ),
  )!;
}

async function lockBudget(tx: Executor, id: number): Promise<BudgetRow> {
  const [row] = await tx
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, id), isNull(budgets.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Budget');
  return row;
}

async function assertLineCategories(tx: Executor, lines: { categoryId: number }[]) {
  if (!lines.length) return;
  const rows = await tx
    .select({ id: categories.id, kind: categories.kind })
    .from(categories)
    .where(
      inArray(
        categories.id,
        lines.map((l) => l.categoryId),
      ),
    );
  if (rows.length !== new Set(lines.map((l) => l.categoryId)).size) {
    throw AppError.rule('A budget line refers to a category that does not exist');
  }
  if (rows.some((r) => r.kind !== 'expense')) {
    throw AppError.rule('Budget lines must use expense categories');
  }
}

async function replaceLines(
  tx: Executor,
  budgetId: number,
  lines: { categoryId: number; amount: number }[],
) {
  await tx.delete(budgetLines).where(eq(budgetLines.budgetId, budgetId));
  if (lines.length) {
    await tx.insert(budgetLines).values(lines.map((l) => ({ budgetId, ...l })));
  }
}

function assertLinesWithinTotal(lines: { amount: number }[] | undefined, amount: number) {
  const total = round2((lines ?? []).reduce((s, l) => s + l.amount, 0));
  if (total > amount) {
    throw AppError.rule(
      `Category lines add up to more than the budget (${total.toLocaleString('en-US')})`,
    );
  }
}

export const budgetService = {
  /** Budgets with real-time used / remaining / % used and level (FR-FIN-04, FR-FIN-05). */
  async list(query: BudgetListQuery) {
    const filters: SQL[] = [isNull(budgets.deletedAt)];
    if (query.costCentreType) filters.push(eq(budgets.costCentreType, query.costCentreType));
    if (query.projectId) filters.push(eq(budgets.projectId, query.projectId));
    if (query.current) filters.push(currentFilter());
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(budgets.name, term), like(projects.name, term), like(projects.code, term))!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'createdAt'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(listColumns)
        .from(budgets)
        .leftJoin(projects, eq(projects.id, budgets.projectId))
        .where(where)
        .orderBy(order, desc(budgets.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(budgets)
        .leftJoin(projects, eq(projects.id, budgets.projectId))
        .where(where),
    ]);
    return paginated(rows.map(withUsage), Number(total), query);
  },

  /** Current budgets at amber or red, worst first (finance overview, dashboards). */
  async atRisk() {
    return (await this.all({ current: true }))
      .filter((b) => b.usage.level !== 'ok')
      .sort((a, b) => (b.usage.usedPct ?? 0) - (a.usage.usedPct ?? 0));
  },

  /** Every budget with usage (budget-vs-actual book). */
  async all(filter: {
    current?: boolean;
    costCentreType?: CostCentreType | undefined;
    projectId?: number | undefined;
  }) {
    const rows = await db
      .select(listColumns)
      .from(budgets)
      .leftJoin(projects, eq(projects.id, budgets.projectId))
      .where(
        and(
          isNull(budgets.deletedAt),
          filter.current ? currentFilter() : undefined,
          filter.costCentreType ? eq(budgets.costCentreType, filter.costCentreType) : undefined,
          filter.projectId ? eq(budgets.projectId, filter.projectId) : undefined,
        ),
      )
      .orderBy(asc(budgets.costCentreType), asc(budgets.name));
    return rows.map(withUsage);
  },

  /** Budget detail with budget vs actual per category (US-OA-004 AC1). */
  async get(id: number) {
    const [row] = await db
      .select(listColumns)
      .from(budgets)
      .leftJoin(projects, eq(projects.id, budgets.projectId))
      .where(and(eq(budgets.id, id), isNull(budgets.deletedAt)));
    if (!row) throw AppError.notFound('Budget');

    const [lines, actuals] = await Promise.all([
      db
        .select({
          categoryId: budgetLines.categoryId,
          amount: budgetLines.amount,
          name: categories.name,
        })
        .from(budgetLines)
        .innerJoin(categories, eq(categories.id, budgetLines.categoryId))
        .where(eq(budgetLines.budgetId, id)),
      db
        .select({
          categoryId: transactions.categoryId,
          name: categories.name,
          total: sql<string>`SUM(${transactions.amount})`,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(budgetSpendFilter(row))
        .groupBy(transactions.categoryId, categories.name),
    ]);

    const byCategory = new Map<
      number | null,
      { categoryId: number | null; category: string; budgeted: number | null; actual: number }
    >();
    for (const l of lines) {
      byCategory.set(l.categoryId, {
        categoryId: l.categoryId,
        category: l.name,
        budgeted: l.amount,
        actual: 0,
      });
    }
    for (const a of actuals) {
      const entry = byCategory.get(a.categoryId) ?? {
        categoryId: a.categoryId,
        category: a.name ?? 'Uncategorised',
        budgeted: null,
        actual: 0,
      };
      entry.actual = round2(toNumber(a.total));
      byCategory.set(a.categoryId, entry);
    }
    const categoriesView = [...byCategory.values()]
      .map((c) => ({
        ...c,
        usage: c.budgeted === null ? null : budgetUsage(c.budgeted, c.actual),
      }))
      .sort((a, b) => b.actual - a.actual || a.category.localeCompare(b.category));

    return {
      ...withUsage(row),
      lines: lines.map((l) => ({ categoryId: l.categoryId, amount: l.amount })),
      categories: categoriesView,
    };
  },

  /** FR-FIN-03. A project budget moves a `created` project to `budgeted` (FR-PRJ-03). */
  async create(user: AuthUser, input: CreateBudgetInput) {
    const id = await db.transaction(async (tx) => {
      const projectId = input.costCentreType === 'project' ? (input.projectId ?? null) : null;
      if (projectId) {
        const [project] = await tx
          .select({ id: projects.id, status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
          .for('update');
        if (!project) throw AppError.rule('Project does not exist');
        if (project.status === 'closed') throw AppError.rule('The project is closed');
        // One budget per project keeps "budget vs actual" unambiguous; edit it to change it.
        const [existing] = await tx
          .select({ id: budgets.id })
          .from(budgets)
          .where(and(eq(budgets.projectId, projectId), isNull(budgets.deletedAt)));
        if (existing) {
          throw AppError.conflict('This project already has a budget; edit it instead', {
            budgetId: existing.id,
          });
        }
      }
      if (input.lines) {
        await assertLineCategories(tx, input.lines);
        assertLinesWithinTotal(input.lines, input.amount);
      }
      const [res] = await tx.insert(budgets).values({
        name: input.name,
        costCentreType: input.costCentreType,
        projectId,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        amount: input.amount,
        notes: input.notes ?? null,
        createdBy: user.id,
      });
      const budgetId = res.insertId;
      if (input.lines?.length) await replaceLines(tx, budgetId, input.lines);
      await auditService.log(
        { action: 'create', entityType: 'budget', entityId: budgetId, newValues: { ...input } },
        tx,
      );
      if (projectId) await markProjectBudgeted(tx, projectId, user.id);
      return budgetId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateBudgetInput) {
    await db.transaction(async (tx) => {
      const row = await lockBudget(tx, id);
      const { lines, ...fields } = input;
      const merged = { ...row, ...fields };
      if (
        merged.costCentreType !== 'project' &&
        (!merged.periodStart || !merged.periodEnd || merged.periodStart > merged.periodEnd)
      ) {
        throw AppError.rule('Farm and office budgets need a valid period');
      }
      let oldLines: { categoryId: number; amount: number }[] | undefined;
      if (lines) {
        await assertLineCategories(tx, lines);
        oldLines = await tx
          .select({ categoryId: budgetLines.categoryId, amount: budgetLines.amount })
          .from(budgetLines)
          .where(eq(budgetLines.budgetId, id));
      }
      assertLinesWithinTotal(
        lines ??
          (await tx
            .select({ amount: budgetLines.amount })
            .from(budgetLines)
            .where(eq(budgetLines.budgetId, id))),
        merged.amount,
      );
      const changes = diff(row, fields);
      if (changes) await tx.update(budgets).set(fields).where(eq(budgets.id, id));
      if (lines) await replaceLines(tx, id, lines);
      if (changes || lines) {
        await auditService.log(
          {
            action: 'update',
            entityType: 'budget',
            entityId: id,
            oldValues: { ...(changes?.oldValues ?? {}), ...(lines ? { lines: oldLines } : {}) },
            newValues: { ...(changes?.newValues ?? {}), ...(lines ? { lines } : {}) },
          },
          tx,
        );
      }
    });
    return this.get(id);
  },

  /** Soft delete (BRL-10). */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockBudget(tx, id);
      await tx.update(budgets).set({ deletedAt: new Date() }).where(eq(budgets.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'budget',
          entityId: id,
          oldValues: { name: row.name, amount: row.amount, costCentreType: row.costCentreType },
        },
        tx,
      );
    });
  },
};
