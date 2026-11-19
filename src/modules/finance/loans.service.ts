import { and, asc, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  categories,
  loanRepayments,
  loans,
  projects,
  transactions,
  users,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { round2, toNumber } from '../../common/utils/money.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { categoryIdByName } from './categories.service.js';
import { loanUtilisation } from './finance.calc.js';
import { recordTransaction } from './ledger.js';
import type {
  CreateLoanInput,
  LoanListQuery,
  LoanReceiptInput,
  LoanRepaymentInput,
  UpdateLoanInput,
} from './finance.schema.js';

type LoanRow = typeof loans.$inferSelect;

/**
 * Loan figures come from the ledger so they always agree with the books (US-OA-008):
 *  - used     = outflows linked to the loan, excluding repayments (use of funds, FR-FIN-07)
 *  - repaid   = non-deleted `loan_repayment` transactions
 *  - received = non-deleted `loan_receipt` transactions
 */
const usedSql = sql<string>`(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
  WHERE t.loan_id = loans.id AND t.direction = 'out' AND t.source <> 'loan_repayment'
    AND t.deleted_at IS NULL)`;
const repaidSql = sql<string>`(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
  WHERE t.loan_id = loans.id AND t.source = 'loan_repayment' AND t.deleted_at IS NULL)`;
const receivedSql = sql<string>`(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
  WHERE t.loan_id = loans.id AND t.source = 'loan_receipt' AND t.deleted_at IS NULL)`;

const listColumns = {
  id: loans.id,
  lender: loans.lender,
  principal: loans.principal,
  interestRate: loans.interestRate,
  interestCharged: loans.interestCharged,
  startDate: loans.startDate,
  termMonths: loans.termMonths,
  repaymentSchedule: loans.repaymentSchedule,
  purpose: loans.purpose,
  status: loans.status,
  createdAt: loans.createdAt,
  updatedAt: loans.updatedAt,
  used: usedSql,
  repaid: repaidSql,
  received: receivedSql,
};

const SORTS = {
  startDate: loans.startDate,
  principal: loans.principal,
  lender: loans.lender,
  createdAt: loans.createdAt,
} as const;

function withFigures<
  T extends {
    principal: number;
    interestCharged: number;
    used: string;
    repaid: string;
    received: string;
  },
>(row: T) {
  const { used, repaid, received, ...rest } = row;
  return {
    ...rest,
    received: round2(toNumber(received)),
    ...loanUtilisation(row.principal, row.interestCharged, toNumber(used), toNumber(repaid)),
  };
}

async function lockLoan(tx: Executor, id: number): Promise<LoanRow> {
  const [row] = await tx
    .select()
    .from(loans)
    .where(and(eq(loans.id, id), isNull(loans.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Loan');
  return row;
}

async function figures(tx: Executor, id: number) {
  const [row] = await tx.select(listColumns).from(loans).where(eq(loans.id, id));
  if (!row) throw AppError.notFound('Loan');
  return withFigures(row);
}

export const loanService = {
  async exists(id: number): Promise<boolean> {
    const [row] = await db
      .select({ id: loans.id })
      .from(loans)
      .where(and(eq(loans.id, id), isNull(loans.deletedAt)));
    return Boolean(row);
  },

  async list(query: LoanListQuery) {
    const filters: SQL[] = [isNull(loans.deletedAt)];
    if (query.status) filters.push(eq(loans.status, query.status));
    if (query.search) filters.push(like(loans.lender, `%${query.search}%`));
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'startDate'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(listColumns)
        .from(loans)
        .where(where)
        .orderBy(order, desc(loans.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(loans)
        .where(where),
    ]);
    return paginated(rows.map(withFigures), Number(total), query);
  },

  /** Outstanding balance across active loans (finance overview). */
  async outstanding() {
    const rows = await db
      .select(listColumns)
      .from(loans)
      .where(and(isNull(loans.deletedAt), eq(loans.status, 'active')));
    const all = rows.map(withFigures);
    return {
      count: all.length,
      balance: round2(all.reduce((s, l) => s + l.balance, 0)),
      unused: round2(all.reduce((s, l) => s + Math.max(0, l.unused), 0)),
    };
  },

  /** Loan with use of funds and repayments (US-OA-008). */
  async get(id: number) {
    const [row] = await db
      .select(listColumns)
      .from(loans)
      .where(and(eq(loans.id, id), isNull(loans.deletedAt)));
    if (!row) throw AppError.notFound('Loan');

    const [repayments, uses] = await Promise.all([
      db
        .select({
          id: loanRepayments.id,
          paymentDate: loanRepayments.paymentDate,
          amount: loanRepayments.amount,
          reference: loanRepayments.reference,
          notes: loanRepayments.notes,
          createdAt: loanRepayments.createdAt,
          transactionId: transactions.id,
          recordedBy: { id: users.id, name: users.name },
        })
        .from(loanRepayments)
        .innerJoin(
          transactions,
          and(
            eq(transactions.source, 'loan_repayment'),
            eq(transactions.sourceId, loanRepayments.id),
            isNull(transactions.deletedAt),
          ),
        )
        .innerJoin(users, eq(users.id, loanRepayments.recordedBy))
        .where(eq(loanRepayments.loanId, id))
        .orderBy(desc(loanRepayments.paymentDate), desc(loanRepayments.id)),
      db
        .select({
          id: transactions.id,
          direction: transactions.direction,
          transactionDate: transactions.transactionDate,
          amount: transactions.amount,
          source: transactions.source,
          costCentreType: transactions.costCentreType,
          reference: transactions.reference,
          description: transactions.description,
          category: { id: categories.id, name: categories.name },
          project: { id: projects.id, code: projects.code, name: projects.name },
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .where(
          and(
            eq(transactions.loanId, id),
            sql`${transactions.source} <> 'loan_repayment'`,
            isNull(transactions.deletedAt),
          ),
        )
        .orderBy(desc(transactions.transactionDate), desc(transactions.id))
        .limit(200),
    ]);
    return { ...withFigures(row), repayments, transactions: uses };
  },

  async create(user: AuthUser, input: CreateLoanInput) {
    const id = await db.transaction(async (tx) => {
      const [res] = await tx.insert(loans).values({ ...input, createdBy: user.id });
      await auditService.log(
        { action: 'create', entityType: 'loan', entityId: res.insertId, newValues: { ...input } },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateLoanInput) {
    await db.transaction(async (tx) => {
      const row = await lockLoan(tx, id);
      const changes = diff(row, input);
      if (!changes) return;
      await tx.update(loans).set(input).where(eq(loans.id, id));
      await auditService.log(
        { action: 'update', entityType: 'loan', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(id);
  },

  /** Soft delete; a loan with money recorded against it stays (BRL-10, NFR-11). */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockLoan(tx, id);
      const [linked] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.loanId, id), isNull(transactions.deletedAt)))
        .limit(1);
      if (linked) {
        throw AppError.rule('This loan has transactions recorded against it and cannot be deleted');
      }
      await tx.update(loans).set({ deletedAt: new Date() }).where(eq(loans.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'loan',
          entityId: id,
          oldValues: { lender: row.lender, principal: row.principal },
        },
        tx,
      );
    });
  },

  /**
   * Records a repayment (FR-FIN-07, BRL-06): a `loan_repayments` row plus a cash outflow that
   * is not a P&L cost. The loan is marked repaid once the balance reaches zero.
   */
  async recordRepayment(user: AuthUser, id: number, input: LoanRepaymentInput) {
    await db.transaction(async (tx) => {
      const loan = await lockLoan(tx, id);
      const before = await figures(tx, id);
      if (input.amount > before.balance + 0.005) {
        throw AppError.rule(
          `The repayment is more than the outstanding balance (RWF ${before.balance.toLocaleString('en-US')})`,
        );
      }
      const [res] = await tx.insert(loanRepayments).values({
        loanId: id,
        paymentDate: input.paymentDate,
        amount: input.amount,
        reference: input.reference || null,
        notes: input.notes || null,
        recordedBy: user.id,
      });
      await recordTransaction(tx, {
        direction: 'out',
        transactionDate: input.paymentDate,
        amount: input.amount,
        categoryId: await categoryIdByName(tx, 'Loan repayment', 'expense'),
        costCentreType: 'office',
        paymentMethod: input.paymentMethod,
        reference: input.reference || null,
        description: `Loan repayment — ${loan.lender}`,
        source: 'loan_repayment',
        sourceId: res.insertId,
        loanId: id,
        affectsPnl: false,
        recordedBy: user.id,
      });
      const balance = round2(before.balance - input.amount);
      if (balance <= 0 && loan.status !== 'repaid') {
        await tx.update(loans).set({ status: 'repaid' }).where(eq(loans.id, id));
      }
      await auditService.log(
        {
          action: 'repay',
          entityType: 'loan',
          entityId: id,
          oldValues: { balance: before.balance, status: loan.status },
          newValues: { repaymentId: res.insertId, ...input, balance },
        },
        tx,
      );
    });
    return this.get(id);
  },

  /** Money received from the lender: cash in, not income (affectsPnl false). */
  async recordReceipt(user: AuthUser, id: number, input: LoanReceiptInput) {
    await db.transaction(async (tx) => {
      const loan = await lockLoan(tx, id);
      const before = await figures(tx, id);
      if (round2(before.received + input.amount) > loan.principal) {
        throw AppError.rule('Total received cannot exceed the loan amount');
      }
      const transactionId = await recordTransaction(tx, {
        direction: 'in',
        transactionDate: input.receivedDate,
        amount: input.amount,
        categoryId: await categoryIdByName(tx, 'Loan received', 'income'),
        costCentreType: 'office',
        paymentMethod: input.paymentMethod,
        reference: input.reference || null,
        description: `Loan received — ${loan.lender}`,
        source: 'loan_receipt',
        sourceId: id,
        loanId: id,
        affectsPnl: false,
        recordedBy: user.id,
      });
      await auditService.log(
        {
          action: 'receive',
          entityType: 'loan',
          entityId: id,
          newValues: { transactionId, ...input },
        },
        tx,
      );
    });
    return this.get(id);
  },
};
