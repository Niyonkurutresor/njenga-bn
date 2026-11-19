import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { budgets, projects, transactions } from '../../db/schema/index.js';
import type {
  CostCentreType,
  PaymentMethod,
  TransactionDirection,
  TransactionSource,
} from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { toNumber } from '../../common/utils/money.js';
import { auditService } from '../audit/audit.service.js';
import { checkBudgetThresholds } from './budget-usage.js';
import { budgetUsage, type BudgetUsage } from './finance.calc.js';

export interface LedgerEntryInput {
  direction: TransactionDirection;
  transactionDate: string;
  amount: number;
  categoryId?: number | null | undefined;
  costCentreType: CostCentreType;
  projectId?: number | null | undefined;
  paymentMethod?: PaymentMethod | null | undefined;
  reference?: string | null | undefined;
  description?: string | null | undefined;
  source: TransactionSource;
  sourceId?: number | null | undefined;
  loanId?: number | null | undefined;
  affectsCash?: boolean;
  affectsPnl?: boolean;
  recordedBy: number;
}

/**
 * The ONLY way money enters the ledger. Every module that pays, spends or earns
 * (requests, payroll, casual pay, inventory, loans, manual entries) posts through here,
 * so the cost-centre and closed-project rules are enforced in one place.
 */
export async function recordTransaction(tx: Executor, input: LedgerEntryInput): Promise<number> {
  if (input.amount <= 0) throw AppError.rule('Amount must be greater than zero');
  if (input.costCentreType === 'project' && !input.projectId) {
    throw AppError.rule('A project must be selected for project costs');
  }
  if (input.costCentreType !== 'project' && input.projectId) {
    throw AppError.rule('Only project cost centres can reference a project');
  }

  if (input.projectId) {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)));
    if (!project) throw AppError.rule('Project does not exist');
    // BRL-08 / FR-PRJ-09
    if (project.status === 'closed' && input.direction === 'out') {
      throw AppError.rule('No expenses can be added to a closed project');
    }
  }

  const [res] = await tx.insert(transactions).values({
    direction: input.direction,
    transactionDate: input.transactionDate,
    amount: input.amount,
    categoryId: input.categoryId ?? null,
    costCentreType: input.costCentreType,
    projectId: input.projectId ?? null,
    paymentMethod: input.paymentMethod ?? null,
    reference: input.reference ?? null,
    description: input.description ?? null,
    source: input.source,
    sourceId: input.sourceId ?? null,
    loanId: input.loanId ?? null,
    affectsCash: input.affectsCash ?? true,
    affectsPnl: input.affectsPnl ?? true,
    recordedBy: input.recordedBy,
  });

  await auditService.log(
    {
      action: 'create',
      entityType: 'transaction',
      entityId: res.insertId,
      newValues: { ...input },
    },
    tx,
  );

  // US-OA-004 AC2: alert finance managers when this outflow takes a budget past 80 % / 100 %.
  if (input.direction === 'out' && (input.affectsPnl ?? true)) {
    await checkBudgetThresholds(tx, input, input.amount);
  }
  return res.insertId;
}

/** True if a non-deleted transaction already uses this reference (duplicate warning, US-OA-003 AC3). */
export async function referenceExists(tx: Executor, reference: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.reference, reference), isNull(transactions.deletedAt)))
    .limit(1);
  return Boolean(row);
}

/** Total budget and recorded project cost (P&L-affecting outflows) for a project. */
export async function projectBudgetUsage(tx: Executor, projectId: number): Promise<BudgetUsage> {
  const [[budgetRow], [spentRow]] = await Promise.all([
    tx
      .select({ total: sql<string>`COALESCE(SUM(${budgets.amount}), 0)` })
      .from(budgets)
      .where(
        and(
          eq(budgets.costCentreType, 'project'),
          eq(budgets.projectId, projectId),
          isNull(budgets.deletedAt),
        ),
      ),
    tx
      .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.projectId, projectId),
          eq(transactions.direction, 'out'),
          eq(transactions.affectsPnl, true),
          isNull(transactions.deletedAt),
        ),
      ),
  ]);
  return budgetUsage(toNumber(budgetRow?.total), toNumber(spentRow?.total));
}
