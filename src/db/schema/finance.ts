import {
  boolean,
  date,
  decimal,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  CATEGORY_KINDS,
  LOAN_STATUSES,
  PAYMENT_METHODS,
  TRANSACTION_DIRECTIONS,
  TRANSACTION_SOURCES,
} from '../enums.js';
import { costCentreType, createdAt, id, money, ref, softDelete, timestamps } from './_columns.js';
import { users } from './auth.js';
import { projects } from './projects.js';

/** Configurable expense / income categories (FR-FIN-02). */
export const categories = mysqlTable(
  'categories',
  {
    id: id(),
    name: varchar('name', { length: 100 }).notNull(),
    kind: mysqlEnum('kind', CATEGORY_KINDS).notNull().default('expense'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('categories_name_kind_uq').on(t.name, t.kind)],
);

export const loans = mysqlTable('loans', {
  id: id(),
  lender: varchar('lender', { length: 150 }).notNull(),
  principal: money('principal').notNull(),
  /** Annual rate in percent. */
  interestRate: decimal('interest_rate', { precision: 6, scale: 3, mode: 'number' })
    .notNull()
    .default(0),
  /** Interest charged to date — feeds the loan balance (BRL-06). */
  interestCharged: money('interest_charged').notNull().default(0),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  termMonths: int('term_months'),
  repaymentSchedule: text('repayment_schedule'),
  purpose: text('purpose'),
  status: mysqlEnum('status', LOAN_STATUSES).notNull().default('active'),
  createdBy: ref('created_by').references(() => users.id),
  ...timestamps(),
  ...softDelete(),
});

export const loanRepayments = mysqlTable(
  'loan_repayments',
  {
    id: id(),
    loanId: ref('loan_id')
      .notNull()
      .references(() => loans.id),
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    amount: money('amount').notNull(),
    reference: varchar('reference', { length: 100 }),
    notes: text('notes'),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('loan_repayments_loan_idx').on(t.loanId)],
);

/**
 * Single money ledger (payments, income, expenses).
 *  - `affectsCash`: real money moved (cash flow, FR-FIN-09)
 *  - `affectsPnl`:  counts as income/cost in profit & loss (FR-FIN-08)
 * Examples: stock purchase = cash yes / P&L no; stock issue to a project = cash no / P&L yes.
 */
export const transactions = mysqlTable(
  'transactions',
  {
    id: id(),
    direction: mysqlEnum('direction', TRANSACTION_DIRECTIONS).notNull(),
    transactionDate: date('transaction_date', { mode: 'string' }).notNull(),
    amount: money('amount').notNull(),
    categoryId: ref('category_id').references(() => categories.id),
    costCentreType: costCentreType().notNull(),
    projectId: ref('project_id').references(() => projects.id),
    paymentMethod: mysqlEnum('payment_method', PAYMENT_METHODS),
    reference: varchar('reference', { length: 100 }),
    description: text('description'),
    source: mysqlEnum('source', TRANSACTION_SOURCES).notNull().default('manual'),
    /** Id of the originating record (request, payroll item, stock movement, ...). */
    sourceId: ref('source_id'),
    loanId: ref('loan_id').references(() => loans.id),
    affectsCash: boolean('affects_cash').notNull().default(true),
    affectsPnl: boolean('affects_pnl').notNull().default(true),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('tx_date_idx').on(t.transactionDate),
    index('tx_cost_centre_idx').on(t.costCentreType, t.projectId),
    index('tx_reference_idx').on(t.reference),
    index('tx_source_idx').on(t.source, t.sourceId),
    index('tx_loan_idx').on(t.loanId),
  ],
);

/** Budget per project, or per period for farm / office (FR-FIN-03). */
export const budgets = mysqlTable(
  'budgets',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    costCentreType: costCentreType().notNull(),
    projectId: ref('project_id').references(() => projects.id),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    amount: money('amount').notNull(),
    notes: text('notes'),
    createdBy: ref('created_by').references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('budgets_cost_centre_idx').on(t.costCentreType, t.projectId)],
);

/** Optional per-category breakdown of a budget. */
export const budgetLines = mysqlTable(
  'budget_lines',
  {
    id: id(),
    budgetId: ref('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    categoryId: ref('category_id')
      .notNull()
      .references(() => categories.id),
    amount: money('amount').notNull(),
  },
  (t) => [uniqueIndex('budget_lines_uq').on(t.budgetId, t.categoryId)],
);
