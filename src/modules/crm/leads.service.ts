import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  customerContacts,
  customers,
  interactions,
  leads,
  projects,
  users,
} from '../../db/schema/index.js';
import { LEAD_STAGES, type LeadStage } from '../../db/enums.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { today } from '../../common/utils/dates.js';
import { diff } from '../../common/utils/diff.js';
import { round2, toNumber } from '../../common/utils/money.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { createProjectRecord } from '../projects/project-lifecycle.js';
import {
  conversionError,
  isOpenStage,
  OPEN_STAGES,
  stageChangeError,
  winRate,
} from './crm.rules.js';
import type {
  ChangeStageInput,
  ConvertLeadInput,
  CreateLeadInput,
  LeadListQuery,
  PipelineQuery,
  UpdateLeadInput,
} from './crm.schema.js';

type LeadRow = typeof leads.$inferSelect;

const listColumns = {
  id: leads.id,
  title: leads.title,
  companyName: leads.companyName,
  contactName: leads.contactName,
  contactPhone: leads.contactPhone,
  contactEmail: leads.contactEmail,
  source: leads.source,
  estimatedValue: leads.estimatedValue,
  expectedCloseDate: leads.expectedCloseDate,
  stage: leads.stage,
  lostReason: leads.lostReason,
  followUpDate: leads.followUpDate,
  customerId: leads.customerId,
  projectId: leads.projectId,
  convertedAt: leads.convertedAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
  owner: { id: users.id, name: users.name },
};

const SORTS = {
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
  estimatedValue: leads.estimatedValue,
  expectedCloseDate: leads.expectedCloseDate,
  followUpDate: leads.followUpDate,
} as const;

const link = (id: number) => `/crm/leads/${id}`;

async function lockLead(tx: Executor, id: number): Promise<LeadRow> {
  const [row] = await tx
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Lead');
  return row;
}

async function assertActiveUser(tx: Executor, userId: number, label = 'Owner') {
  const [u] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active')));
  if (!u) throw AppError.rule(`${label} must be an active user`);
}

async function assertCustomer(tx: Executor, customerId: number) {
  const [c] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
  if (!c) throw AppError.rule('Customer does not exist');
}

/** Closed (won/lost) leads freeze their figures so `updatedAt` marks the close date. */
function assertEditable(row: LeadRow) {
  if (!isOpenStage(row.stage)) {
    throw AppError.rule(
      `A ${row.stage} lead cannot be edited. Reopen it by changing its stage first.`,
    );
  }
}

export const leadService = {
  async exists(id: number): Promise<boolean> {
    const [row] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)));
    return Boolean(row);
  },

  /** Leads list with filters (FR-BDV-01). */
  async list(user: AuthUser, query: LeadListQuery) {
    const filters: SQL[] = [isNull(leads.deletedAt)];
    if (query.stage?.length) filters.push(inArray(leads.stage, query.stage));
    if (query.open || query.followUpDue) filters.push(inArray(leads.stage, [...OPEN_STAGES]));
    if (query.followUpDue) filters.push(lte(leads.followUpDate, today()));
    if (query.ownerId) filters.push(eq(leads.ownerId, query.ownerId));
    if (query.mine) filters.push(eq(leads.ownerId, user.id));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(leads.title, term), like(leads.companyName, term), like(leads.contactName, term))!,
      );
    }
    const where = and(...filters);
    const sortCol = SORTS[query.sortBy ?? 'createdAt'];
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select(listColumns)
        .from(leads)
        .innerJoin(users, eq(users.id, leads.ownerId))
        .where(where)
        .orderBy(order, desc(leads.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(leads)
        .where(where),
    ]);
    return paginated(rows, Number(total), query);
  },

  /**
   * Kanban board: every open lead plus won/lost leads closed in the last 90 days,
   * so the board stays readable.
   */
  async board(query: { ownerId?: number | undefined }) {
    const since = new Date(Date.now() - 90 * 24 * 3_600_000);
    return db
      .select(listColumns)
      .from(leads)
      .innerJoin(users, eq(users.id, leads.ownerId))
      .where(
        and(
          isNull(leads.deletedAt),
          query.ownerId ? eq(leads.ownerId, query.ownerId) : undefined,
          or(inArray(leads.stage, [...OPEN_STAGES]), gte(leads.updatedAt, since)),
        ),
      )
      .orderBy(desc(leads.estimatedValue), desc(leads.id))
      .limit(500);
  },

  async get(id: number) {
    const [row] = await db
      .select({
        ...listColumns,
        ownerId: leads.ownerId,
        customer: { id: customers.id, name: customers.name },
        project: { id: projects.id, code: projects.code, name: projects.name },
      })
      .from(leads)
      .innerJoin(users, eq(users.id, leads.ownerId))
      .leftJoin(customers, eq(customers.id, leads.customerId))
      .leftJoin(projects, eq(projects.id, leads.projectId))
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)));
    if (!row) throw AppError.notFound('Lead');

    const timeline = await db
      .select({
        id: interactions.id,
        type: interactions.type,
        summary: interactions.summary,
        occurredAt: interactions.occurredAt,
        createdAt: interactions.createdAt,
        user: { id: users.id, name: users.name },
      })
      .from(interactions)
      .innerJoin(users, eq(users.id, interactions.userId))
      .where(eq(interactions.leadId, id))
      .orderBy(desc(interactions.occurredAt), desc(interactions.id));

    return { ...row, interactions: timeline };
  },

  async create(user: AuthUser, input: CreateLeadInput) {
    const id = await db.transaction(async (tx) => {
      const ownerId = input.ownerId ?? user.id;
      if (ownerId !== user.id) await assertActiveUser(tx, ownerId);
      if (input.customerId) await assertCustomer(tx, input.customerId);
      const [res] = await tx.insert(leads).values({
        title: input.title,
        companyName: input.companyName,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail ?? null,
        source: input.source ?? null,
        estimatedValue: input.estimatedValue ?? 0,
        expectedCloseDate: input.expectedCloseDate ?? null,
        followUpDate: input.followUpDate ?? null,
        ownerId,
        customerId: input.customerId ?? null,
        stage: 'new',
      });
      const leadId = res.insertId;
      await auditService.log(
        {
          action: 'create',
          entityType: 'lead',
          entityId: leadId,
          newValues: { ...input, ownerId },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [ownerId],
          excludeUserId: user.id,
          type: 'lead.assigned',
          title: `New lead assigned to you: ${input.title}`,
          body: `${input.companyName} · added by ${user.name}`,
          link: link(leadId),
          entityType: 'lead',
          entityId: leadId,
        },
        tx,
      );
      return leadId;
    });
    return this.get(id);
  },

  async update(user: AuthUser, id: number, input: UpdateLeadInput) {
    await db.transaction(async (tx) => {
      const row = await lockLead(tx, id);
      assertEditable(row);
      if (input.ownerId && input.ownerId !== row.ownerId) await assertActiveUser(tx, input.ownerId);
      if (input.customerId) await assertCustomer(tx, input.customerId);
      const patch: Partial<LeadRow> = { ...input } as Partial<LeadRow>;
      if (input.ownerId === null) delete patch.ownerId;
      // A new follow-up date re-arms the reminder (FR-BDV-03).
      if (input.followUpDate !== undefined && input.followUpDate !== row.followUpDate) {
        patch.followUpNotifiedAt = null;
      }
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(leads).set(patch).where(eq(leads.id, id));
      await auditService.log(
        { action: 'update', entityType: 'lead', entityId: id, ...changes },
        tx,
      );
      if (patch.ownerId && patch.ownerId !== row.ownerId) {
        await notificationService.notify(
          {
            userIds: [patch.ownerId],
            excludeUserId: user.id,
            type: 'lead.assigned',
            title: `Lead assigned to you: ${row.title}`,
            body: `${row.companyName} · by ${user.name}`,
            link: link(id),
            entityType: 'lead',
            entityId: id,
          },
          tx,
        );
      }
    });
    return this.get(id);
  },

  /** Stage change New → … → Won / Lost (with reason), or reopen (FR-BDV-02). */
  async changeStage(user: AuthUser, id: number, input: ChangeStageInput) {
    await db.transaction(async (tx) => {
      const row = await lockLead(tx, id);
      const error = stageChangeError(row, input.stage, input.lostReason);
      if (error) throw AppError.rule(error);
      const patch: Partial<LeadRow> = {
        stage: input.stage,
        lostReason: input.stage === 'lost' ? (input.lostReason ?? null) : null,
      };
      await tx.update(leads).set(patch).where(eq(leads.id, id));
      await auditService.log(
        {
          action: 'stage_change',
          entityType: 'lead',
          entityId: id,
          oldValues: { stage: row.stage, lostReason: row.lostReason },
          newValues: patch,
        },
        tx,
      );
      if (input.stage === 'won' || input.stage === 'lost') {
        await notificationService.notify(
          {
            userIds: [row.ownerId],
            excludeUserId: user.id,
            type: `lead.${input.stage}`,
            title: `Lead ${input.stage}: ${row.title}`,
            body: input.stage === 'lost' ? `Reason: ${input.lostReason}` : row.companyName,
            link: link(id),
            entityType: 'lead',
            entityId: id,
          },
          tx,
        );
      }
    });
    return this.get(id);
  },

  /**
   * FR-BDV-04 / US-BD-004 AC3: a Won lead becomes a customer (created or linked) and a new
   * project in ONE transaction, without re-typing anything.
   */
  async convert(user: AuthUser, id: number, input: ConvertLeadInput) {
    const result = await db.transaction(async (tx) => {
      const row = await lockLead(tx, id);
      const error = conversionError(row);
      if (error) throw AppError.rule(error);

      // 1. Customer: explicit choice, the lead's linked customer, a same-name match, or new.
      let customerId = input.customerId ?? row.customerId ?? null;
      let customerCreated = false;
      if (customerId) {
        await assertCustomer(tx, customerId);
      } else {
        const [match] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              isNull(customers.deletedAt),
              sql`LOWER(${customers.name}) = ${row.companyName.trim().toLowerCase()}`,
            ),
          )
          .limit(1);
        if (match) {
          customerId = match.id;
        } else {
          const [res] = await tx.insert(customers).values({
            name: row.companyName,
            type: 'company',
            email: row.contactEmail,
            phone: row.contactPhone,
            notes: row.source ? `Source: ${row.source}` : null,
            createdBy: user.id,
          });
          customerId = res.insertId;
          customerCreated = true;
          await auditService.log(
            {
              action: 'create',
              entityType: 'customer',
              entityId: customerId,
              newValues: { name: row.companyName, fromLeadId: id },
            },
            tx,
          );
        }
      }
      if (row.contactName) {
        const [existingContact] = await tx
          .select({ id: customerContacts.id })
          .from(customerContacts)
          .where(
            and(
              eq(customerContacts.customerId, customerId),
              eq(customerContacts.name, row.contactName),
            ),
          )
          .limit(1);
        if (!existingContact) {
          await tx.insert(customerContacts).values({
            customerId,
            name: row.contactName,
            phone: row.contactPhone,
            email: row.contactEmail,
          });
        }
      }
      const [customer] = await tx
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, customerId));

      // 2. Project, through the shared lifecycle helper (PRJ code, history, audit).
      if (input.projectLeadId) await assertActiveUser(tx, input.projectLeadId, 'Project lead');
      const project = await createProjectRecord(
        tx,
        {
          name: input.projectName ?? row.title,
          customerId,
          clientName: customer?.name ?? row.companyName,
          location: input.location ?? null,
          contractValue: row.estimatedValue,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? row.expectedCloseDate ?? null,
          projectLeadId: input.projectLeadId ?? null,
          description: `Converted from lead "${row.title}" (${row.companyName})`,
        },
        user.id,
      );

      // 3. Link the lead.
      const patch = { customerId, projectId: project.id, convertedAt: new Date() };
      await tx.update(leads).set(patch).where(eq(leads.id, id));
      await auditService.log(
        {
          action: 'convert',
          entityType: 'lead',
          entityId: id,
          oldValues: { customerId: row.customerId, projectId: row.projectId },
          newValues: { ...patch, projectCode: project.code, customerCreated },
        },
        tx,
      );
      if (input.projectLeadId) {
        await notificationService.notify(
          {
            userIds: [input.projectLeadId],
            excludeUserId: user.id,
            type: 'project.assigned',
            title: `You lead the new project ${project.code}`,
            body: input.projectName ?? row.title,
            link: `/projects/${project.id}`,
            entityType: 'project',
            entityId: project.id,
          },
          tx,
        );
      }
      return { customerId, customerCreated, projectId: project.id, projectCode: project.code };
    });
    return { ...result, lead: await this.get(id) };
  },

  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockLead(tx, id);
      if (row.convertedAt) throw AppError.rule('A converted lead cannot be deleted');
      await tx.update(leads).set({ deletedAt: new Date() }).where(eq(leads.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'lead', entityId: id, oldValues: { title: row.title } },
        tx,
      );
    });
  },

  /**
   * FR-BDV-07: value and count by stage, and the win rate for a period.
   * Open stages are the live pipeline (snapshot); won/lost are counted when they closed
   * within the period (`updatedAt` — closed leads are read-only, so it marks the close date).
   */
  async pipeline(query: PipelineQuery) {
    const closedFilters: SQL[] = [];
    if (query.from) closedFilters.push(gte(leads.updatedAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) closedFilters.push(lte(leads.updatedAt, new Date(`${query.to}T23:59:59.999Z`)));
    const owner = query.ownerId ? eq(leads.ownerId, query.ownerId) : undefined;

    const rows = await db
      .select({
        stage: leads.stage,
        count: sql<number>`count(*)`,
        value: sql<string>`COALESCE(SUM(${leads.estimatedValue}), 0)`,
      })
      .from(leads)
      .where(
        and(
          isNull(leads.deletedAt),
          owner,
          or(
            inArray(leads.stage, [...OPEN_STAGES]),
            and(inArray(leads.stage, ['won', 'lost']), ...closedFilters),
          ),
        ),
      )
      .groupBy(leads.stage);

    const byStage = LEAD_STAGES.map((stage) => {
      const r = rows.find((x) => x.stage === stage);
      return { stage, count: Number(r?.count ?? 0), value: round2(toNumber(r?.value)) };
    });
    const pick = (s: LeadStage) => byStage.find((b) => b.stage === s)!;
    const open = byStage.filter((b) => isOpenStage(b.stage));

    const [followUps] = await db
      .select({ n: sql<number>`count(*)` })
      .from(leads)
      .where(
        and(
          isNull(leads.deletedAt),
          owner,
          inArray(leads.stage, [...OPEN_STAGES]),
          isNotNull(leads.followUpDate),
          lte(leads.followUpDate, today()),
        ),
      );
    const [converted] = await db
      .select({ n: sql<number>`count(*)` })
      .from(leads)
      .where(
        and(
          isNull(leads.deletedAt),
          owner,
          isNotNull(leads.convertedAt),
          query.from ? gte(leads.convertedAt, new Date(`${query.from}T00:00:00Z`)) : undefined,
          query.to ? lte(leads.convertedAt, new Date(`${query.to}T23:59:59.999Z`)) : undefined,
        ),
      );

    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      byStage,
      openCount: open.reduce((a, b) => a + b.count, 0),
      openValue: round2(open.reduce((a, b) => a + b.value, 0)),
      won: pick('won'),
      lost: pick('lost'),
      winRate: winRate(pick('won').count, pick('lost').count),
      convertedCount: Number(converted?.n ?? 0),
      followUpsDue: Number(followUps?.n ?? 0),
    };
  },

  /** Open leads whose follow-up is due, used by the daily reminder job. */
  async dueFollowUps(onOrBefore: string) {
    return db
      .select({
        id: leads.id,
        title: leads.title,
        companyName: leads.companyName,
        ownerId: leads.ownerId,
        followUpDate: leads.followUpDate,
      })
      .from(leads)
      .where(
        and(
          isNull(leads.deletedAt),
          notInArray(leads.stage, ['won', 'lost']),
          isNotNull(leads.followUpDate),
          lte(leads.followUpDate, onOrBefore),
          isNull(leads.followUpNotifiedAt),
        ),
      );
  },
};
