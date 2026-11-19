import { and, asc, desc, eq, gte, isNull, like, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { categories, loans, projects, transactions, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { can } from '../../common/middleware/authorize.js';
import { diff } from '../../common/utils/diff.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { checkBudgetThresholds } from './budget-usage.js';
import { assertCategory } from './categories.service.js';
import { isPaymentLocked, PAYMENT_EDIT_WINDOW_HOURS } from './finance.calc.js';
import { recordTransaction, referenceExists } from './ledger.js';
import type {
  CreateTransactionInput,
  TransactionListQuery,
  UpdateTransactionInput,
} from './finance.schema.js';

type TransactionRow = typeof transactions.$inferSelect;

const listColumns = {
  id: transactions.id,
  direction: transactions.direction,
  transactionDate: transactions.transactionDate,
  amount: transactions.amount,
  costCentreType: transactions.costCentreType,
  paymentMethod: transactions.paymentMethod,
  reference: transactions.reference,
  description: transactions.description,
  source: transactions.source,
  sourceId: transactions.sourceId,
  affectsCash: transactions.affectsCash,
  affectsPnl: transactions.affectsPnl,
  categoryId: transactions.categoryId,
  projectId: transactions.projectId,
  loanId: transactions.loanId,
  createdAt: transactions.createdAt,
  updatedAt: transactions.updatedAt,
  category: { id: categories.id, name: categories.name },
  project: { id: projects.id, code: projects.code, name: projects.name },
  loan: { id: loans.id, lender: loans.lender },
  recordedBy: { id: users.id, name: users.name },
};

const SORTS = {
  transactionDate: transactions.transactionDate,
  amount: transactions.amount,
  createdAt: transactions.createdAt,
} as const;

/**
 * Why `user` may not change this transaction, or null when they may (FR-FIN-10, BRL-09):
 * finance managers edit their manual entries for 24 h; after that, and for entries posted by
 * other modules (requests, payroll, stock, loans), only holders of `finance:override`.
 */
export function editBlockReason(
  user: AuthUser,
  row: Pick<TransactionRow, 'source' | 'createdAt'>,
): string | null {
  if (can(user, P.FINANCE_OVERRIDE)) return null;
  if (!can(user, P.FINANCE_MANAGE)) return 'You do not have permission to change transactions';
  if (row.source !== 'manual') {
    return 'This transaction was posted by another module; only a Director can change it here';
  }
  if (isPaymentLocked(row.createdAt)) {
    return `Payments are locked ${PAYMENT_EDIT_WINDOW_HOURS} hours after being recorded; only a Director can change it`;
  }
  return null;
}

function decorate<T extends Pick<TransactionRow, 'source' | 'createdAt'>>(user: AuthUser, row: T) {
  const reason = editBlockReason(user, row);
  return {
    ...row,
    locked: isPaymentLocked(row.createdAt),
    editable: reason === null,
    lockReason: reason,
  };
}

async function lockTransaction(tx: Executor, id: number): Promise<TransactionRow> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Transaction');
  return row;
}

async function assertLoan(tx: Executor, loanId: number) {
  const [loan] = await tx
    .select({ id: loans.id })
    .from(loans)
    .where(and(eq(loans.id, loanId), isNull(loans.deletedAt)));
  if (!loan) throw AppError.rule('Loan does not exist');
}

async function assertNotDuplicate(
  tx: Executor,
  reference: string | null | undefined,
  confirmed: boolean,
  excludeId?: number,
) {
  if (!reference || confirmed) return;
  const exists = excludeId
    ? (await duplicates(tx, reference, excludeId)).length > 0
    : await referenceExists(tx, reference);
  if (exists) {
    // US-OA-003 AC3: warn of a possible duplicate; the client may confirm and retry.
    throw AppError.conflict(`Payment reference "${reference}" has already been used`, {
      duplicateReference: true,
    });
  }
}

function duplicates(tx: Executor, reference: string, excludeId?: number) {
  return tx
    .select({
      id: transactions.id,
      transactionDate: transactions.transactionDate,
      amount: transactions.amount,
      direction: transactions.direction,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference, reference),
        isNull(transactions.deletedAt),
        excludeId ? ne(transactions.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(transactions.transactionDate))
    .limit(5);
}

export const transactionService = {
  async exists(id: number): Promise<boolean> {
    const [row] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
    return Boolean(row);
  },

  /** Ledger with filters (FR-FIN-01); `locked` / `editable` drive the UI lock indicator. */
  async list(user: AuthUser, query: TransactionListQuery) {
    const filters: SQL[] = [isNull(transactions.deletedAt)];
    if (query.direction) filters.push(eq(transactions.direction, query.direction));
    if (query.categoryId) filters.push(eq(transactions.categoryId, query.categoryId));
    if (query.costCentreType) filters.push(eq(transactions.costCentreType, query.costCentreType));
    if (query.projectId) filters.push(eq(transactions.projectId, query.projectId));
    if (query.loanId) filters.push(eq(transactions.loanId, query.loanId));
    if (query.source) filters.push(eq(transactions.source, query.source));
    if (query.from) filters.push(gte(transactions.transactionDate, query.from));
    if (query.to) filters.push(lte(transactions.transactionDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(transactions.reference, term), like(transactions.description, term))!);
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'transactionDate'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const [rows, [{ total } = { total: 0 }], [totals]] = await Promise.all([
      db
        .select(listColumns)
        .from(transactions)
        .innerJoin(users, eq(users.id, transactions.recordedBy))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .leftJoin(loans, eq(loans.id, transactions.loanId))
        .where(where)
        .orderBy(order, desc(transactions.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(transactions)
        .where(where),
      db
        .select({
          moneyIn: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'in' THEN ${transactions.amount} END), 0)`,
          moneyOut: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.direction} = 'out' THEN ${transactions.amount} END), 0)`,
        })
        .from(transactions)
        .where(where),
    ]);
    const page = paginated(
      rows.map((r) => decorate(user, r)),
      Number(total),
      query,
    );
    // Totals of the whole filtered set ride along in `meta` for the list footer.
    Object.assign(page.meta, {
      totalIn: Number(totals?.moneyIn ?? 0),
      totalOut: Number(totals?.moneyOut ?? 0),
    });
    return page;
  },

  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select(listColumns)
      .from(transactions)
      .innerJoin(users, eq(users.id, transactions.recordedBy))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(projects, eq(projects.id, transactions.projectId))
      .leftJoin(loans, eq(loans.id, transactions.loanId))
      .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
    if (!row) throw AppError.notFound('Transaction');
    return decorate(user, row);
  },

  /** US-OA-003 AC3: earlier transactions using the same reference. */
  async checkReference(reference: string, excludeId?: number) {
    const matches = await duplicates(db, reference, excludeId);
    return { exists: matches.length > 0, matches };
  },

  /** Manual income or expense (FR-FIN-01), posted through the ledger. */
  async create(user: AuthUser, input: CreateTransactionInput) {
    const id = await db.transaction(async (tx) => {
      await assertCategory(tx, input.categoryId, input.direction === 'out' ? 'expense' : 'income');
      if (input.loanId) {
        if (input.direction !== 'out') {
          throw AppError.rule('Record loan money received from the loan page');
        }
        await assertLoan(tx, input.loanId);
      }
      await assertNotDuplicate(tx, input.reference, input.confirmDuplicate);
      return recordTransaction(tx, {
        direction: input.direction,
        transactionDate: input.transactionDate,
        amount: input.amount,
        categoryId: input.categoryId,
        costCentreType: input.costCentreType,
        projectId: input.costCentreType === 'project' ? input.projectId : null,
        paymentMethod: input.paymentMethod ?? null,
        reference: input.reference || null,
        description: input.description || null,
        loanId: input.loanId ?? null,
        source: 'manual',
        recordedBy: user.id,
      });
    });
    return this.get(user, id);
  },

  /** FR-FIN-10 / BRL-09: editable for 24 h, then only with `finance:override`; every change logged. */
  async update(user: AuthUser, id: number, input: UpdateTransactionInput) {
    await db.transaction(async (tx) => {
      const row = await lockTransaction(tx, id);
      const blocked = editBlockReason(user, row);
      if (blocked) throw AppError.forbidden(blocked);

      const { confirmDuplicate, ...fields } = input;
      const merged = { ...row, ...fields };
      const projectId = merged.costCentreType === 'project' ? (merged.projectId ?? null) : null;
      if (merged.costCentreType === 'project' && !projectId) {
        throw AppError.rule('A project must be selected for project costs');
      }

      if (fields.categoryId !== undefined || fields.direction !== undefined) {
        if (merged.categoryId) {
          await assertCategory(
            tx,
            merged.categoryId,
            merged.direction === 'out' ? 'expense' : 'income',
            merged.categoryId === row.categoryId,
          );
        }
      }
      if (fields.loanId && fields.loanId !== row.loanId) await assertLoan(tx, fields.loanId);
      if (fields.reference && fields.reference !== row.reference) {
        await assertNotDuplicate(tx, fields.reference, confirmDuplicate, id);
      }

      const scopeChanged =
        merged.costCentreType !== row.costCentreType ||
        projectId !== row.projectId ||
        merged.transactionDate !== row.transactionDate ||
        merged.direction !== row.direction;
      if (projectId && merged.direction === 'out' && (scopeChanged || merged.amount > row.amount)) {
        const [project] = await tx
          .select({ status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
        if (!project) throw AppError.rule('Project does not exist');
        if (project.status === 'closed') {
          throw AppError.rule('No expenses can be added to a closed project');
        }
      }

      const patch = {
        ...fields,
        projectId,
        reference: fields.reference === undefined ? undefined : fields.reference || null,
        description: fields.description === undefined ? undefined : fields.description || null,
      };
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(transactions).set(patch).where(eq(transactions.id, id));
      await auditService.log(
        {
          action: isPaymentLocked(row.createdAt) || row.source !== 'manual' ? 'override' : 'update',
          entityType: 'transaction',
          entityId: id,
          ...changes,
        },
        tx,
      );

      if (merged.direction === 'out' && row.affectsPnl) {
        const delta = scopeChanged ? merged.amount : merged.amount - row.amount;
        await checkBudgetThresholds(tx, { ...merged, projectId }, delta);
      }
    });
    return this.get(user, id);
  },

  /** Soft delete (BRL-10) under the same 24 h rule. */
  async remove(user: AuthUser, id: number) {
    await db.transaction(async (tx) => {
      const row = await lockTransaction(tx, id);
      const blocked = editBlockReason(user, row);
      if (blocked) throw AppError.forbidden(blocked);
      await tx.update(transactions).set({ deletedAt: new Date() }).where(eq(transactions.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'transaction',
          entityId: id,
          oldValues: {
            direction: row.direction,
            amount: row.amount,
            transactionDate: row.transactionDate,
            reference: row.reference,
            source: row.source,
            sourceId: row.sourceId,
          },
        },
        tx,
      );
    });
  },
};
