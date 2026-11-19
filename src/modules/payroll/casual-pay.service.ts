import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db, type Executor } from '../../db/client.js';
import {
  attendance,
  casualPayItems,
  casualPayRuns,
  casualWorkers,
  projects,
  users,
} from '../../db/schema/index.js';
import type { WorkSiteType } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { sum } from '../../common/utils/money.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { categoryIdByName } from '../finance/categories.service.js';
import { recordTransaction } from '../finance/ledger.js';
import { notificationService } from '../notifications/notifications.service.js';
import { casualPayLines, siteCostCentre, type AttendanceTally } from './payroll.calc.js';
import type { CreateCasualRunInput, PayRunInput, RunListQuery } from './payroll.schema.js';

type RunRow = typeof casualPayRuns.$inferSelect;

const creator = alias(users, 'creator');
const payer = alias(users, 'payer');

const runColumns = {
  id: casualPayRuns.id,
  periodStart: casualPayRuns.periodStart,
  periodEnd: casualPayRuns.periodEnd,
  status: casualPayRuns.status,
  total: casualPayRuns.total,
  paidAt: casualPayRuns.paidAt,
  createdAt: casualPayRuns.createdAt,
  updatedAt: casualPayRuns.updatedAt,
  createdBy: { id: creator.id, name: creator.name },
  paidBy: { id: payer.id, name: payer.name },
  itemCount: sql<number>`(SELECT COUNT(*) FROM casual_pay_items i WHERE i.run_id = casual_pay_runs.id)`,
  daysTotal: sql<string>`(SELECT COALESCE(SUM(i.days_present), 0) FROM casual_pay_items i WHERE i.run_id = casual_pay_runs.id)`,
};

function money(n: number) {
  return `RWF ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

async function lockRun(tx: Executor, id: number): Promise<RunRow> {
  const [row] = await tx.select().from(casualPayRuns).where(eq(casualPayRuns.id, id)).for('update');
  if (!row) throw AppError.notFound('Casual pay run');
  return row;
}

function assertDraft(run: RunRow) {
  if (run.status !== 'draft')
    throw AppError.rule('This pay run has been paid and can no longer change');
}

/** Casual worker pay from attendance (FR-PAY-05, BRL-05, US-OA-007). */
export const casualPayService = {
  async list(query: RunListQuery) {
    const where = query.status ? eq(casualPayRuns.status, query.status) : undefined;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(runColumns)
        .from(casualPayRuns)
        .innerJoin(creator, eq(creator.id, casualPayRuns.createdBy))
        .leftJoin(payer, eq(payer.id, casualPayRuns.paidBy))
        .where(where)
        .orderBy(desc(casualPayRuns.periodEnd), desc(casualPayRuns.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(casualPayRuns)
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({ ...r, daysTotal: Number(r.daysTotal), itemCount: Number(r.itemCount) })),
      Number(total),
      query,
    );
  },

  async get(id: number) {
    const [run] = await db
      .select(runColumns)
      .from(casualPayRuns)
      .innerJoin(creator, eq(creator.id, casualPayRuns.createdBy))
      .leftJoin(payer, eq(payer.id, casualPayRuns.paidBy))
      .where(eq(casualPayRuns.id, id));
    if (!run) throw AppError.notFound('Casual pay run');
    const items = await db
      .select({
        id: casualPayItems.id,
        workerId: casualPayItems.workerId,
        daysPresent: casualPayItems.daysPresent,
        dailyRate: casualPayItems.dailyRate,
        amount: casualPayItems.amount,
        siteType: casualPayItems.siteType,
        paid: casualPayItems.paid,
        transactionId: casualPayItems.transactionId,
        worker: {
          id: casualWorkers.id,
          fullName: casualWorkers.fullName,
          nationalId: casualWorkers.nationalId,
          phone: casualWorkers.phone,
        },
        project: { id: projects.id, code: projects.code, name: projects.name },
      })
      .from(casualPayItems)
      .innerJoin(casualWorkers, eq(casualWorkers.id, casualPayItems.workerId))
      .leftJoin(projects, eq(projects.id, casualPayItems.projectId))
      .where(eq(casualPayItems.runId, id))
      .orderBy(asc(casualWorkers.fullName));
    return {
      ...run,
      itemCount: Number(run.itemCount),
      daysTotal: Number(run.daysTotal),
      items,
    };
  },

  /**
   * Draft pay run for a period: days present × current daily rate per worker (US-OA-007 AC1).
   * Workers already in another run for an overlapping period are skipped so no day is paid twice.
   * A worker who worked on several sites is charged to the site where they worked most days.
   */
  async generate(user: AuthUser, input: CreateCasualRunInput) {
    const result = await db.transaction(async (tx) => {
      const filters: SQL[] = [
        eq(attendance.present, true),
        gte(attendance.workDate, input.periodStart),
        lte(attendance.workDate, input.periodEnd),
        isNull(casualWorkers.deletedAt),
      ];
      if (input.siteType) filters.push(eq(attendance.siteType, input.siteType));
      if (input.projectId) filters.push(eq(attendance.projectId, input.projectId));

      const groups = await tx
        .select({
          workerId: attendance.workerId,
          fullName: casualWorkers.fullName,
          dailyRate: casualWorkers.dailyRate,
          siteType: attendance.siteType,
          projectId: attendance.projectId,
          days: sql<number>`COUNT(*)`,
        })
        .from(attendance)
        .innerJoin(casualWorkers, eq(casualWorkers.id, attendance.workerId))
        .where(and(...filters))
        .groupBy(
          attendance.workerId,
          casualWorkers.fullName,
          casualWorkers.dailyRate,
          attendance.siteType,
          attendance.projectId,
        );
      if (!groups.length) {
        throw AppError.rule('No attendance was recorded for this period and site');
      }

      // Workers already covered by an overlapping run (draft or paid).
      const workerIds = [...new Set(groups.map((g) => g.workerId))];
      const covered = await tx
        .select({ workerId: casualPayItems.workerId })
        .from(casualPayItems)
        .innerJoin(casualPayRuns, eq(casualPayRuns.id, casualPayItems.runId))
        .where(
          and(
            inArray(casualPayItems.workerId, workerIds),
            lte(casualPayRuns.periodStart, input.periodEnd),
            gte(casualPayRuns.periodEnd, input.periodStart),
          ),
        );
      const coveredIds = new Set(covered.map((c) => c.workerId));

      const tallies = new Map<number, AttendanceTally & { best: number; fullName: string }>();
      for (const g of groups) {
        if (coveredIds.has(g.workerId)) continue;
        const days = Number(g.days);
        const t = tallies.get(g.workerId);
        if (!t) {
          tallies.set(g.workerId, {
            workerId: g.workerId,
            fullName: g.fullName,
            daysPresent: days,
            dailyRate: g.dailyRate,
            siteType: g.siteType as WorkSiteType,
            projectId: g.projectId,
            best: days,
          });
        } else {
          t.daysPresent += days;
          if (days > t.best) {
            t.best = days;
            t.siteType = g.siteType;
            t.projectId = g.projectId;
          }
        }
      }
      const { items, total } = casualPayLines([...tallies.values()]);
      if (!items.length) {
        throw AppError.rule('Every worker with attendance in this period is already in a pay run');
      }

      const [res] = await tx.insert(casualPayRuns).values({
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: 'draft',
        total,
        createdBy: user.id,
      });
      const runId = res.insertId;
      await tx.insert(casualPayItems).values(
        items.map((i) => ({
          runId,
          workerId: i.workerId,
          daysPresent: i.daysPresent,
          dailyRate: i.dailyRate,
          amount: i.amount,
          siteType: i.siteType,
          projectId: i.siteType === 'project' ? i.projectId : null,
        })),
      );
      const skipped = groups
        .filter((g) => coveredIds.has(g.workerId))
        .map((g) => g.fullName)
        .filter((n, i, a) => a.indexOf(n) === i);
      await auditService.log(
        {
          action: 'create',
          entityType: 'casual_pay_run',
          entityId: runId,
          newValues: { ...input, workers: items.length, total, skipped },
        },
        tx,
      );
      return { runId, skipped };
    });
    return { ...(await this.get(result.runId)), skipped: result.skipped };
  },

  async removeItem(runId: number, itemId: number) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      assertDraft(run);
      const [item] = await tx
        .select()
        .from(casualPayItems)
        .where(and(eq(casualPayItems.id, itemId), eq(casualPayItems.runId, runId)));
      if (!item) throw AppError.notFound('Pay item');
      await tx.delete(casualPayItems).where(eq(casualPayItems.id, itemId));
      const [row] = await tx
        .select({ total: sql<string>`COALESCE(SUM(${casualPayItems.amount}), 0)` })
        .from(casualPayItems)
        .where(eq(casualPayItems.runId, runId));
      await tx
        .update(casualPayRuns)
        .set({ total: Number(row?.total ?? 0) })
        .where(eq(casualPayRuns.id, runId));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'casual_pay_item',
          entityId: itemId,
          oldValues: { ...item },
        },
        tx,
      );
    });
    return this.get(runId);
  },

  /** Discards a draft (no money recorded; the table has no soft-delete column — kept in the audit log). */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, id);
      assertDraft(run);
      const items = await tx.select().from(casualPayItems).where(eq(casualPayItems.runId, id));
      await tx.delete(casualPayItems).where(eq(casualPayItems.runId, id));
      await tx.delete(casualPayRuns).where(eq(casualPayRuns.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'casual_pay_run',
          entityId: id,
          oldValues: { ...run, items },
        },
        tx,
      );
    });
  },

  /**
   * Confirms and pays the run (US-OA-007 AC2, FR-PAY-06): one "Casual labour" expense per worker,
   * charged to the farm or the project they worked on. All or nothing.
   */
  async pay(user: AuthUser, id: number, input: PayRunInput) {
    await db.transaction(async (tx) => {
      const run = await lockRun(tx, id);
      assertDraft(run);
      const items = await tx
        .select({
          id: casualPayItems.id,
          amount: casualPayItems.amount,
          daysPresent: casualPayItems.daysPresent,
          siteType: casualPayItems.siteType,
          projectId: casualPayItems.projectId,
          fullName: casualWorkers.fullName,
        })
        .from(casualPayItems)
        .innerJoin(casualWorkers, eq(casualWorkers.id, casualPayItems.workerId))
        .where(eq(casualPayItems.runId, id));
      if (!items.length) throw AppError.rule('This pay run has no workers');

      const categoryId = await categoryIdByName(tx, 'Casual labour', 'expense');
      for (const item of items) {
        const transactionId = await recordTransaction(tx, {
          direction: 'out',
          transactionDate: input.paidOn,
          amount: item.amount,
          categoryId,
          ...siteCostCentre(item.siteType, item.projectId),
          paymentMethod: input.paymentMethod,
          reference: input.reference ? `${input.reference}-${item.id}` : null,
          description: `Casual pay ${run.periodStart} to ${run.periodEnd} — ${item.fullName} (${item.daysPresent} days)`,
          source: 'casual_payroll',
          sourceId: item.id,
          recordedBy: user.id,
        });
        await tx
          .update(casualPayItems)
          .set({ paid: true, transactionId })
          .where(eq(casualPayItems.id, item.id));
      }
      const total = sum(items.map((i) => i.amount));
      const patch = { status: 'paid' as const, paidBy: user.id, paidAt: new Date(), total };
      await tx.update(casualPayRuns).set(patch).where(eq(casualPayRuns.id, id));
      await auditService.log(
        {
          action: 'pay',
          entityType: 'casual_pay_run',
          entityId: id,
          oldValues: { status: run.status },
          newValues: { ...patch, ...input, workers: items.length },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: await notificationService.userIdsWithPermission(P.PAYROLL_MANAGE, tx),
          excludeUserId: user.id,
          type: 'casual_pay.paid',
          title: `Casual pay ${run.periodStart} – ${run.periodEnd} paid`,
          body: `${money(total)} paid to ${items.length} workers by ${user.name}`,
          link: `/payroll/casual-runs/${id}`,
          entityType: 'casual_pay_run',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(id);
  },
};
