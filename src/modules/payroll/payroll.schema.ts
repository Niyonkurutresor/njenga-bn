import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination.js';
import {
  COST_CENTRE_TYPES,
  PAYMENT_METHODS,
  RUN_STATUSES,
  USER_STATUSES,
  WORK_SITE_TYPES,
} from '../../db/enums.js';

const amount = z.coerce
  .number()
  .min(0, 'Cannot be negative')
  .max(1_000_000_000)
  .transform((v) => Math.round(v * 100) / 100);

const optionalId = z.coerce.number().int().positive().nullable().optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM');

// ---------- Employees (FR-PAY-01) ----------

const employeeFields = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(150),
  userId: optionalId,
  jobTitle: optionalText(100),
  department: optionalText(100),
  phone: optionalText(30),
  nationalId: optionalText(40),
  bankAccount: optionalText(60),
  basicSalary: amount,
  allowances: amount,
  deductions: amount,
  hireDate: z.iso.date().nullable().optional(),
  costCentreType: z.enum(COST_CENTRE_TYPES),
  projectId: optionalId,
  status: z.enum(USER_STATUSES),
});

const projectRequired = <T extends { costCentreType?: string; projectId?: number | null }>(v: T) =>
  v.costCentreType !== 'project' || Boolean(v.projectId);
const projectMessage = { message: 'Select the project', path: ['projectId'] };

export const createEmployeeSchema = employeeFields
  .extend({
    allowances: amount.default(0),
    deductions: amount.default(0),
    costCentreType: z.enum(COST_CENTRE_TYPES).default('office'),
    status: z.enum(USER_STATUSES).default('active'),
  })
  .refine(projectRequired, projectMessage);
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = employeeFields
  .partial()
  .refine((v) => v.costCentreType === undefined || projectRequired(v), projectMessage);
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const employeeListQuerySchema = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  costCentreType: z.enum(COST_CENTRE_TYPES).optional(),
  department: z.string().trim().max(100).optional(),
  sortBy: z.enum(['fullName', 'basicSalary', 'hireDate', 'createdAt']).optional(),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

// ---------- Payroll runs (FR-PAY-02, FR-PAY-06) ----------

export const createPayrollRunSchema = z.object({ period: periodSchema });

export const runListQuerySchema = listQuerySchema.extend({
  status: z.enum(RUN_STATUSES).optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export const runItemParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

export const updatePayrollItemSchema = z.object({
  basicSalary: amount.optional(),
  allowances: amount.optional(),
  deductions: amount.optional(),
});
export type UpdatePayrollItemInput = z.infer<typeof updatePayrollItemSchema>;

export const payRunSchema = z.object({
  paidOn: z.iso.date(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** Bank batch / mobile-money bulk reference; each transaction gets `<reference>` + item suffix. */
  reference: optionalText(80),
});
export type PayRunInput = z.infer<typeof payRunSchema>;

// ---------- Casual workers (FR-PAY-03) ----------

const workerFields = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(150),
  nationalId: z.string().trim().min(4, 'Enter the ID number').max(40),
  phone: optionalText(30),
  dailyRate: z.coerce
    .number()
    .positive('Daily rate must be greater than zero')
    .max(10_000_000)
    .transform((v) => Math.round(v * 100) / 100),
  siteType: z.enum(WORK_SITE_TYPES).default('farm'),
  projectId: optionalId,
  status: z.enum(USER_STATUSES).default('active'),
});

export const createWorkerSchema = workerFields.refine(
  (v) => v.siteType !== 'project' || Boolean(v.projectId),
  projectMessage,
);
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;

export const updateWorkerSchema = z
  .object({
    fullName: workerFields.shape.fullName.optional(),
    nationalId: workerFields.shape.nationalId.optional(),
    phone: workerFields.shape.phone,
    dailyRate: workerFields.shape.dailyRate.optional(),
    siteType: z.enum(WORK_SITE_TYPES).optional(),
    projectId: optionalId,
    status: z.enum(USER_STATUSES).optional(),
  })
  .refine((v) => v.siteType !== 'project' || Boolean(v.projectId), projectMessage);
export type UpdateWorkerInput = z.infer<typeof updateWorkerSchema>;

export const workerListQuerySchema = listQuerySchema.extend({
  siteType: z.enum(WORK_SITE_TYPES).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  status: z.enum(USER_STATUSES).optional(),
  sortBy: z.enum(['fullName', 'dailyRate', 'createdAt']).optional(),
});
export type WorkerListQuery = z.infer<typeof workerListQuerySchema>;

// ---------- Attendance (FR-PAY-04, US-FM-004) ----------

export const attendanceQuerySchema = z.object({
  date: z.iso.date(),
  siteType: z.enum(WORK_SITE_TYPES).default('farm'),
  projectId: z.coerce.number().int().positive().optional(),
});
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

export const saveAttendanceSchema = z.object({
  date: z.iso.date(),
  entries: z
    .array(z.object({ workerId: z.coerce.number().int().positive(), present: z.boolean() }))
    .min(1, 'Mark at least one worker')
    .max(500)
    .refine((e) => new Set(e.map((x) => x.workerId)).size === e.length, 'Duplicate worker'),
});
export type SaveAttendanceInput = z.infer<typeof saveAttendanceSchema>;

// ---------- Casual pay runs (FR-PAY-05, BRL-05) ----------

export const createCasualRunSchema = z
  .object({
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    siteType: z.enum(WORK_SITE_TYPES).optional(),
    projectId: z.coerce.number().int().positive().optional(),
  })
  .refine((v) => v.periodStart <= v.periodEnd, {
    message: 'The period ends before it starts',
    path: ['periodEnd'],
  })
  .refine((v) => !v.projectId || v.siteType === 'project', {
    message: 'A project can only be chosen for project sites',
    path: ['projectId'],
  });
export type CreateCasualRunInput = z.infer<typeof createCasualRunSchema>;
