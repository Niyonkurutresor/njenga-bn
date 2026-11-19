import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize.js';
import { route } from '../../common/http/route.js';
import { idParamSchema } from '../../common/http/pagination.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { casualPayService } from './casual-pay.service.js';
import { casualWorkerService } from './casual-workers.service.js';
import { employeeService } from './employees.service.js';
import { payrollRunService } from './payroll-runs.service.js';
import {
  attendanceQuerySchema,
  createCasualRunSchema,
  createEmployeeSchema,
  createPayrollRunSchema,
  createWorkerSchema,
  employeeListQuerySchema,
  payRunSchema,
  runItemParamsSchema,
  runListQuerySchema,
  saveAttendanceSchema,
  updateEmployeeSchema,
  updatePayrollItemSchema,
  updateWorkerSchema,
  workerListQuerySchema,
} from './payroll.schema.js';

export const payrollRouter = Router();

/** Who may see the casual-worker register: managers, attendance takers and payroll viewers. */
/** Salary and casual-pay runs are money records: finance viewers see them too. */
const RUN_READERS = [P.PAYROLL_VIEW, P.FINANCE_VIEW] as const;

const WORKER_READERS = [P.CASUAL_WORKERS_MANAGE, P.ATTENDANCE_RECORD, P.PAYROLL_VIEW] as const;

// ---------- Employees (FR-PAY-01) ----------

payrollRouter.get(
  '/employees',
  authorize(P.PAYROLL_VIEW),
  route({ query: employeeListQuerySchema }, ({ query }) => employeeService.list(query)),
);

payrollRouter.get(
  '/employees/:id',
  authorize(P.PAYROLL_VIEW),
  route({ params: idParamSchema }, ({ params }) => employeeService.get(params.id)),
);

payrollRouter.post(
  '/employees',
  authorize(P.PAYROLL_MANAGE),
  route({ body: createEmployeeSchema, status: 201 }, ({ body }) => employeeService.create(body)),
);

payrollRouter.patch(
  '/employees/:id',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, body: updateEmployeeSchema }, ({ params, body }) =>
    employeeService.update(params.id, body),
  ),
);

payrollRouter.delete(
  '/employees/:id',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) => employeeService.remove(params.id)),
);

// ---------- Monthly payroll runs (FR-PAY-02, FR-PAY-06) ----------

payrollRouter.get(
  '/runs',
  authorize(RUN_READERS, 'any'),
  route({ query: runListQuerySchema }, ({ query }) => payrollRunService.list(query)),
);

payrollRouter.get(
  '/runs/:id',
  authorize(RUN_READERS, 'any'),
  route({ params: idParamSchema }, ({ params }) => payrollRunService.get(params.id)),
);

payrollRouter.post(
  '/runs',
  authorize(P.PAYROLL_MANAGE),
  route({ body: createPayrollRunSchema, status: 201 }, ({ body, user }) =>
    payrollRunService.generate(user, body.period),
  ),
);

payrollRouter.patch(
  '/runs/:id/items/:itemId',
  authorize(P.PAYROLL_MANAGE),
  route({ params: runItemParamsSchema, body: updatePayrollItemSchema }, ({ params, body }) =>
    payrollRunService.updateItem(params.id, params.itemId, body),
  ),
);

payrollRouter.delete(
  '/runs/:id/items/:itemId',
  authorize(P.PAYROLL_MANAGE),
  route({ params: runItemParamsSchema }, ({ params }) =>
    payrollRunService.removeItem(params.id, params.itemId),
  ),
);

payrollRouter.post(
  '/runs/:id/pay',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, body: payRunSchema }, ({ params, body, user }) =>
    payrollRunService.pay(user, params.id, body),
  ),
);

payrollRouter.delete(
  '/runs/:id',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) =>
    payrollRunService.remove(params.id),
  ),
);

// ---------- Casual workers (FR-PAY-03) ----------

payrollRouter.get(
  '/casual-workers',
  authorize(WORKER_READERS, 'any'),
  route({ query: workerListQuerySchema }, ({ query }) => casualWorkerService.list(query)),
);

payrollRouter.get(
  '/casual-workers/:id',
  authorize(WORKER_READERS, 'any'),
  route({ params: idParamSchema }, ({ params }) => casualWorkerService.get(params.id)),
);

payrollRouter.post(
  '/casual-workers',
  authorize(P.CASUAL_WORKERS_MANAGE),
  route({ body: createWorkerSchema, status: 201 }, ({ body }) => casualWorkerService.create(body)),
);

payrollRouter.patch(
  '/casual-workers/:id',
  authorize(P.CASUAL_WORKERS_MANAGE),
  route({ params: idParamSchema, body: updateWorkerSchema }, ({ params, body }) =>
    casualWorkerService.update(params.id, body),
  ),
);

payrollRouter.delete(
  '/casual-workers/:id',
  authorize(P.CASUAL_WORKERS_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) =>
    casualWorkerService.remove(params.id),
  ),
);

// ---------- Attendance (FR-PAY-04, FR-FRM-04, US-FM-004) ----------

payrollRouter.get(
  '/attendance',
  authorize([P.ATTENDANCE_RECORD, P.PAYROLL_VIEW], 'any'),
  route({ query: attendanceQuerySchema }, ({ query }) =>
    casualWorkerService.attendanceSheet(query),
  ),
);

payrollRouter.put(
  '/attendance',
  authorize(P.ATTENDANCE_RECORD),
  route({ body: saveAttendanceSchema }, ({ body, user }) =>
    casualWorkerService.saveAttendance(user, body),
  ),
);

// ---------- Casual pay runs (FR-PAY-05, BRL-05, US-OA-007) ----------

payrollRouter.get(
  '/casual-runs',
  authorize(RUN_READERS, 'any'),
  route({ query: runListQuerySchema }, ({ query }) => casualPayService.list(query)),
);

payrollRouter.get(
  '/casual-runs/:id',
  authorize(RUN_READERS, 'any'),
  route({ params: idParamSchema }, ({ params }) => casualPayService.get(params.id)),
);

payrollRouter.post(
  '/casual-runs',
  authorize(P.PAYROLL_MANAGE),
  route({ body: createCasualRunSchema, status: 201 }, ({ body, user }) =>
    casualPayService.generate(user, body),
  ),
);

payrollRouter.delete(
  '/casual-runs/:id/items/:itemId',
  authorize(P.PAYROLL_MANAGE),
  route({ params: runItemParamsSchema }, ({ params }) =>
    casualPayService.removeItem(params.id, params.itemId),
  ),
);

payrollRouter.post(
  '/casual-runs/:id/pay',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, body: payRunSchema }, ({ params, body, user }) =>
    casualPayService.pay(user, params.id, body),
  ),
);

payrollRouter.delete(
  '/casual-runs/:id',
  authorize(P.PAYROLL_MANAGE),
  route({ params: idParamSchema, status: 204 }, ({ params }) => casualPayService.remove(params.id)),
);
