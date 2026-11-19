import {
  boolean,
  date,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  PAYMENT_METHODS,
  REQUEST_EVENT_ACTIONS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
} from '../enums.js';
import {
  costCentreType,
  createdAt,
  dateTime,
  id,
  money,
  ref,
  softDelete,
  timestamps,
} from './_columns.js';
import { users } from './auth.js';
import { categories, transactions } from './finance.js';
import { projects } from './projects.js';

/** Funding and purchase requests (SRS 3.2). */
export const requests = mysqlTable(
  'requests',
  {
    id: id(),
    reference: varchar('reference', { length: 20 }).notNull(),
    type: mysqlEnum('type', REQUEST_TYPES).notNull(),
    requesterId: ref('requester_id')
      .notNull()
      .references(() => users.id),
    amount: money('amount').notNull(),
    purpose: text('purpose').notNull(),
    categoryId: ref('category_id').references(() => categories.id),
    costCentreType: costCentreType().notNull(),
    projectId: ref('project_id').references(() => projects.id),
    neededBy: date('needed_by', { mode: 'string' }),
    status: mysqlEnum('status', REQUEST_STATUSES).notNull().default('submitted'),
    /** Set when approval would push the project over budget (FR-REQ-10). */
    exceedsBudget: boolean('exceeds_budget').notNull().default(false),
    rejectionReason: text('rejection_reason'),
    decidedBy: ref('decided_by').references(() => users.id),
    decidedAt: dateTime('decided_at'),
    paidAmount: money('paid_amount'),
    paidOn: date('paid_on', { mode: 'string' }),
    paymentMethod: mysqlEnum('payment_method', PAYMENT_METHODS),
    paymentReference: varchar('payment_reference', { length: 100 }),
    disbursedBy: ref('disbursed_by').references(() => users.id),
    transactionId: ref('transaction_id').references(() => transactions.id),
    /** Last time an "approval waiting > 24h" escalation was sent (FR-NTF-03). */
    escalatedAt: dateTime('escalated_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('requests_reference_uq').on(t.reference),
    index('requests_status_idx').on(t.status),
    index('requests_requester_idx').on(t.requesterId),
    index('requests_cost_centre_idx').on(t.costCentreType, t.projectId),
  ],
);

/** Full, append-only history of a request (FR-REQ-09). */
export const requestEvents = mysqlTable(
  'request_events',
  {
    id: id(),
    requestId: ref('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    actorId: ref('actor_id')
      .notNull()
      .references(() => users.id),
    action: mysqlEnum('action', REQUEST_EVENT_ACTIONS).notNull(),
    fromStatus: mysqlEnum('from_status', REQUEST_STATUSES),
    toStatus: mysqlEnum('to_status', REQUEST_STATUSES),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [index('request_events_request_idx').on(t.requestId)],
);
