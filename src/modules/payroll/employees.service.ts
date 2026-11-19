import { and, asc, desc, eq, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { employees, projects, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { auditService } from '../audit/audit.service.js';
import { netSalary } from '../finance/finance.calc.js';
import type {
  CreateEmployeeInput,
  EmployeeListQuery,
  UpdateEmployeeInput,
} from './payroll.schema.js';

type EmployeeRow = typeof employees.$inferSelect;

const columns = {
  id: employees.id,
  userId: employees.userId,
  fullName: employees.fullName,
  jobTitle: employees.jobTitle,
  department: employees.department,
  phone: employees.phone,
  nationalId: employees.nationalId,
  bankAccount: employees.bankAccount,
  basicSalary: employees.basicSalary,
  allowances: employees.allowances,
  deductions: employees.deductions,
  hireDate: employees.hireDate,
  costCentreType: employees.costCentreType,
  projectId: employees.projectId,
  status: employees.status,
  createdAt: employees.createdAt,
  updatedAt: employees.updatedAt,
  user: { id: users.id, name: users.name, email: users.email },
  project: { id: projects.id, code: projects.code, name: projects.name },
};

const SORTS = {
  fullName: employees.fullName,
  basicSalary: employees.basicSalary,
  hireDate: employees.hireDate,
  createdAt: employees.createdAt,
} as const;

function withNet<T extends { basicSalary: number; allowances: number; deductions: number }>(
  row: T,
) {
  return { ...row, netSalary: netSalary(row.basicSalary, row.allowances, row.deductions) };
}

async function assertLinks(
  tx: Executor,
  input: { userId?: number | null | undefined; projectId?: number | null | undefined },
  excludeId?: number,
) {
  if (input.userId) {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) throw AppError.rule('User does not exist');
    const [taken] = await tx
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(
        and(
          eq(employees.userId, input.userId),
          excludeId ? ne(employees.id, excludeId) : undefined,
        ),
      );
    if (taken) throw AppError.conflict(`That user is already linked to ${taken.fullName}`);
  }
  if (input.projectId) {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)));
    if (!project) throw AppError.rule('Project does not exist');
  }
}

/** Permanent staff and salary details (FR-PAY-01). */
export const employeeService = {
  async list(query: EmployeeListQuery) {
    const filters: SQL[] = [isNull(employees.deletedAt)];
    if (query.status) filters.push(eq(employees.status, query.status));
    if (query.costCentreType) filters.push(eq(employees.costCentreType, query.costCentreType));
    if (query.department) filters.push(eq(employees.department, query.department));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(employees.fullName, term),
          like(employees.jobTitle, term),
          like(employees.nationalId, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'fullName'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(columns)
        .from(employees)
        .leftJoin(users, eq(users.id, employees.userId))
        .leftJoin(projects, eq(projects.id, employees.projectId))
        .where(where)
        .orderBy(order, asc(employees.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(employees)
        .where(where),
    ]);
    return paginated(rows.map(withNet), Number(total), query);
  },

  async get(id: number) {
    const [row] = await db
      .select(columns)
      .from(employees)
      .leftJoin(users, eq(users.id, employees.userId))
      .leftJoin(projects, eq(projects.id, employees.projectId))
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
    if (!row) throw AppError.notFound('Employee');
    return withNet(row);
  },

  async create(input: CreateEmployeeInput) {
    const id = await db.transaction(async (tx) => {
      const values = {
        ...input,
        projectId: input.costCentreType === 'project' ? (input.projectId ?? null) : null,
      };
      await assertLinks(tx, values);
      const [res] = await tx.insert(employees).values(values);
      await auditService.log(
        { action: 'create', entityType: 'employee', entityId: res.insertId, newValues: values },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateEmployeeInput) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Employee');
      const merged: EmployeeRow = { ...row, ...input } as EmployeeRow;
      if (merged.costCentreType === 'project' && !merged.projectId) {
        throw AppError.rule('Select the project');
      }
      const patch = {
        ...input,
        projectId: merged.costCentreType === 'project' ? merged.projectId : null,
      };
      if (input.userId !== undefined && input.userId !== row.userId) {
        await assertLinks(tx, { userId: input.userId }, id);
      }
      if (patch.projectId && patch.projectId !== row.projectId) {
        await assertLinks(tx, { projectId: patch.projectId });
      }
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(employees).set(patch).where(eq(employees.id, id));
      await auditService.log(
        { action: 'update', entityType: 'employee', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(id);
  },

  /** Soft delete (BRL-10); the user link is released so the account can be linked again. */
  async remove(id: number) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Employee');
      await tx
        .update(employees)
        .set({ deletedAt: new Date(), status: 'inactive', userId: null })
        .where(eq(employees.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'employee',
          entityId: id,
          oldValues: { fullName: row.fullName, userId: row.userId, status: row.status },
        },
        tx,
      );
    });
  },
};
