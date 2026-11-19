import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { documents, greenhouses, inspections, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { richTextToPlain } from '../../common/utils/rich-text.js';
import { today } from '../../common/utils/dates.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import { can } from '../../common/middleware/authorize.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { becameHigh } from './farm.calc.js';
import { directorIds, farmManagerIds } from './farm.recipients.js';
import { assertNotFuture, requireGreenhouse } from './farm.shared.js';
import type {
  CreateInspectionInput,
  InspectionListQuery,
  UpdateInspectionInput,
} from './farm.schema.js';

type InspectionRow = typeof inspections.$inferSelect;

const columns = {
  id: inspections.id,
  greenhouseId: inspections.greenhouseId,
  agronomistId: inspections.agronomistId,
  inspectionDate: inspections.inspectionDate,
  findings: inspections.findings,
  diseaseIdentified: inspections.diseaseIdentified,
  severity: inspections.severity,
  recommendedTreatment: inspections.recommendedTreatment,
  recommendedFertiliser: inspections.recommendedFertiliser,
  followUpDate: inspections.followUpDate,
  status: inspections.status,
  createdAt: inspections.createdAt,
  updatedAt: inspections.updatedAt,
  greenhouse: {
    id: greenhouses.id,
    name: greenhouses.name,
    kind: greenhouses.kind,
    currentCrop: greenhouses.currentCrop,
  },
  agronomist: { id: users.id, name: users.name },
};

const SORTS = {
  inspectionDate: inspections.inspectionDate,
  followUpDate: inspections.followUpDate,
  createdAt: inspections.createdAt,
} as const;

const link = (id: number) => `/farm/inspections/${id}`;

/** Files attached to an inspection (a report file can stand in for typed findings). */
async function attachmentCount(tx: Executor, id: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(
      and(
        eq(documents.entityType, 'inspection'),
        eq(documents.entityId, String(id)),
        isNull(documents.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

async function findLive(id: number, tx: Executor = db): Promise<InspectionRow> {
  const [row] = await tx
    .select()
    .from(inspections)
    .where(and(eq(inspections.id, id), isNull(inspections.deletedAt)));
  if (!row) throw AppError.notFound('Inspection');
  return row;
}

/** Agronomists edit their own inspections only (matrix: Agronomist = C). */
function canEdit(user: AuthUser, row: Pick<InspectionRow, 'agronomistId'>): boolean {
  return can(user, P.INSPECTIONS_CREATE) && row.agronomistId === user.id;
}

/** FR-FRM-07: high severity → Farm Managers and Directors (in-app, email, SMS). */
async function alertHighSeverity(
  tx: Executor,
  user: AuthUser,
  id: number,
  greenhouseName: string,
  input: { diseaseIdentified?: string | null | undefined; findings?: string | null | undefined },
) {
  const [managers, directors] = await Promise.all([farmManagerIds(tx), directorIds(tx)]);
  await notificationService.notify(
    {
      userIds: [...managers, ...directors],
      excludeUserId: user.id,
      type: 'farm.high_severity',
      title:
        `High severity ${input.diseaseIdentified ? `${input.diseaseIdentified} ` : ''}in ${greenhouseName}`.slice(
          0,
          200,
        ),
      body: `Inspection by ${user.name}: ${richTextToPlain(input.findings) || 'see the attached report'}`.slice(
        0,
        2000,
      ),
      link: link(id),
      entityType: 'inspection',
      entityId: id,
      email: true,
      sms: true,
      critical: true,
    },
    tx,
  );
}

export const inspectionService = {
  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const [row] = await db
      .select({ agronomistId: inspections.agronomistId })
      .from(inspections)
      .where(and(eq(inspections.id, id), isNull(inspections.deletedAt)));
    return Boolean(row) && canEdit(user, row!);
  },

  /** Inspections with filters (FR-FRM-08). */
  async list(user: AuthUser, query: InspectionListQuery) {
    const filters: SQL[] = [isNull(inspections.deletedAt)];
    if (query.status) filters.push(eq(inspections.status, query.status));
    if (query.severity) filters.push(eq(inspections.severity, query.severity));
    if (query.greenhouseId) filters.push(eq(inspections.greenhouseId, query.greenhouseId));
    if (query.agronomistId) filters.push(eq(inspections.agronomistId, query.agronomistId));
    if (query.mine) filters.push(eq(inspections.agronomistId, user.id));
    if (query.due) {
      filters.push(
        isNotNull(inspections.followUpDate),
        lte(inspections.followUpDate, today()),
        ne(inspections.status, 'closed'),
      );
    }
    if (query.from) filters.push(gte(inspections.inspectionDate, query.from));
    if (query.to) filters.push(lte(inspections.inspectionDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          like(inspections.findings, term),
          like(inspections.diseaseIdentified, term),
          like(greenhouses.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'inspectionDate'];
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(columns)
        .from(inspections)
        .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
        .innerJoin(users, eq(users.id, inspections.agronomistId))
        .where(where)
        .orderBy(query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol), desc(inspections.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(inspections)
        .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  /** Counts per status for the list tabs. */
  async statusCounts(user: AuthUser, mine?: boolean) {
    const rows = await db
      .select({ status: inspections.status, n: sql<number>`count(*)` })
      .from(inspections)
      .where(
        and(
          isNull(inspections.deletedAt),
          mine ? eq(inspections.agronomistId, user.id) : undefined,
        ),
      )
      .groupBy(inspections.status);
    return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
  },

  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select(columns)
      .from(inspections)
      .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
      .innerJoin(users, eq(users.id, inspections.agronomistId))
      .where(and(eq(inspections.id, id), isNull(inspections.deletedAt)));
    if (!row) throw AppError.notFound('Inspection');
    return { ...row, canEdit: canEdit(user, row) };
  },

  /** Agronomist records an inspection (FR-FRM-06, US-AG-001). */
  async create(user: AuthUser, input: CreateInspectionInput) {
    assertNotFuture(input.inspectionDate, today(), 'The inspection date');
    if (input.followUpDate && input.followUpDate < input.inspectionDate)
      throw AppError.rule('The follow-up date cannot be before the inspection date');
    const id = await db.transaction(async (tx) => {
      const gh = await requireGreenhouse(tx, input.greenhouseId);
      const values = {
        greenhouseId: input.greenhouseId,
        agronomistId: user.id,
        inspectionDate: input.inspectionDate,
        // Empty when the findings are in the attached report file.
        findings: input.findings ?? '',
        diseaseIdentified: input.diseaseIdentified ?? null,
        severity: input.severity,
        recommendedTreatment: input.recommendedTreatment ?? null,
        recommendedFertiliser: input.recommendedFertiliser ?? null,
        followUpDate: input.followUpDate ?? null,
        status: input.status,
      };
      const [res] = await tx.insert(inspections).values(values);
      const newId = res.insertId;
      await auditService.log(
        { action: 'create', entityType: 'inspection', entityId: newId, newValues: values },
        tx,
      );
      if (input.severity === 'high') await alertHighSeverity(tx, user, newId, gh.name, input);
      return newId;
    });
    return this.get(user, id);
  },

  async update(user: AuthUser, id: number, input: UpdateInspectionInput) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(inspections)
        .where(and(eq(inspections.id, id), isNull(inspections.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Inspection');
      if (!canEdit(user, row)) throw AppError.forbidden('You can only edit your own inspections');
      const { withReportFile, ...fields } = input;
      // Clearing the typed findings is allowed only when a report file carries them.
      if (fields.findings === null) {
        if (!withReportFile && (await attachmentCount(tx, id)) === 0)
          throw AppError.rule('Describe the findings or attach the report file');
      }
      const { findings, ...rest } = fields;
      const patch = {
        ...rest,
        ...(findings === undefined ? {} : { findings: findings ?? '' }),
      };
      const merged = { ...row, ...patch };
      if (input.inspectionDate)
        assertNotFuture(input.inspectionDate, today(), 'The inspection date');
      if (merged.followUpDate && merged.followUpDate < merged.inspectionDate)
        throw AppError.rule('The follow-up date cannot be before the inspection date');
      const gh = await requireGreenhouse(tx, merged.greenhouseId);
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(inspections).set(changes.newValues).where(eq(inspections.id, id));
      await auditService.log(
        { action: 'update', entityType: 'inspection', entityId: id, ...changes },
        tx,
      );
      if (becameHigh(row.severity, merged.severity) && merged.status !== 'closed')
        await alertHighSeverity(tx, user, id, gh.name, merged);
    });
    return this.get(user, id);
  },

  async remove(user: AuthUser, id: number) {
    const row = await findLive(id);
    if (!canEdit(user, row)) throw AppError.forbidden('You can only delete your own inspections');
    await db.transaction(async (tx) => {
      const deletedAt = new Date();
      await tx.update(inspections).set({ deletedAt }).where(eq(inspections.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'inspection', entityId: id, newValues: { deletedAt } },
        tx,
      );
    });
  },
};
