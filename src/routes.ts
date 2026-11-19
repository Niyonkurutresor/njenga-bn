import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { authenticate } from './common/middleware/authenticate.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { crmRouter } from './modules/crm/crm.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { farmRouter } from './modules/farm/farm.routes.js';
import { fieldRouter } from './modules/field/field.routes.js';
import { financeRouter } from './modules/finance/finance.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { meetingsRouter } from './modules/meetings/meetings.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { payrollRouter } from './modules/payroll/payroll.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { requestsRouter } from './modules/requests/requests.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export const apiRouter = Router();

/** Liveness + database readiness. */
apiRouter.get('/health', async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});

// Public
apiRouter.use('/auth', authRouter);

// Everything below requires a valid session; each router authorises its own actions.
const secured = Router();
secured.use(authenticate);
secured.use('/users', usersRouter);
secured.use('/roles', rolesRouter);
secured.use('/audit', auditRouter);
secured.use('/notifications', notificationsRouter);
secured.use('/documents', documentsRouter);
secured.use('/requests', requestsRouter);
secured.use('/finance', financeRouter);
secured.use('/payroll', payrollRouter);
secured.use('/projects', projectsRouter);
secured.use('/tasks', tasksRouter);
secured.use('/field', fieldRouter);
secured.use('/farm', farmRouter);
secured.use('/crm', crmRouter);
secured.use('/inventory', inventoryRouter);
secured.use('/meetings', meetingsRouter);
secured.use('/dashboard', dashboardRouter);
secured.use('/reports', reportsRouter);

apiRouter.use(secured);
