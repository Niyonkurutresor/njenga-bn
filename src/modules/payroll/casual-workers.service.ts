import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  attendance,
  casualPayItems,
  casualPayRuns,
  casualWorkers,
  projects,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isFutureDate } from './payroll.calc.js';
import type {
  AttendanceQuery,
  CreateWorkerInput,
  SaveAttendanceInput,
  UpdateWorkerInput,
  WorkerListQuery,
} from './payroll.schema.js';

const columns = {
  id: casualWorkers.id,
  fullName: casualWorkers.fullName,
  nationalId: casualWorkers.nationalId,
  phone: casualWorkers.phone,
  dailyRate: casualWorkers.dailyRate,
  siteType: casualWorkers.siteType,
  projectId: casualWorkers.projectId,
  status: casualWorkers.status,
  createdAt: casualWorkers.createdAt,
  updatedAt: casualWorkers.updatedAt,
  project: { id: projects.id, code: projects.code, name: projects.name },
};

const SORTS = {
  fullName: casualWorkers.fullName,
  dailyRate: casualWorkers.dailyRate,
  createdAt: casualWorkers.createdAt,
} as const;

async function assertProject(tx: Executor, projectId: number) {
  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!project) throw AppError.rule('Project does not exist');
  if (project.status === 'closed') throw AppError.rule('The project is closed');
}

async function assertUniqueId(tx: Executor, nationalId: string, excludeId?: number) {
  // The unique index also covers soft-deleted rows, so check them too.
  const [taken] = await tx
    .select({ id: casualWorkers.id, fullName: casualWorkers.fullName })
    .from(casualWorkers)
    .where(
      and(
        eq(casualWorkers.nationalId, nationalId),
        excludeId ? ne(casualWorkers.id, excludeId) : undefined,
      ),
    );
  if (taken)
    throw AppError.conflict(`ID number ${nationalId} is already registered (${taken.fullName})`);
}

/** Casual workers (FR-PAY-03) and their daily attendance (FR-PAY-04, US-FM-004). */
export const casualWorkerService = {
  async list(query: WorkerListQuery) {
    const filters: SQL[] = [isNull(casualWorkers.deletedAt)];
    if (query.siteType) filters.push(eq(casualWorkers.siteType, query.siteType));
    if (query.projectId) filters.push(eq(casualWorkers.projectId, query.projectId));
    if (query.status) filters.push(eq(casualWorkers.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(casualWorkers.fullName, term),
          like(casualWorkers.nationalId, term),
          like(casualWorkers.phone, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'fullName'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(columns)
        .from(casualWorkers)
        .leftJoin(projects, eq(projects.id, casualWorkers.projectId))
        .where(where)
        .orderBy(order, asc(casualWorkers.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(casualWorkers)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  async get(id: number) {
    const [row] = await db
      .select(columns)
      .from(casualWorkers)
      .leftJoin(projects, eq(projects.id, casualWorkers.projectId))
      .where(and(eq(casualWorkers.id, id), isNull(casualWorkers.deletedAt)));
    if (!row) throw AppError.notFound('Casual worker');
    return row;
  },

  async create(input: CreateWorkerInput) {
    const id = await db.transaction(async (tx) => {
      const values = {
        ...input,
        projectId: input.siteType === 'project' ? (input.projectId ?? null) : null,
      };
      await assertUniqueId(tx, values.nationalId);
      if (values.projectId) await assertProject(tx, values.projectId);
      const [res] = await tx.insert(casualWorkers).values(values);
      await auditService.log(
        {
          action: 'create',
          entityType: 'casual_worker',
          entityId: res.insertId,
          newValues: values,
        },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateWorkerInput) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(casualWorkers)
        .where(and(eq(casualWorkers.id, id), isNull(casualWorkers.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Casual worker');
      const siteType = input.siteType ?? row.siteType;
      const projectId = siteType === 'project' ? (input.projectId ?? row.projectId) : null;
      if (siteType === 'project' && !projectId) throw AppError.rule('Select the project');
      if (input.nationalId && input.nationalId !== row.nationalId) {
        await assertUniqueId(tx, input.nationalId, id);
      }
      if (projectId && projectId !== row.projectId) await assertProject(tx, projectId);
      const patch = { ...input, projectId };
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(casualWorkers).set(patch).where(eq(casualWorkers.id, id));
      await auditService.log(
        { action: 'update', entityType: 'casual_worker', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(id);
  },

  async remove(id: number) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(casualWorkers)
        .where(and(eq(casualWorkers.id, id), isNull(casualWorkers.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Casual worker');
      await tx
        .update(casualWorkers)
        .set({ deletedAt: new Date(), status: 'inactive' })
        .where(eq(casualWorkers.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'casual_worker',
          entityId: id,
          oldValues: { fullName: row.fullName, nationalId: row.nationalId },
        },
        tx,
      );
    });
  },

  /**
   * Marking sheet for one day and site (US-FM-004): every active worker assigned to the site,
   * with today's mark — present, absent or not yet marked (null).
   */
  async attendanceSheet(query: AttendanceQuery) {
    const site: SQL[] = [
      isNull(casualWorkers.deletedAt),
      eq(casualWorkers.status, 'active'),
      eq(casualWorkers.siteType, query.siteType),
    ];
    if (query.projectId) site.push(eq(casualWorkers.projectId, query.projectId));

    const rows = await db
      .select({
        workerId: casualWorkers.id,
        fullName: casualWorkers.fullName,
        nationalId: casualWorkers.nationalId,
        phone: casualWorkers.phone,
        dailyRate: casualWorkers.dailyRate,
        siteType: casualWorkers.siteType,
        project: { id: projects.id, code: projects.code, name: projects.name },
        present: attendance.present,
        recordedAt: attendance.createdAt,
      })
      .from(casualWorkers)
      .leftJoin(projects, eq(projects.id, casualWorkers.projectId))
      .leftJoin(
        attendance,
        and(eq(attendance.workerId, casualWorkers.id), eq(attendance.workDate, query.date)),
      )
      .where(and(...site))
      .orderBy(asc(casualWorkers.fullName));

    const workers = rows.map((r) => ({ ...r, present: r.present ?? null }));
    return {
      date: query.date,
      siteType: query.siteType,
      projectId: query.projectId ?? null,
      workers,
      summary: {
        total: workers.length,
        present: workers.filter((w) => w.present === true).length,
        absent: workers.filter((w) => w.present === false).length,
        unmarked: workers.filter((w) => w.present === null).length,
      },
    };
  },

  /**
   * Saves a day's marks in one go (FR-PAY-04). Each row records the worker's site on that day,
   * which is what casual pay charges (FR-PAY-06). Days already paid cannot change.
   */
  async saveAttendance(user: AuthUser, input: SaveAttendanceInput) {
    if (isFutureDate(input.date, today())) {
      throw AppError.rule('Attendance cannot be recorded for a future date');
    }
    const ids = input.entries.map((e) => e.workerId);
    return db.transaction(async (tx) => {
      const workers = await tx
        .select({
          id: casualWorkers.id,
          fullName: casualWorkers.fullName,
          siteType: casualWorkers.siteType,
          projectId: casualWorkers.projectId,
        })
        .from(casualWorkers)
        .where(and(inArray(casualWorkers.id, ids), isNull(casualWorkers.deletedAt)));
      if (workers.length !== ids.length) throw AppError.rule('Some workers no longer exist');

      const paid = await tx
        .select({ workerId: casualPayItems.workerId })
        .from(casualPayItems)
        .innerJoin(casualPayRuns, eq(casualPayRuns.id, casualPayItems.runId))
        .where(
          and(
            inArray(casualPayItems.workerId, ids),
            eq(casualPayRuns.status, 'paid'),
            lte(casualPayRuns.periodStart, input.date),
            gte(casualPayRuns.periodEnd, input.date),
          ),
        );
      if (paid.length) {
        const names = workers
          .filter((w) => paid.some((p) => p.workerId === w.id))
          .map((w) => w.fullName);
        throw AppError.rule(
          `Attendance on ${input.date} has already been paid for: ${names.join(', ')}`,
        );
      }

      const byId = new Map(workers.map((w) => [w.id, w]));
      await tx
        .insert(attendance)
        .values(
          input.entries.map((e) => {
            const w = byId.get(e.workerId)!;
            return {
              workerId: e.workerId,
              workDate: input.date,
              siteType: w.siteType,
              projectId: w.siteType === 'project' ? w.projectId : null,
              present: e.present,
              recordedBy: user.id,
            };
          }),
        )
        .onDuplicateKeyUpdate({
          set: {
            present: sql.raw('VALUES(`present`)'),
            siteType: sql.raw('VALUES(`site_type`)'),
            projectId: sql.raw('VALUES(`project_id`)'),
            recordedBy: sql.raw('VALUES(`recorded_by`)'),
          },
        });

      const present = input.entries.filter((e) => e.present).length;
      await auditService.log(
        {
          action: 'record_attendance',
          entityType: 'attendance',
          entityId: input.date,
          newValues: {
            date: input.date,
            present,
            absent: input.entries.length - present,
            entries: input.entries,
          },
        },
        tx,
      );
      return { date: input.date, saved: input.entries.length, present };
    });
  },
};
