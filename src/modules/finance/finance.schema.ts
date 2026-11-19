import { z } from 'zod';
import { dateRangeSchema, listQuerySchema, queryBoolean } from '../../common/http/pagination.js';
import {
  CATEGORY_KINDS,
  COST_CENTRE_TYPES,
  LOAN_STATUSES,
  PAYMENT_METHODS,
  TRANSACTION_DIRECTIONS,
  TRANSACTION_SOURCES,
} from '../../db/enums.js';

const money = z.coerce
  .number()
  .positive('Amount must be greater than zero')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const nonNegativeMoney = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(10_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const optionalId = z.coerce.number().int().positive().nullable().optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const projectRequired = <T extends { costCentreType?: string; projectId?: number | null }>(v: T) =>
  v.costCentreType !== 'project' || Boolean(v.projectId);
const projectMessage = { message: 'Select the project', path: ['projectId'] };

// ---------- Categories (FR-FIN-02) ----------

export const categoryQuerySchema = z.object({
  kind: z.enum(CATEGORY_KINDS).optional(),
  active: queryBoolean,
});
export type CategoryQuery = z.infer<typeof categoryQuerySchema>;

export const createCategorySchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(100),
  kind: z.enum(CATEGORY_KINDS),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---------- Transactions (FR-FIN-01, FR-FIN-10) ----------

const transactionFields = z.object({
  direction: z.enum(TRANSACTION_DIRECTIONS),
  transactionDate: z.iso.date(),
  amount: money,
  categoryId: z.coerce.number().int().positive({ message: 'Select a category' }),
  costCentreType: z.enum(COST_CENTRE_TYPES),
  projectId: optionalId,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  reference: optionalText(100),
  description: optionalText(2000),
  /** Link an expense to the loan that funded it (FR-FIN-07). */
  loanId: optionalId,
});

export const createTransactionSchema = transactionFields
  .extend({
    /** Set after the user has seen the duplicate-reference warning (US-OA-003 AC3). */
    confirmDuplicate: z.boolean().default(false),
  })
  .refine(projectRequired, projectMessage);
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const updateTransactionSchema = transactionFields
  .partial()
  .extend({ confirmDuplicate: z.boolean().default(false) })
  .refine((v) => v.costCentreType === undefined || projectRequired(v), projectMessage);
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

export const transactionListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  direction: z.enum(TRANSACTION_DIRECTIONS).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  loanId: z.coerce.number().int().positive().optional(),
  source: z.enum(TRANSACTION_SOURCES).optional(),
  sortBy: z.enum(['transactionDate', 'amount', 'createdAt']).optional(),
});
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

export const referenceQuerySchema = z.object({
  reference: z.string().trim().min(1).max(100),
  excludeId: z.coerce.number().int().positive().optional(),
});

// ---------- Budgets (FR-FIN-03..05) ----------

const budgetLineSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  amount: nonNegativeMoney,
});

const budgetFields = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(150),
  costCentreType: z.enum(COST_CENTRE_TYPES),
  projectId: optionalId,
  periodStart: z.iso.date().nullable().optional(),
  periodEnd: z.iso.date().nullable().optional(),
  amount: money,
  notes: optionalText(2000),
  lines: z.array(budgetLineSchema).max(100).optional(),
});

const periodRequired = <
  T extends { costCentreType?: string; periodStart?: string | null; periodEnd?: string | null },
>(
  v: T,
) => v.costCentreType === 'project' || Boolean(v.periodStart && v.periodEnd);
const periodOrdered = <T extends { periodStart?: string | null; periodEnd?: string | null }>(
  v: T,
) => !v.periodStart || !v.periodEnd || v.periodStart <= v.periodEnd;
const uniqueLines = <T extends { lines?: { categoryId: number }[] | undefined }>(v: T) =>
  !v.lines || new Set(v.lines.map((l) => l.categoryId)).size === v.lines.length;

export const createBudgetSchema = budgetFields
  .refine(projectRequired, projectMessage)
  .refine(periodRequired, {
    message: 'Farm and office budgets need a period',
    path: ['periodStart'],
  })
  .refine(periodOrdered, { message: 'The period ends before it starts', path: ['periodEnd'] })
  .refine(uniqueLines, { message: 'Each category can appear once', path: ['lines'] });
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = budgetFields
  .omit({ costCentreType: true, projectId: true })
  .partial()
  .refine(periodOrdered, { message: 'The period ends before it starts', path: ['periodEnd'] })
  .refine(uniqueLines, { message: 'Each category can appear once', path: ['lines'] });
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

export const budgetListQuerySchema = listQuerySchema.extend({
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  /** Only budgets whose period includes this date (farm/office) or open projects. */
  current: queryBoolean,
  sortBy: z.enum(['name', 'amount', 'createdAt', 'periodStart']).optional(),
});
export type BudgetListQuery = z.infer<typeof budgetListQuerySchema>;

// ---------- Loans (FR-FIN-06/07, BRL-06) ----------

const loanFields = z.object({
  lender: z.string().trim().min(2, 'Enter the lender').max(150),
  principal: money,
  interestRate: z.coerce.number().min(0).max(100),
  interestCharged: nonNegativeMoney,
  startDate: z.iso.date(),
  termMonths: z.coerce.number().int().positive().max(600).nullable().optional(),
  repaymentSchedule: optionalText(2000),
  purpose: optionalText(2000),
});

export const createLoanSchema = loanFields.extend({
  interestRate: loanFields.shape.interestRate.default(0),
  interestCharged: nonNegativeMoney.default(0),
});
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

/** No defaults here: a partial of a defaulted field would overwrite it on every PATCH. */
export const updateLoanSchema = loanFields
  .partial()
  .extend({ status: z.enum(LOAN_STATUSES).optional() });
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;

export const loanListQuerySchema = listQuerySchema.extend({
  status: z.enum(LOAN_STATUSES).optional(),
  sortBy: z.enum(['startDate', 'principal', 'lender', 'createdAt']).optional(),
});
export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

export const loanRepaymentSchema = z.object({
  paymentDate: z.iso.date(),
  amount: money,
  paymentMethod: z.enum(PAYMENT_METHODS),
  reference: optionalText(100),
  notes: optionalText(2000),
});
export type LoanRepaymentInput = z.infer<typeof loanRepaymentSchema>;

export const loanReceiptSchema = z.object({
  receivedDate: z.iso.date(),
  amount: money,
  paymentMethod: z.enum(PAYMENT_METHODS),
  reference: optionalText(100),
});
export type LoanReceiptInput = z.infer<typeof loanReceiptSchema>;

// ---------- Reports (FR-FIN-08, FR-FIN-09) ----------

export const profitLossQuerySchema = dateRangeSchema.extend({
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
});
export type ProfitLossQuery = z.infer<typeof profitLossQuerySchema>;

export const cashFlowQuerySchema = dateRangeSchema.extend({
  interval: z.enum(['day', 'week', 'month']).default('month'),
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
});
export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;

export const summaryQuerySchema = dateRangeSchema;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

// ---------- Books (day book, cash book, general ledger, trial balance, statements) ----------

export const BOOK_KEYS = [
  'day-book',
  'cash-book',
  'general-ledger',
  'trial-balance',
  'income-statement',
  'cash-flow-statement',
  'budget-vs-actual',
  'loan-register',
] as const;
export type BookKey = (typeof BOOK_KEYS)[number];

export const bookParamSchema = z.object({ book: z.enum(BOOK_KEYS) });

/** One filter set shared by every book; each book uses the fields that make sense for it. */
export const bookQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  /** `none` = entries recorded without a payment method. */
  paymentMethod: z.enum([...PAYMENT_METHODS, 'none']).optional(),
  direction: z.enum(TRANSACTION_DIRECTIONS).optional(),
  source: z.enum(TRANSACTION_SOURCES).optional(),
  recordedBy: z.coerce.number().int().positive().optional(),
  loanId: z.coerce.number().int().positive().optional(),
  interval: z.enum(['day', 'week', 'month']).default('month'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type BookQuery = z.infer<typeof bookQuerySchema>;

export const bookExportQuerySchema = bookQuerySchema.extend({ format: z.enum(['pdf', 'xlsx']) });
export type BookExportQuery = z.infer<typeof bookExportQuerySchema>;
