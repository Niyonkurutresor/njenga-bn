import {
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
import { PRIORITIES, PROJECT_STATUSES, TASK_STATUSES } from '../enums.js';
import { createdAt, dateTime, id, money, ref, softDelete, timestamps } from './_columns.js';
import { users } from './auth.js';
import { customers } from './crm.js';

export interface ProfitLossSnapshot {
  contractValue: number;
  budgetTotal: number;
  actualCost: number;
  profit: number;
  marginPct: number | null;
  byCategory: { categoryId: number | null; category: string; budgeted: number; actual: number }[];
  generatedAt: string;
}

export const projects = mysqlTable(
  'projects',
  {
    id: id(),
    code: varchar('code', { length: 20 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    customerId: ref('customer_id').references(() => customers.id),
    clientName: varchar('client_name', { length: 191 }),
    location: varchar('location', { length: 191 }),
    contractValue: money('contract_value').notNull().default(0),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    status: mysqlEnum('status', PROJECT_STATUSES).notNull().default('created'),
    projectLeadId: ref('project_lead_id').references(() => users.id),
    description: mediumtext('description'),
    completedAt: dateTime('completed_at'),
    closedAt: dateTime('closed_at'),
    /** Frozen profit/loss analysis produced on completion (FR-PRJ-08, BRL-07). */
    plSnapshot: json('pl_snapshot').$type<ProfitLossSnapshot | null>(),
    createdBy: ref('created_by').references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [uniqueIndex('projects_code_uq').on(t.code), index('projects_status_idx').on(t.status)],
);

/** Project team (FR-PRJ-04). */
export const projectMembers = mysqlTable(
  'project_members',
  {
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    assignedBy: ref('assigned_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const projectStatusHistory = mysqlTable(
  'project_status_history',
  {
    id: id(),
    projectId: ref('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromStatus: mysqlEnum('from_status', PROJECT_STATUSES),
    toStatus: mysqlEnum('to_status', PROJECT_STATUSES).notNull(),
    changedBy: ref('changed_by').references(() => users.id),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('psh_project_idx').on(t.projectId)],
);

/** Tasks (SRS 3.6). `projectId` is optional so farm/office work can be tracked too. */
export const tasks = mysqlTable(
  'tasks',
  {
    id: id(),
    projectId: ref('project_id').references(() => projects.id),
    title: varchar('title', { length: 191 }).notNull(),
    description: text('description'),
    assigneeId: ref('assignee_id')
      .notNull()
      .references(() => users.id),
    createdBy: ref('created_by')
      .notNull()
      .references(() => users.id),
    priority: mysqlEnum('priority', PRIORITIES).notNull().default('medium'),
    deadline: date('deadline', { mode: 'string' }),
    status: mysqlEnum('status', TASK_STATUSES).notNull().default('not_started'),
    completedAt: dateTime('completed_at'),
    meetingActionPointId: ref('meeting_action_point_id'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('tasks_assignee_idx').on(t.assigneeId, t.status),
    index('tasks_project_idx').on(t.projectId),
  ],
);
