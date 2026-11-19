import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
  date,
  mediumtext,
} from 'drizzle-orm/mysql-core';
import { CUSTOMER_TYPES, INTERACTION_TYPES, LEAD_STAGES } from '../enums.js';
import { createdAt, dateTime, id, money, ref, softDelete, timestamps } from './_columns.js';
import { users } from './auth.js';
import { projects } from './projects.js';

export const customers = mysqlTable(
  'customers',
  {
    id: id(),
    name: varchar('name', { length: 191 }).notNull(),
    type: mysqlEnum('type', CUSTOMER_TYPES).notNull().default('company'),
    email: varchar('email', { length: 191 }),
    phone: varchar('phone', { length: 30 }),
    address: varchar('address', { length: 255 }),
    notes: mediumtext('notes'),
    createdBy: ref('created_by').references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('customers_name_idx').on(t.name)],
);

export const customerContacts = mysqlTable('customer_contacts', {
  id: id(),
  customerId: ref('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  position: varchar('position', { length: 100 }),
  phone: varchar('phone', { length: 30 }),
  email: varchar('email', { length: 191 }),
  createdAt: createdAt(),
});

/** Business opportunities (FR-BDV-01..04). */
export const leads = mysqlTable(
  'leads',
  {
    id: id(),
    title: varchar('title', { length: 191 }).notNull(),
    companyName: varchar('company_name', { length: 191 }).notNull(),
    contactName: varchar('contact_name', { length: 150 }),
    contactPhone: varchar('contact_phone', { length: 30 }),
    contactEmail: varchar('contact_email', { length: 191 }),
    source: varchar('source', { length: 100 }),
    estimatedValue: money('estimated_value').notNull().default(0),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    stage: mysqlEnum('stage', LEAD_STAGES).notNull().default('new'),
    lostReason: text('lost_reason'),
    ownerId: ref('owner_id')
      .notNull()
      .references(() => users.id),
    followUpDate: date('follow_up_date', { mode: 'string' }),
    followUpNotifiedAt: dateTime('follow_up_notified_at'),
    customerId: ref('customer_id').references(() => customers.id),
    projectId: ref('project_id').references(() => projects.id),
    convertedAt: dateTime('converted_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('leads_stage_idx').on(t.stage), index('leads_owner_idx').on(t.ownerId)],
);

export const interactions = mysqlTable(
  'interactions',
  {
    id: id(),
    customerId: ref('customer_id').references(() => customers.id),
    leadId: ref('lead_id').references(() => leads.id),
    type: mysqlEnum('type', INTERACTION_TYPES).notNull(),
    summary: mediumtext('summary').notNull(),
    occurredAt: dateTime('occurred_at').notNull(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('interactions_customer_idx').on(t.customerId)],
);

/** Sales records (FR-BDV-06). */
export const sales = mysqlTable(
  'sales',
  {
    id: id(),
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id),
    projectId: ref('project_id').references(() => projects.id),
    amount: money('amount').notNull(),
    saleDate: date('sale_date', { mode: 'string' }).notNull(),
    description: text('description'),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('sales_date_idx').on(t.saleDate)],
);

/** Customer satisfaction after project completion (FR-BDV-08). */
export const satisfactionRatings = mysqlTable(
  'satisfaction_ratings',
  {
    id: id(),
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id),
    customerId: ref('customer_id').references(() => customers.id),
    rating: tinyint('rating').notNull(),
    comment: text('comment'),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('satisfaction_project_uq').on(t.projectId)],
);
