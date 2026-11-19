import { Router } from 'express';
import { authorize, can } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { registerDocumentEntity } from '../documents/document-registry.js';
import { exportBook } from './books.export.js';
import { booksService } from './books.service.js';
import { budgetService } from './budgets.service.js';
import { categoryService } from './categories.service.js';
import {
  bookExportQuerySchema,
  bookParamSchema,
  bookQuerySchema,
  type BookQuery,
  budgetListQuerySchema,
  cashFlowQuerySchema,
  categoryQuerySchema,
  createBudgetSchema,
  createCategorySchema,
  createLoanSchema,
  createTransactionSchema,
  loanListQuerySchema,
  loanReceiptSchema,
  loanRepaymentSchema,
  profitLossQuerySchema,
  referenceQuerySchema,
  summaryQuerySchema,
  transactionListQuerySchema,
  updateBudgetSchema,
  updateCategorySchema,
  updateLoanSchema,
  updateTransactionSchema,
} from './finance.schema.js';
import { loanService } from './loans.service.js';
import { financeReportService } from './reports.service.js';
import { transactionService } from './transactions.service.js';

// Receipts and invoices on ledger entries; loan agreements on loans (FR-DOC-02).
registerDocumentEntity('transaction', {
  label: 'Transaction',
  canRead: async (user, id) => can(user, P.FINANCE_VIEW) && transactionService.exists(id),
  canWrite: async (user, id) => can(user, P.FINANCE_MANAGE) && transactionService.exists(id),
});
registerDocumentEntity('loan', {
  label: 'Loan',
  canRead: async (user, id) => can(user, P.FINANCE_VIEW) && loanService.exists(id),
  canWrite: async (user, id) => can(user, P.FINANCE_MANAGE) && loanService.exists(id),
});

export const financeRouter = Router();
const MANAGE_OR_OVERRIDE = [P.FINANCE_MANAGE, P.FINANCE_OVERRIDE] as const;

// ---------- Overview & reports ----------

financeRouter.get(
  '/summary',
  authorize(P.FINANCE_VIEW),
  route({ query: summaryQuerySchema }, ({ query }) => financeReportService.summary(query)),
);

financeRouter.get(
  '/profit-loss',
  authorize(P.FINANCE_VIEW),
  route({ query: profitLossQuerySchema }, ({ query }) => financeReportService.profitLoss(query)),
);

financeRouter.get(
  '/cash-flow',
  authorize(P.FINANCE_VIEW),
  route({ query: cashFlowQuerySchema }, ({ query }) => financeReportService.cashFlow(query)),
);

// ---------- Categories (FR-FIN-02) ----------

/** Any signed-in user: the request form and other modules pick categories from this list. */
financeRouter.get(
  '/categories',
  route({ query: categoryQuerySchema }, ({ query }) => categoryService.list(query)),
);

financeRouter.post(
  '/categories',
  authorize(P.FINANCE_MANAGE),
  route({ body: createCategorySchema, status: 201 }, ({ body }) => categoryService.create(body)),
);

/** Rename or (de)activate; categories are never hard-deleted. */
financeRouter.patch(
  '/categories/:id',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, body: updateCategorySchema }, ({ params, body }) =>
    categoryService.update(params.id, body),
  ),
);

// ---------- Transactions (FR-FIN-01, FR-FIN-10) ----------

financeRouter.get(
  '/transactions',
  authorize(P.FINANCE_VIEW),
  route({ query: transactionListQuerySchema }, ({ query, user }) =>
    transactionService.list(user, query),
  ),
);

financeRouter.get(
  '/transactions/check-reference',
  authorize(P.FINANCE_VIEW),
  route({ query: referenceQuerySchema }, ({ query }) =>
    transactionService.checkReference(query.reference, query.excludeId),
  ),
);

financeRouter.get(
  '/transactions/:id',
  authorize(P.FINANCE_VIEW),
  route({ params: idParamSchema }, ({ params, user }) => transactionService.get(user, params.id)),
);

financeRouter.post(
  '/transactions',
  authorize(P.FINANCE_MANAGE),
  route({ body: createTransactionSchema, status: 201 }, ({ body, user }) =>
    transactionService.create(user, body),
  ),
);

/** 24 h lock and source checks are applied per record in the service (BRL-09). */
financeRouter.patch(
  '/transactions/:id',
  authorize(MANAGE_OR_OVERRIDE, 'any'),
  route({ params: idParamSchema, body: updateTransactionSchema }, ({ params, body, user }) =>
    transactionService.update(user, params.id, body),
  ),
);

financeRouter.delete(
  '/transactions/:id',
  authorize(MANAGE_OR_OVERRIDE, 'any'),
  route({ params: idParamSchema, status: 204 }, ({ params, user }) =>
    transactionService.remove(user, params.id),
  ),
);

// ---------- Budgets (FR-FIN-03..05) ----------

financeRouter.get(
  '/budgets',
  authorize(P.FINANCE_VIEW),
  route({ query: budgetListQuerySchema }, ({ query }) => budgetService.list(query)),
);

financeRouter.get(
  '/budgets/:id',
  authorize(P.FINANCE_VIEW),
  route({ params: idParamSchema }, ({ params }) => budgetService.get(params.id)),
);

financeRouter.post(
  '/budgets',
  authorize(P.FINANCE_MANAGE),
  route({ body: createBudgetSchema, status: 201 }, ({ body, user }) =>
    budgetService.create(user, body),
  ),
);

financeRouter.patch(
  '/budgets/:id',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, body: updateBudgetSchema }, ({ params, body }) =>
    budgetService.update(params.id, body),
  ),
);

financeRouter.delete(
  '/budgets/:id',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) => budgetService.remove(params.id)),
);

// ---------- Loans (FR-FIN-06/07, BRL-06) ----------

financeRouter.get(
  '/loans',
  authorize(P.FINANCE_VIEW),
  route({ query: loanListQuerySchema }, ({ query }) => loanService.list(query)),
);

financeRouter.get(
  '/loans/:id',
  authorize(P.FINANCE_VIEW),
  route({ params: idParamSchema }, ({ params }) => loanService.get(params.id)),
);

financeRouter.post(
  '/loans',
  authorize(P.FINANCE_MANAGE),
  route({ body: createLoanSchema, status: 201 }, ({ body, user }) =>
    loanService.create(user, body),
  ),
);

financeRouter.patch(
  '/loans/:id',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, body: updateLoanSchema }, ({ params, body }) =>
    loanService.update(params.id, body),
  ),
);

financeRouter.delete(
  '/loans/:id',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) => loanService.remove(params.id)),
);

financeRouter.post(
  '/loans/:id/repayments',
  authorize(P.FINANCE_MANAGE),
  route(
    { params: idParamSchema, body: loanRepaymentSchema, status: 201 },
    ({ params, body, user }) => loanService.recordRepayment(user, params.id, body),
  ),
);

/** Money received from the lender (cash in, not income). */
financeRouter.post(
  '/loans/:id/receipts',
  authorize(P.FINANCE_MANAGE),
  route({ params: idParamSchema, body: loanReceiptSchema, status: 201 }, ({ params, body, user }) =>
    loanService.recordReceipt(user, params.id, body),
  ),
);

// ---------- Books: day book, cash book, ledger, trial balance, statements ----------

financeRouter.get(
  '/books/day-book',
  authorize(P.FINANCE_VIEW),
  route({ query: bookQuerySchema }, ({ query }) => booksService.dayBook(query)),
);

const BOOK_HANDLERS: Record<string, (query: BookQuery) => Promise<unknown>> = {
  'cash-book': (q) => booksService.cashBook(q),
  'general-ledger': (q) => booksService.generalLedger(q),
  'trial-balance': (q) => booksService.trialBalance(q),
  'income-statement': (q) => booksService.incomeStatement(q),
  'cash-flow-statement': (q) => booksService.cashFlowStatement(q),
  'budget-vs-actual': (q) => booksService.budgetVsActual(q),
  'loan-register': () => booksService.loanRegister(),
};

for (const [book, handler] of Object.entries(BOOK_HANDLERS)) {
  financeRouter.get(
    `/books/${book}`,
    authorize(P.FINANCE_VIEW),
    route({ query: bookQuerySchema }, ({ query }) => handler(query)),
  );
}

/** Excel / PDF download of any book (FR-RPT-03). */
financeRouter.get(
  '/books/:book/export',
  authorize(P.FINANCE_VIEW),
  route({ params: bookParamSchema, query: bookExportQuerySchema }, ({ params, query, res }) =>
    exportBook(params.book, query, res),
  ),
);
