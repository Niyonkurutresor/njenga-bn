import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import { employees, payrollItems, payrollRuns, projects, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { sum } from '../../common/utils/money.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { categoryIdByName } from '../finance/categories.service.js';
import { netSalary } from '../finance/finance.calc.js';
import { recordTransaction } from '../finance/ledger.js';
import { notificationService } from '../notifications/notifications.service.js';
import { payrollLine } from './payroll.calc.js';
import type { PayRunInput, RunListQuery, UpdatePayrollItemInput } from './payroll.schema.js';

type RunRow = typeof payrollRuns.$inferSelect;

const creator = alias(users, 'creator');
const payer = alias(users, 'payer');

const runColumns = {
  id: payrollRuns.id,
  period: payrollRuns.period,
  status: payrollRuns.status,
  totalNet: payrollRuns.totalNet,
  paidAt: payrollRuns.paidAt,
  createdAt: payrollRuns.createdAt,
  updatedAt: payrollRuns.updatedAt,
  createdBy: { id: creator.id, name: creator.name },
  paidBy: { id: payer.id, name: payer.name },
  itemCount: sql<number>`(SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = payroll_runs.id)`,
};

function money(n: number) {
  return `RWF ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

async function lockRun(tx: Executor, id: number): Promise<RunRow> {
  const [row] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  if (!row) throw AppError.notFound('Payroll run');
  return row;
}

function assertDraft(run: RunRow) {
  if (run.status !== 'draft')
    throw AppError.rule('This payroll has been paid and can no longer change');
}

async function refreshTotal(tx: Executor, runId: number) {
  const [row] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${payrollItems.netPay}), 0)` })
    .from(payrollItems)
    .where(eq(payrollItems.runId, runId));
  await tx
    .update(payrollRuns)
    .set({ totalNet: Number(row?.total ?? 0) })
    .where(eq(payrollRuns.id, runId));
}

/** Monthly payroll: review, adjust, then pay — salaries post to each cost centre (FR-PAY-02, FR-PAY-06). */
export const payrollRunService = {
  async list(query: RunListQuery) {
    const where = query.status ? eq(payrollRuns.status, query.status) : undefined;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(runColumns)
        .from(payrollRuns)
        .innerJoin(creator, eq(creator.id, payrollRuns.createdBy))
        .leftJoin(payer, eq(payer.id, payrollRuns.paidBy))
        .where(where)
        .orderBy(desc(payrollRuns.period))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(payrollRuns)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async get(id: number) {
    const [run] = await db
      .select(runColumns)
      .from(payrollRuns)
      .innerJoin(creator, eq(creator.id, payrollRuns.createdBy))
      .leftJoin(payer, eq(payer.id, payrollRuns.paidBy))
      .where(eq(payrollRuns.id, id));
    if (!run) throw AppError.notFound('Payroll run');
    const items = await db
      .select({
        id: payrollItems.id,
        employeeId: payrollItems.employeeId,
        basicSalary: payrollItems.basicSalary,
        allowances: payrollItems.allowances,
        deductions: payrollItems.deductions,
        netPay: payrollItems.netPay,
        transactionId: payrollItems.transactionId,
        employee: {
          id: employees.id,
          fullName: employees.fullName,
          jobTitle: employees.jobTitle,
          department: employees.department,
          costCentreType: employees.costCentreType,
        },
        project: { id: projects.id, code: projects.code, name: projects.name },
      })
      .from(payrollItems)
      .innerJoin(employees, eq(employees.id, payrollItems.employeeId))
      .leftJoin(projects, eq(projects.id, employees.projectId))
      .where(eq(payrollItems.runId, id))
      .orderBy(asc(employees.fullName));
    return { ...run, items };
  },

  /** Draft payroll for `period` from every active employee's current salary (FR-PAY-02). */
  async generate(user: AuthUser, period: string) {
    const id = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(eq(payrollRuns.period, period));
      if (existing) {
        throw AppError.conflict(`A payroll for ${period} already exists`, { runId: existing.id });
      }
      const staff = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.status, 'active'), isNull(employees.deletedAt)));
      const lines = staff
        .map((e) => ({ employeeId: e.id, line: payrollLine(e) }))
        .filter((l): l is { employeeId: number; line: NonNullable<typeof l.line> } => !!l.line);
      if (!lines.length) throw AppError.rule('There are no active employees with a salary to pay');

      const [res] = await tx.insert(payrollRuns).values({
        period,
        status: 'draft',
        totalNet: sum(lines.map((l) => l.line.netPay)),
        createdBy: user.id,
      });
      const runId = res.insertId;
      await tx
        .insert(payrollItems)
        .values(lines.map((l) => ({ runId, employeeId: l.employeeId, ...l.line })));
      await auditService.log(
        {
          action: 'create',
          entityType: 'payroll_run',
          entityId: runId,
          newValues: { period, employees: lines.length },
        },
        tx,
      );
      return runId;
    });
    return this.get(id);
  },

  /** Adjust one employee's figures for this month only, while the run is a draft. */
  async updateItem(runId: number, itemId: number, input: UpdatePayrollItemInput) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      assertDraft(run);
      const [item] = await tx
        .select()
        .from(payrollItems)
        .where(and(eq(payrollItems.id, itemId), eq(payrollItems.runId, runId)));
      if (!item) throw AppError.notFound('Payroll item');
      const merged = { ...item, ...input };
      const netPay = netSalary(merged.basicSalary, merged.allowances, merged.deductions);
      if (netPay <= 0) throw AppError.rule('Net pay must be greater than zero');
      const patch = { ...input, netPay };
      await tx.update(payrollItems).set(patch).where(eq(payrollItems.id, itemId));
      await refreshTotal(tx, runId);
      await auditService.log(
        {
          action: 'update',
          entityType: 'payroll_item',
          entityId: itemId,
          oldValues: {
            basicSalary: item.basicSalary,
            allowances: item.allowances,
            deductions: item.deductions,
            netPay: item.netPay,
          },
          newValues: patch,
        },
        tx,
      );
    });
    return this.get(runId);
  },

  /** Leave an employee out of this month's draft. */
  async removeItem(runId: number, itemId: number) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      assertDraft(run);
      const [item] = await tx
        .select()
        .from(payrollItems)
        .where(and(eq(payrollItems.id, itemId), eq(payrollItems.runId, runId)));
      if (!item) throw AppError.notFound('Payroll item');
      await tx.delete(payrollItems).where(eq(payrollItems.id, itemId));
      await refreshTotal(tx, runId);
      await auditService.log(
        { action: 'delete', entityType: 'payroll_item', entityId: itemId, oldValues: { ...item } },
        tx,
      );
    });
    return this.get(runId);
  },

  /**
   * Discards a draft run. Drafts are working papers with no money recorded, and the run table
   * has no soft-delete column, so the row is removed and its content kept in the audit log.
   */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, id);
      assertDraft(run);
      const items = await tx.select().from(payrollItems).where(eq(payrollItems.runId, id));
      await tx.delete(payrollItems).where(eq(payrollItems.runId, id));
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'payroll_run',
          entityId: id,
          oldValues: { period: run.period, totalNet: run.totalNet, items },
        },
        tx,
      );
    });
  },

  /**
   * Pays the run (FR-PAY-02, FR-PAY-06): one ledger expense per employee, category "Salaries",
   * charged to the employee's cost centre. All or nothing — any failure rolls everything back.
   */
  async pay(user: AuthUser, id: number, input: PayRunInput) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, id);
      assertDraft(run);
      const items = await tx
        .select({
          id: payrollItems.id,
          netPay: payrollItems.netPay,
          fullName: employees.fullName,
          userId: employees.userId,
          costCentreType: employees.costCentreType,
          projectId: employees.projectId,
        })
        .from(payrollItems)
        .innerJoin(employees, eq(employees.id, payrollItems.employeeId))
        .where(eq(payrollItems.runId, id));
      if (!items.length) throw AppError.rule('This payroll has no employees');

      const categoryId = await categoryIdByName(tx, 'Salaries', 'expense');
      for (const item of items) {
        const transactionId = await recordTransaction(tx, {
          direction: 'out',
          transactionDate: input.paidOn,
          amount: item.netPay,
          categoryId,
          costCentreType: item.costCentreType,
          projectId: item.costCentreType === 'project' ? item.projectId : null,
          paymentMethod: input.paymentMethod,
          reference: input.reference ? `${input.reference}-${item.id}` : null,
          description: `Salary ${run.period} — ${item.fullName}`,
          source: 'payroll',
          sourceId: item.id,
          recordedBy: user.id,
        });
        await tx.update(payrollItems).set({ transactionId }).where(eq(payrollItems.id, item.id));
      }
      const total = sum(items.map((i) => i.netPay));
      const patch = {
        status: 'paid' as const,
        paidBy: user.id,
        paidAt: new Date(),
        totalNet: total,
      };
      await tx.update(payrollRuns).set(patch).where(eq(payrollRuns.id, id));
      await auditService.log(
        {
          action: 'pay',
          entityType: 'payroll_run',
          entityId: id,
          oldValues: { status: run.status },
          newValues: { ...patch, ...input, employees: items.length },
        },
        tx,
      );

      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.PAYROLL_MANAGE, tx),
          excludeUserId: user.id,
          type: 'payroll.paid',
          title: `Payroll ${run.period} paid`,
          body: `${money(total)} paid to ${items.length} employees by ${user.name}`,
          link: `/payroll/runs/${id}`,
          entityType: 'payroll_run',
          entityId: id,
          email: true,
        },
        tx,
      );
      // Staff with a system account hear that their salary was paid.
      for (const item of items.filter((i) => i.userId)) {
        await notificationService.notify(
          {
            userIds: [item.userId!],
            type: 'payroll.salary_paid',
            title: `Your salary for ${run.period} has been paid`,
            body: `${money(item.netPay)} paid on ${input.paidOn}`,
            entityType: 'payroll_run',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
    });
    return this.get(id);
  },
};
