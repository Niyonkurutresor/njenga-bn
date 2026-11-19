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
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { outerColumn } from '../../common/utils/sql.js';
import {
  customerContacts,
  customers,
  interactions,
  leads,
  projects,
  sales,
  satisfactionRatings,
  users,
} from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated, Paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { round2, toNumber } from '../../common/utils/money.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { canRateProject } from './crm.rules.js';
import type {
  ContactInput,
  CreateCustomerInput,
  CustomerListQuery,
  InteractionInput,
  RatingInput,
  SaleInput,
  SaleListQuery,
  UpdateCustomerInput,
} from './crm.schema.js';

type CustomerRow = typeof customers.$inferSelect;

async function lockCustomer(tx: Executor, id: number): Promise<CustomerRow> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Customer');
  return row;
}

async function customerExists(tx: Executor, id: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, id), isNull(customers.deletedAt)));
  return Boolean(row);
}

const interactionColumns = {
  id: interactions.id,
  type: interactions.type,
  summary: interactions.summary,
  occurredAt: interactions.occurredAt,
  customerId: interactions.customerId,
  leadId: interactions.leadId,
  createdAt: interactions.createdAt,
  user: { id: users.id, name: users.name },
};

export const customerService = {
  async exists(id: number) {
    return customerExists(db, id);
  },

  async list(query: CustomerListQuery) {
    const filters: SQL[] = [isNull(customers.deletedAt)];
    if (query.type) filters.push(eq(customers.type, query.type));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(like(customers.name, term), like(customers.email, term), like(customers.phone, term))!,
      );
    }
    const where = and(...filters);
    const sortCol = query.sortBy === 'createdAt' ? customers.createdAt : customers.name;
    const dir = query.sortBy ? query.sortDir : 'asc';
    const projectCount = sql<number>`(SELECT COUNT(*) FROM ${projects} WHERE ${projects.customerId} = ${outerColumn(customers.id)} AND ${projects.deletedAt} IS NULL)`;
    const salesTotal = sql<string>`(SELECT COALESCE(SUM(${sales.amount}), 0) FROM ${sales} WHERE ${sales.customerId} = ${outerColumn(customers.id)} AND ${sales.deletedAt} IS NULL)`;
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          id: customers.id,
          name: customers.name,
          type: customers.type,
          email: customers.email,
          phone: customers.phone,
          address: customers.address,
          createdAt: customers.createdAt,
          projectCount,
          salesTotal,
        })
        .from(customers)
        .where(where)
        .orderBy(dir === 'asc' ? asc(sortCol) : desc(sortCol), desc(customers.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(customers)
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({
        ...r,
        projectCount: Number(r.projectCount),
        salesTotal: round2(toNumber(r.salesTotal)),
      })),
      Number(total),
      query,
    );
  },

  /** Lightweight list for pickers (sales, lead conversion). */
  async options() {
    return db
      .select({ id: customers.id, name: customers.name, type: customers.type })
      .from(customers)
      .where(isNull(customers.deletedAt))
      .orderBy(asc(customers.name))
      .limit(1000);
  },

  /** Customer record: contacts, projects, sales, interactions, ratings, leads (FR-BDV-05). */
  async get(id: number) {
    const [row] = await db
      .select({
        id: customers.id,
        name: customers.name,
        type: customers.type,
        email: customers.email,
        phone: customers.phone,
        address: customers.address,
        notes: customers.notes,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
        createdBy: { id: users.id, name: users.name },
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.createdBy))
      .where(and(eq(customers.id, id), isNull(customers.deletedAt)));
    if (!row) throw AppError.notFound('Customer');

    const [contacts, projectRows, saleRows, interactionRows, ratingRows, leadRows] =
      await Promise.all([
        db
          .select()
          .from(customerContacts)
          .where(eq(customerContacts.customerId, id))
          .orderBy(asc(customerContacts.name)),
        db
          .select({
            id: projects.id,
            code: projects.code,
            name: projects.name,
            status: projects.status,
            contractValue: projects.contractValue,
            startDate: projects.startDate,
            endDate: projects.endDate,
          })
          .from(projects)
          .where(and(eq(projects.customerId, id), isNull(projects.deletedAt)))
          .orderBy(desc(projects.createdAt)),
        db
          .select({
            id: sales.id,
            amount: sales.amount,
            saleDate: sales.saleDate,
            description: sales.description,
            project: { id: projects.id, code: projects.code, name: projects.name },
            recordedBy: { id: users.id, name: users.name },
          })
          .from(sales)
          .innerJoin(users, eq(users.id, sales.recordedBy))
          .leftJoin(projects, eq(projects.id, sales.projectId))
          .where(and(eq(sales.customerId, id), isNull(sales.deletedAt)))
          .orderBy(desc(sales.saleDate), desc(sales.id)),
        db
          .select(interactionColumns)
          .from(interactions)
          .innerJoin(users, eq(users.id, interactions.userId))
          .where(eq(interactions.customerId, id))
          .orderBy(desc(interactions.occurredAt), desc(interactions.id))
          .limit(200),
        db
          .select({
            id: satisfactionRatings.id,
            projectId: satisfactionRatings.projectId,
            rating: satisfactionRatings.rating,
            comment: satisfactionRatings.comment,
            createdAt: satisfactionRatings.createdAt,
            project: { id: projects.id, code: projects.code, name: projects.name },
            recordedBy: { id: users.id, name: users.name },
          })
          .from(satisfactionRatings)
          .innerJoin(projects, eq(projects.id, satisfactionRatings.projectId))
          .innerJoin(users, eq(users.id, satisfactionRatings.recordedBy))
          .where(eq(satisfactionRatings.customerId, id))
          .orderBy(desc(satisfactionRatings.createdAt)),
        db
          .select({
            id: leads.id,
            title: leads.title,
            stage: leads.stage,
            estimatedValue: leads.estimatedValue,
            convertedAt: leads.convertedAt,
          })
          .from(leads)
          .where(and(eq(leads.customerId, id), isNull(leads.deletedAt)))
          .orderBy(desc(leads.createdAt)),
      ]);

    const ratedProjectIds = new Set(ratingRows.map((r) => r.projectId));
    const avg = ratingRows.length
      ? Math.round((ratingRows.reduce((a, r) => a + r.rating, 0) / ratingRows.length) * 10) / 10
      : null;

    return {
      ...row,
      contacts,
      projects: projectRows.map((p) => ({
        ...p,
        rated: ratedProjectIds.has(p.id),
        canRate: canRateProject(p.status) && !ratedProjectIds.has(p.id),
      })),
      sales: saleRows,
      salesTotal: round2(saleRows.reduce((a, s) => a + s.amount, 0)),
      interactions: interactionRows,
      ratings: ratingRows,
      averageRating: avg,
      leads: leadRows,
    };
  },

  async create(user: AuthUser, input: CreateCustomerInput) {
    const id = await db.transaction(async (tx) => {
      const [res] = await tx.insert(customers).values({
        name: input.name,
        type: input.type ?? 'company',
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        createdBy: user.id,
      });
      await auditService.log(
        { action: 'create', entityType: 'customer', entityId: res.insertId, newValues: input },
        tx,
      );
      return res.insertId;
    });
    return this.get(id);
  },

  async update(id: number, input: UpdateCustomerInput) {
    await db.transaction(async (tx) => {
      const row = await lockCustomer(tx, id);
      const changes = diff(row, input as Partial<CustomerRow>);
      if (!changes) return;
      await tx
        .update(customers)
        .set(input as Partial<CustomerRow>)
        .where(eq(customers.id, id));
      await auditService.log(
        { action: 'update', entityType: 'customer', entityId: id, ...changes },
        tx,
      );
    });
    return this.get(id);
  },

  async remove(id: number) {
    await db.transaction(async (tx) => {
      const row = await lockCustomer(tx, id);
      const [active] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(projects)
        .where(
          and(
            eq(projects.customerId, id),
            isNull(projects.deletedAt),
            sql`${projects.status} <> 'closed'`,
          ),
        );
      if (Number(active?.n ?? 0) > 0) {
        throw AppError.rule('This customer has projects that are not closed');
      }
      await tx.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'customer', entityId: id, oldValues: { name: row.name } },
        tx,
      );
    });
  },

  // ---------------- Contacts ----------------

  async addContact(customerId: number, input: ContactInput) {
    await db.transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const [res] = await tx.insert(customerContacts).values({
        customerId,
        name: input.name,
        position: input.position ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
      });
      await auditService.log(
        {
          action: 'create',
          entityType: 'customer_contact',
          entityId: res.insertId,
          newValues: { customerId, ...input },
        },
        tx,
      );
    });
    return this.get(customerId);
  },

  async updateContact(customerId: number, contactId: number, input: ContactInput) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(customerContacts)
        .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
        .for('update');
      if (!row) throw AppError.notFound('Contact');
      const changes = diff(row, input);
      if (!changes) return;
      await tx.update(customerContacts).set(input).where(eq(customerContacts.id, contactId));
      await auditService.log(
        { action: 'update', entityType: 'customer_contact', entityId: contactId, ...changes },
        tx,
      );
    });
    return this.get(customerId);
  },

  /** Contacts have no soft-delete column; removal is audited with the full old record. */
  async removeContact(customerId: number, contactId: number) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(customerContacts)
        .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
        .for('update');
      if (!row) throw AppError.notFound('Contact');
      await tx.delete(customerContacts).where(eq(customerContacts.id, contactId));
      await auditService.log(
        { action: 'delete', entityType: 'customer_contact', entityId: contactId, oldValues: row },
        tx,
      );
    });
    return this.get(customerId);
  },

  // ---------------- Interactions ----------------

  /** Log a call/meeting/email/visit/note against a customer and/or lead. */
  async logInteraction(user: AuthUser, input: InteractionInput) {
    return db.transaction(async (tx) => {
      let customerId = input.customerId ?? null;
      if (input.leadId) {
        const [lead] = await tx
          .select()
          .from(leads)
          .where(and(eq(leads.id, input.leadId), isNull(leads.deletedAt)))
          .for('update');
        if (!lead) throw AppError.rule('Lead does not exist');
        customerId = customerId ?? lead.customerId;
        if (input.nextFollowUpDate !== undefined && input.nextFollowUpDate !== lead.followUpDate) {
          await tx
            .update(leads)
            .set({ followUpDate: input.nextFollowUpDate, followUpNotifiedAt: null })
            .where(eq(leads.id, lead.id));
          await auditService.log(
            {
              action: 'update',
              entityType: 'lead',
              entityId: lead.id,
              oldValues: { followUpDate: lead.followUpDate },
              newValues: { followUpDate: input.nextFollowUpDate },
            },
            tx,
          );
        }
      }
      if (customerId && !(await customerExists(tx, customerId))) {
        throw AppError.rule('Customer does not exist');
      }
      const [res] = await tx.insert(interactions).values({
        customerId,
        leadId: input.leadId ?? null,
        type: input.type,
        summary: input.summary ?? '', // required by the schema; richText's type is nullable
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        userId: user.id,
      });
      await auditService.log(
        {
          action: 'create',
          entityType: 'interaction',
          entityId: res.insertId,
          newValues: { ...input, customerId },
        },
        tx,
      );
      const [created] = await tx
        .select(interactionColumns)
        .from(interactions)
        .innerJoin(users, eq(users.id, interactions.userId))
        .where(eq(interactions.id, res.insertId));
      return created;
    });
  },

  // ---------------- Sales (FR-BDV-06) ----------------

  async listSales(query: SaleListQuery) {
    const filters: SQL[] = [isNull(sales.deletedAt)];
    if (query.customerId) filters.push(eq(sales.customerId, query.customerId));
    if (query.projectId) filters.push(eq(sales.projectId, query.projectId));
    if (query.from) filters.push(gte(sales.saleDate, query.from));
    if (query.to) filters.push(lte(sales.saleDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(customers.name, term), like(sales.description, term))!);
    }
    const where = and(...filters);
    const sortCol =
      query.sortBy === 'amount'
        ? sales.amount
        : query.sortBy === 'createdAt'
          ? sales.createdAt
          : sales.saleDate;
    const order = query.sortDir === 'asc' ? asc(sortCol) : desc(sortCol);
    const [rows, [agg = { total: 0, amount: '0' }]] = await Promise.all([
      db
        .select({
          id: sales.id,
          amount: sales.amount,
          saleDate: sales.saleDate,
          description: sales.description,
          createdAt: sales.createdAt,
          customer: { id: customers.id, name: customers.name },
          project: { id: projects.id, code: projects.code, name: projects.name },
          recordedBy: { id: users.id, name: users.name },
        })
        .from(sales)
        .innerJoin(customers, eq(customers.id, sales.customerId))
        .innerJoin(users, eq(users.id, sales.recordedBy))
        .leftJoin(projects, eq(projects.id, sales.projectId))
        .where(where)
        .orderBy(order, desc(sales.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({
          total: sql<number>`count(*)`,
          amount: sql<string>`COALESCE(SUM(${sales.amount}), 0)`,
        })
        .from(sales)
        .innerJoin(customers, eq(customers.id, sales.customerId))
        .where(where),
    ]);
    const meta = {
      ...paginated(rows, Number(agg.total), query).meta,
      totalAmount: round2(toNumber(agg.amount)),
    };
    return new Paginated(rows, meta);
  },

  async recordSale(user: AuthUser, input: SaleInput) {
    return db.transaction(async (tx) => {
      if (!(await customerExists(tx, input.customerId))) {
        throw AppError.rule('Customer does not exist');
      }
      if (input.projectId) {
        const [p] = await tx
          .select({ customerId: projects.customerId })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)));
        if (!p) throw AppError.rule('Project does not exist');
        if (p.customerId && p.customerId !== input.customerId) {
          throw AppError.rule('That project belongs to a different customer');
        }
      }
      const [res] = await tx.insert(sales).values({
        customerId: input.customerId,
        projectId: input.projectId ?? null,
        amount: input.amount,
        saleDate: input.saleDate,
        description: input.description ?? null,
        recordedBy: user.id,
      });
      await auditService.log(
        { action: 'create', entityType: 'sale', entityId: res.insertId, newValues: input },
        tx,
      );
      return { id: res.insertId };
    });
  },

  async removeSale(id: number) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sales)
        .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
        .for('update');
      if (!row) throw AppError.notFound('Sale');
      await tx.update(sales).set({ deletedAt: new Date() }).where(eq(sales.id, id));
      await auditService.log(
        {
          action: 'delete',
          entityType: 'sale',
          entityId: id,
          oldValues: { amount: row.amount, customerId: row.customerId, saleDate: row.saleDate },
        },
        tx,
      );
    });
  },

  // ---------------- Satisfaction (FR-BDV-08) ----------------

  /** One 1–5 rating per completed project. */
  async rateProject(user: AuthUser, input: RatingInput) {
    return db.transaction(async (tx) => {
      const [project] = await tx
        .select({ status: projects.status, customerId: projects.customerId, code: projects.code })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
        .for('update');
      if (!project) throw AppError.rule('Project does not exist');
      if (!canRateProject(project.status)) {
        throw AppError.rule('Satisfaction can only be recorded once the project is completed');
      }
      const [existing] = await tx
        .select({ id: satisfactionRatings.id })
        .from(satisfactionRatings)
        .where(eq(satisfactionRatings.projectId, input.projectId));
      if (existing) throw AppError.conflict(`Project ${project.code} has already been rated`);
      const [res] = await tx.insert(satisfactionRatings).values({
        projectId: input.projectId,
        customerId: project.customerId,
        rating: input.rating,
        comment: input.comment ?? null,
        recordedBy: user.id,
      });
      await auditService.log(
        {
          action: 'create',
          entityType: 'satisfaction_rating',
          entityId: res.insertId,
          newValues: input,
        },
        tx,
      );
      return { id: res.insertId, customerId: project.customerId };
    });
  },

  /** Average satisfaction and count for dashboards (Ops: customer satisfaction). */
  async ratingSummary(projectIds?: number[]) {
    const [row] = await db
      .select({
        n: sql<number>`count(*)`,
        avg: sql<string | null>`AVG(${satisfactionRatings.rating})`,
      })
      .from(satisfactionRatings)
      .where(projectIds?.length ? inArray(satisfactionRatings.projectId, projectIds) : undefined);
    const avg = row?.avg == null ? null : Math.round(toNumber(row.avg) * 10) / 10;
    return { count: Number(row?.n ?? 0), average: avg };
  },
};
