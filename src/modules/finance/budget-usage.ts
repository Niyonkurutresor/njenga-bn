import { and, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { budgets, projects, transactions } from '../../db/schema/index.js';
import type { CostCentreType } from '../../db/enums.js';
import { toNumber } from '../../common/utils/money.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { notificationService } from '../notifications/notifications.service.js';
import { budgetUsage, crossedBudgetLevel } from './finance.calc.js';

/**
 * Which ledger rows count against a budget (FR-FIN-04):
 *  - project budget: every P&L-affecting outflow of the project (any date);
 *  - farm / office budget: P&L-affecting outflows of that cost centre within the budget period.
 * Kept here (not in ledger.ts) so the ledger can run threshold checks without import cycles.
 */
export interface BudgetScope {
  costCentreType: CostCentreType;
  projectId: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export function budgetSpendFilter(scope: BudgetScope): SQL {
  const base = [
    eq(transactions.direction, 'out'),
    eq(transactions.affectsPnl, true),
    isNull(transactions.deletedAt),
  ];
  if (scope.costCentreType === 'project') {
    return and(...base, eq(transactions.projectId, scope.projectId ?? 0))!;
  }
  return and(
    ...base,
    eq(transactions.costCentreType, scope.costCentreType),
    scope.periodStart ? gte(transactions.transactionDate, scope.periodStart) : undefined,
    scope.periodEnd ? lte(transactions.transactionDate, scope.periodEnd) : undefined,
  )!;
}

/**
 * Correlated sub-query: spend counted against the budget row of the outer query (for lists).
 * Outer columns are written as `budgets.x` literally — Drizzle drops the table qualifier on
 * single-table selects, which would silently bind them to the inner `transactions` table.
 */
export const budgetSpentSql = sql<string>`(
  SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
  WHERE t.direction = 'out' AND t.affects_pnl = 1 AND t.deleted_at IS NULL
    AND (
      (budgets.cost_centre_type = 'project' AND t.project_id = budgets.project_id)
      OR (
        budgets.cost_centre_type <> 'project' AND t.cost_centre_type = budgets.cost_centre_type
        AND (budgets.period_start IS NULL OR t.transaction_date >= budgets.period_start)
        AND (budgets.period_end IS NULL OR t.transaction_date <= budgets.period_end)
      )
    )
)`;

export async function budgetSpent(tx: Executor, scope: BudgetScope): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
    .from(transactions)
    .where(budgetSpendFilter(scope));
  return toNumber(row?.total);
}

export interface LedgerScope {
  costCentreType: CostCentreType;
  projectId?: number | null | undefined;
  transactionDate: string;
}

/** Budgets whose usage includes a transaction posted to `scope`. */
async function affectedBudgets(tx: Executor, scope: LedgerScope) {
  const where =
    scope.costCentreType === 'project'
      ? and(eq(budgets.costCentreType, 'project'), eq(budgets.projectId, scope.projectId ?? 0))
      : and(
          eq(budgets.costCentreType, scope.costCentreType),
          or(isNull(budgets.periodStart), lte(budgets.periodStart, scope.transactionDate)),
          or(isNull(budgets.periodEnd), gte(budgets.periodEnd, scope.transactionDate)),
        );
  return tx
    .select({
      id: budgets.id,
      name: budgets.name,
      amount: budgets.amount,
      costCentreType: budgets.costCentreType,
      projectId: budgets.projectId,
      periodStart: budgets.periodStart,
      periodEnd: budgets.periodEnd,
      projectCode: projects.code,
    })
    .from(budgets)
    .leftJoin(projects, eq(projects.id, budgets.projectId))
    .where(and(where, isNull(budgets.deletedAt)));
}

function money(n: number) {
  return `RWF ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * US-OA-004 AC2 / FR-FIN-05: after `amount` was added to the spend of `scope`, notify
 * finance managers (in-app + email) of every budget that crossed 80 % (amber) or 100 % (red)
 * because of it. Only the crossing alerts, so repeated spending above a threshold stays quiet.
 * Project spend is measured against all of the project's budgets together (as `projectBudgetUsage`).
 */
export async function checkBudgetThresholds(
  tx: Executor,
  scope: LedgerScope,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  const rows = await affectedBudgets(tx, scope);
  if (!rows.length) return;

  const groups =
    scope.costCentreType === 'project'
      ? [
          {
            ids: rows.map((r) => r.id),
            name: rows.length === 1 ? rows[0]!.name : `${rows[0]!.projectCode ?? 'Project'} budget`,
            budget: rows.reduce((s, r) => s + r.amount, 0),
            scope: rows[0]!,
          },
        ]
      : rows.map((r) => ({ ids: [r.id], name: r.name, budget: r.amount, scope: r }));

  let recipients: number[] | null = null;
  for (const g of groups) {
    const spentAfter = await budgetSpent(tx, g.scope);
    const level = crossedBudgetLevel(g.budget, spentAfter - amount, spentAfter);
    if (!level) continue;
    recipients ??= await notificationService.userIdsWithPermission(P.FINANCE_MANAGE, tx);
    const usage = budgetUsage(g.budget, spentAfter);
    await notificationService.notify(
      {
        userIds: recipients,
        type: level === 'red' ? 'budget.exceeded' : 'budget.warning',
        title:
          level === 'red'
            ? `Budget exceeded: ${g.name}`
            : `Budget at ${usage.usedPct ?? 80}%: ${g.name}`,
        body: `${money(usage.spent)} spent of ${money(usage.budget)} (${usage.usedPct ?? 0}% used).`,
        link: `/finance/budgets/${g.ids[0]}`,
        entityType: 'budget',
        entityId: g.ids[0],
        email: true,
      },
      tx,
    );
  }
}
