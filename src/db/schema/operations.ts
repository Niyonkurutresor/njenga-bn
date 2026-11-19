import {
  boolean,
  date,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
  mediumtext,
} from 'drizzle-orm/mysql-core';
import { MEETING_STATUSES, REPORT_REQUEST_STATUSES, STOCK_MOVEMENT_TYPES } from '../enums.js';
import {
  costCentreType,
  createdAt,
  dateTime,
  id,
  money,
  quantity,
  ref,
  softDelete,
  timestamps,
} from './_columns.js';
import { users } from './auth.js';
import { projects, tasks } from './projects.js';

// ---------------- Inventory & procurement (SRS 3.10) ----------------

export const materials = mysqlTable(
  'materials',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    sku: varchar('sku', { length: 60 }),
    unit: varchar('unit', { length: 20 }).notNull(),
    quantityOnHand: quantity('quantity_on_hand').notNull().default(0),
    reorderLevel: quantity('reorder_level').notNull().default(0),
    /** Weighted average unit cost, used to cost issues. */
    averageUnitCost: money('average_unit_cost').notNull().default(0),
    lowStockNotifiedAt: dateTime('low_stock_notified_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [uniqueIndex('materials_sku_uq').on(t.sku)],
);

export const stockMovements = mysqlTable(
  'stock_movements',
  {
    id: id(),
    materialId: ref('material_id')
      .notNull()
      .references(() => materials.id),
    type: mysqlEnum('type', STOCK_MOVEMENT_TYPES).notNull(),
    /** Positive for receipts, negative for issues; adjustments can be either. */
    quantity: quantity('quantity').notNull(),
    unitCost: money('unit_cost').notNull().default(0),
    totalCost: money('total_cost').notNull().default(0),
    supplier: varchar('supplier', { length: 150 }),
    isImported: boolean('is_imported').notNull().default(false),
    shipmentReference: varchar('shipment_reference', { length: 100 }),
    /** Destination of an issue (project or farm). */
    costCentreType: costCentreType(),
    projectId: ref('project_id').references(() => projects.id),
    movementDate: date('movement_date', { mode: 'string' }).notNull(),
    notes: text('notes'),
    transactionId: ref('transaction_id'),
    performedBy: ref('performed_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('stock_movements_material_idx').on(t.materialId, t.movementDate)],
);

// ---------------- Meetings (SRS 3.11) ----------------

export const meetings = mysqlTable(
  'meetings',
  {
    id: id(),
    title: varchar('title', { length: 191 }).notNull(),
    startsAt: dateTime('starts_at').notNull(),
    endsAt: dateTime('ends_at'),
    location: varchar('location', { length: 191 }),
    link: varchar('link', { length: 500 }),
    agenda: mediumtext('agenda'),
    minutes: mediumtext('minutes'),
    status: mysqlEnum('status', MEETING_STATUSES).notNull().default('scheduled'),
    organizerId: ref('organizer_id')
      .notNull()
      .references(() => users.id),
    reminderSentAt: dateTime('reminder_sent_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('meetings_starts_idx').on(t.startsAt)],
);

export const meetingParticipants = mysqlTable(
  'meeting_participants',
  {
    meetingId: ref('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.userId] })],
);

/** Action points; can be turned into tasks (FR-MTG-03). */
export const meetingActionPoints = mysqlTable('meeting_action_points', {
  id: id(),
  meetingId: ref('meeting_id')
    .notNull()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  assigneeId: ref('assignee_id').references(() => users.id),
  dueDate: date('due_date', { mode: 'string' }),
  taskId: ref('task_id').references(() => tasks.id),
  createdAt: createdAt(),
});

// ---------------- Reports (SRS 3.13) ----------------

/** Director requests for additional reports, tracked until delivered (FR-RPT-04). */
export const reportRequests = mysqlTable(
  'report_requests',
  {
    id: id(),
    requestedBy: ref('requested_by')
      .notNull()
      .references(() => users.id),
    assigneeId: ref('assignee_id')
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 191 }).notNull(),
    description: mediumtext('description'),
    dueDate: date('due_date', { mode: 'string' }),
    status: mysqlEnum('status', REPORT_REQUEST_STATUSES).notNull().default('open'),
    response: mediumtext('response'),
    deliveredAt: dateTime('delivered_at'),
    ...timestamps(),
  },
  (t) => [index('report_requests_assignee_idx').on(t.assigneeId, t.status)],
);

/** Snapshot of the automatically generated daily financial report (FR-RPT-02). */
export const dailyFinancialReports = mysqlTable(
  'daily_financial_reports',
  {
    id: id(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    data: json('data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('dfr_date_uq').on(t.reportDate)],
);
