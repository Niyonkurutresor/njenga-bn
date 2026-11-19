import {
  boolean,
  date,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { RUN_STATUSES, USER_STATUSES, WORK_SITE_TYPES } from '../enums.js';
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
import { transactions } from './finance.js';
import { projects } from './projects.js';

/** Permanent staff and their salary details (FR-PAY-01). */
export const employees = mysqlTable(
  'employees',
  {
    id: id(),
    userId: ref('user_id').references(() => users.id),
    fullName: varchar('full_name', { length: 150 }).notNull(),
    jobTitle: varchar('job_title', { length: 100 }),
    department: varchar('department', { length: 100 }),
    phone: varchar('phone', { length: 30 }),
    nationalId: varchar('national_id', { length: 40 }),
    bankAccount: varchar('bank_account', { length: 60 }),
    basicSalary: money('basic_salary').notNull().default(0),
    allowances: money('allowances').notNull().default(0),
    deductions: money('deductions').notNull().default(0),
    hireDate: date('hire_date', { mode: 'string' }),
    /** Where salary cost is charged (FR-PAY-06). */
    costCentreType: costCentreType().notNull().default('office'),
    projectId: ref('project_id').references(() => projects.id),
    status: mysqlEnum('status', USER_STATUSES).notNull().default('active'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [uniqueIndex('employees_user_uq').on(t.userId)],
);

/** Monthly payroll (FR-PAY-02). `period` is YYYY-MM. */
export const payrollRuns = mysqlTable(
  'payroll_runs',
  {
    id: id(),
    period: varchar('period', { length: 7 }).notNull(),
    status: mysqlEnum('status', RUN_STATUSES).notNull().default('draft'),
    totalNet: money('total_net').notNull().default(0),
    createdBy: ref('created_by')
      .notNull()
      .references(() => users.id),
    paidBy: ref('paid_by').references(() => users.id),
    paidAt: dateTime('paid_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('payroll_runs_period_uq').on(t.period)],
);

export const payrollItems = mysqlTable(
  'payroll_items',
  {
    id: id(),
    runId: ref('run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'cascade' }),
    employeeId: ref('employee_id')
      .notNull()
      .references(() => employees.id),
    basicSalary: money('basic_salary').notNull(),
    allowances: money('allowances').notNull(),
    deductions: money('deductions').notNull(),
    netPay: money('net_pay').notNull(),
    transactionId: ref('transaction_id').references(() => transactions.id),
  },
  (t) => [uniqueIndex('payroll_items_uq').on(t.runId, t.employeeId)],
);

/** Casual workers paid per day (FR-PAY-03). */
export const casualWorkers = mysqlTable(
  'casual_workers',
  {
    id: id(),
    fullName: varchar('full_name', { length: 150 }).notNull(),
    nationalId: varchar('national_id', { length: 40 }).notNull(),
    phone: varchar('phone', { length: 30 }),
    dailyRate: money('daily_rate').notNull(),
    siteType: mysqlEnum('site_type', WORK_SITE_TYPES).notNull().default('farm'),
    projectId: ref('project_id').references(() => projects.id),
    status: mysqlEnum('status', USER_STATUSES).notNull().default('active'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [uniqueIndex('casual_workers_nid_uq').on(t.nationalId)],
);

/** Daily attendance (FR-PAY-04, FR-FRM-04). One row per worker per day. */
export const attendance = mysqlTable(
  'attendance',
  {
    id: id(),
    workerId: ref('worker_id')
      .notNull()
      .references(() => casualWorkers.id),
    workDate: date('work_date', { mode: 'string' }).notNull(),
    siteType: mysqlEnum('site_type', WORK_SITE_TYPES).notNull(),
    projectId: ref('project_id').references(() => projects.id),
    present: boolean('present').notNull(),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attendance_worker_date_uq').on(t.workerId, t.workDate),
    index('attendance_date_idx').on(t.workDate),
  ],
);

/** Casual worker pay for a period: days present × daily rate (BRL-05). */
export const casualPayRuns = mysqlTable('casual_pay_runs', {
  id: id(),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  periodEnd: date('period_end', { mode: 'string' }).notNull(),
  status: mysqlEnum('status', RUN_STATUSES).notNull().default('draft'),
  total: money('total').notNull().default(0),
  createdBy: ref('created_by')
    .notNull()
    .references(() => users.id),
  paidBy: ref('paid_by').references(() => users.id),
  paidAt: dateTime('paid_at'),
  ...timestamps(),
});

export const casualPayItems = mysqlTable(
  'casual_pay_items',
  {
    id: id(),
    runId: ref('run_id')
      .notNull()
      .references(() => casualPayRuns.id, { onDelete: 'cascade' }),
    workerId: ref('worker_id')
      .notNull()
      .references(() => casualWorkers.id),
    daysPresent: int('days_present').notNull(),
    dailyRate: money('daily_rate').notNull(),
    amount: money('amount').notNull(),
    transactionId: ref('transaction_id').references(() => transactions.id),
    /** Kept so the run can be audited even if the worker's site changes later. */
    siteType: mysqlEnum('site_type', WORK_SITE_TYPES).notNull(),
    projectId: ref('project_id').references(() => projects.id),
    paid: boolean('paid').notNull().default(false),
  },
  (t) => [uniqueIndex('casual_pay_items_uq').on(t.runId, t.workerId)],
);
