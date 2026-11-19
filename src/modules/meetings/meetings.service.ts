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
import {
  meetingActionPoints,
  meetingParticipants,
  meetings,
  projects,
  tasks,
  users,
} from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { offsetOf, paginated } from '../../common/http/pagination.js';
import { diff } from '../../common/utils/diff.js';
import { ROLE_CODES } from '../../rbac/default-roles.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import type {
  ActionPointInput,
  ActionPointTaskInput,
  CreateMeetingInput,
  MeetingListQuery,
  MinutesInput,
  UpdateActionPointInput,
  UpdateMeetingInput,
} from './meetings.schema.js';
import { canEditMeeting } from './meetings.rules.js';

type MeetingRow = typeof meetings.$inferSelect;

const link = (id: number) => `/meetings/${id}`;

const whenFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: env.TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatWhen(d: Date): string {
  return whenFmt.format(d);
}

function isDirector(user: AuthUser): boolean {
  return user.roleCode === ROLE_CODES.DIRECTOR;
}

/** A meeting counts as "past" one hour after its start when no end time is set. */
const meetingEnd = sql`COALESCE(${meetings.endsAt}, DATE_ADD(${meetings.startsAt}, INTERVAL 1 HOUR))`;

function visibleTo(user: AuthUser): SQL | undefined {
  if (isDirector(user)) return undefined;
  return or(
    eq(meetings.organizerId, user.id),
    inArray(
      meetings.id,
      db
        .select({ id: meetingParticipants.meetingId })
        .from(meetingParticipants)
        .where(eq(meetingParticipants.userId, user.id)),
    ),
  );
}

async function lockMeeting(tx: Executor, id: number): Promise<MeetingRow> {
  const [row] = await tx
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
    .for('update');
  if (!row) throw AppError.notFound('Meeting');
  return row;
}

async function participantIds(tx: Executor, meetingId: number): Promise<number[]> {
  const rows = await tx
    .select({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId));
  return rows.map((r) => r.userId);
}

async function assertActiveUsers(tx: Executor, ids: number[]) {
  if (!ids.length) return;
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'active')));
  if (rows.length !== new Set(ids).size) {
    throw AppError.rule('Every participant must be an active user');
  }
}

async function editable(tx: Executor, user: AuthUser, id: number): Promise<MeetingRow> {
  const row = await lockMeeting(tx, id);
  if (!canEditMeeting(user, row)) {
    throw AppError.forbidden('Only the organizer or a Director can change this meeting');
  }
  return row;
}

function placeOf(m: { location: string | null; link: string | null }) {
  return m.location ?? (m.link ? 'Online' : null);
}

export const meetingService = {
  /** Agenda list: meetings the user organises or attends (Directors see all). */
  async list(user: AuthUser, query: MeetingListQuery) {
    const now = new Date();
    const filters: SQL[] = [isNull(meetings.deletedAt)];
    const vis = visibleTo(user);
    if (vis) filters.push(vis);
    if (query.scope === 'upcoming') filters.push(sql`${meetingEnd} >= ${now}`);
    if (query.scope === 'past') filters.push(sql`${meetingEnd} < ${now}`);
    if (query.status) filters.push(eq(meetings.status, query.status));
    if (query.from) filters.push(gte(meetings.startsAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) filters.push(lte(meetings.startsAt, new Date(`${query.to}T23:59:59.999Z`)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(like(meetings.title, term), like(meetings.location, term))!);
    }
    const where = and(...filters);
    const ascending = query.scope === 'upcoming';
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          id: meetings.id,
          title: meetings.title,
          startsAt: meetings.startsAt,
          endsAt: meetings.endsAt,
          location: meetings.location,
          link: meetings.link,
          status: meetings.status,
          organizer: { id: users.id, name: users.name },
        })
        .from(meetings)
        .innerJoin(users, eq(users.id, meetings.organizerId))
        .where(where)
        .orderBy(ascending ? asc(meetings.startsAt) : desc(meetings.startsAt), asc(meetings.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      db
        .select({ total: sql<number>`count(*)` })
        .from(meetings)
        .where(where),
    ]);

    const ids = rows.map((r) => r.id);
    const people = ids.length
      ? await db
          .select({
            meetingId: meetingParticipants.meetingId,
            id: users.id,
            name: users.name,
          })
          .from(meetingParticipants)
          .innerJoin(users, eq(users.id, meetingParticipants.userId))
          .where(inArray(meetingParticipants.meetingId, ids))
      : [];
    return paginated(
      rows.map((r) => ({
        ...r,
        participants: people
          .filter((p) => p.meetingId === r.id)
          .map((p) => ({ id: p.id, name: p.name })),
        isOrganizer: r.organizer.id === user.id,
      })),
      Number(total),
      query,
    );
  },

  async get(user: AuthUser, id: number) {
    const [row] = await db
      .select({
        id: meetings.id,
        title: meetings.title,
        startsAt: meetings.startsAt,
        endsAt: meetings.endsAt,
        location: meetings.location,
        link: meetings.link,
        agenda: meetings.agenda,
        minutes: meetings.minutes,
        status: meetings.status,
        organizerId: meetings.organizerId,
        reminderSentAt: meetings.reminderSentAt,
        createdAt: meetings.createdAt,
        updatedAt: meetings.updatedAt,
        organizer: { id: users.id, name: users.name },
      })
      .from(meetings)
      .innerJoin(users, eq(users.id, meetings.organizerId))
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)));
    if (!row) throw AppError.notFound('Meeting');

    const participants = await db
      .select({ id: users.id, name: users.name, jobTitle: users.jobTitle })
      .from(meetingParticipants)
      .innerJoin(users, eq(users.id, meetingParticipants.userId))
      .where(eq(meetingParticipants.meetingId, id))
      .orderBy(asc(users.name));

    const isParticipant = participants.some((p) => p.id === user.id);
    if (!isDirector(user) && row.organizerId !== user.id && !isParticipant) {
      throw AppError.forbidden('You are not invited to this meeting');
    }

    const actionPoints = await db
      .select({
        id: meetingActionPoints.id,
        description: meetingActionPoints.description,
        assigneeId: meetingActionPoints.assigneeId,
        dueDate: meetingActionPoints.dueDate,
        taskId: meetingActionPoints.taskId,
        createdAt: meetingActionPoints.createdAt,
        assignee: { id: users.id, name: users.name },
        task: { id: tasks.id, status: tasks.status, title: tasks.title },
      })
      .from(meetingActionPoints)
      .leftJoin(users, eq(users.id, meetingActionPoints.assigneeId))
      .leftJoin(tasks, eq(tasks.id, meetingActionPoints.taskId))
      .where(eq(meetingActionPoints.meetingId, id))
      .orderBy(asc(meetingActionPoints.id));

    return { ...row, participants, actionPoints, canEdit: canEditMeeting(user, row) };
  },

  /** FR-MTG-01/02: schedule and notify participants (in-app + email). */
  async create(user: AuthUser, input: CreateMeetingInput) {
    const id = await db.transaction(async (tx) => {
      const ids = [...new Set(input.participantIds)];
      await assertActiveUsers(tx, ids);
      const startsAt = new Date(input.startsAt);
      const [res] = await tx.insert(meetings).values({
        title: input.title,
        startsAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        location: input.location ?? null,
        link: input.link ?? null,
        agenda: input.agenda ?? null,
        organizerId: user.id,
        status: 'scheduled',
      });
      const meetingId = res.insertId;
      await tx.insert(meetingParticipants).values(ids.map((userId) => ({ meetingId, userId })));
      await auditService.log(
        { action: 'create', entityType: 'meeting', entityId: meetingId, newValues: input },
        tx,
      );
      const where = placeOf({ location: input.location ?? null, link: input.link ?? null });
      await notificationService.notify(
        {
          userIds: ids,
          excludeUserId: user.id,
          type: 'meeting.invited',
          title: `Meeting: ${input.title}`,
          body: `${user.name} invited you · ${formatWhen(startsAt)}${where ? ` · ${where}` : ''}`,
          link: link(meetingId),
          entityType: 'meeting',
          entityId: meetingId,
          email: true,
        },
        tx,
      );
      return meetingId;
    });
    return this.get(user, id);
  },

  /** FR-MTG-02: changes are announced to current, added and removed participants. */
  async update(user: AuthUser, id: number, input: UpdateMeetingInput) {
    await db.transaction(async (tx) => {
      const row = await editable(tx, user, id);
      if (row.status !== 'scheduled') {
        throw AppError.rule(`A ${row.status} meeting cannot be rescheduled`);
      }
      const { participantIds: nextIds, ...fields } = input;
      const patch: Partial<MeetingRow> = {
        ...fields,
        startsAt: fields.startsAt ? new Date(fields.startsAt) : undefined,
        endsAt:
          fields.endsAt === undefined ? undefined : fields.endsAt ? new Date(fields.endsAt) : null,
      } as Partial<MeetingRow>;
      const startsAt = patch.startsAt ?? row.startsAt;
      const endsAt = patch.endsAt === undefined ? row.endsAt : patch.endsAt;
      if (endsAt && endsAt <= startsAt) throw AppError.rule('The meeting must end after it starts');
      if (patch.startsAt && patch.startsAt.getTime() !== row.startsAt.getTime()) {
        patch.reminderSentAt = null; // re-arm the reminder for the new time
      }
      const changes = diff(row, patch);

      const before = await participantIds(tx, id);
      let added: number[] = [];
      let removed: number[] = [];
      if (nextIds) {
        const next = [...new Set(nextIds)];
        if (!next.length) throw AppError.rule('Invite at least one participant');
        await assertActiveUsers(tx, next);
        added = next.filter((u) => !before.includes(u));
        removed = before.filter((u) => !next.includes(u));
        if (removed.length) {
          await tx
            .delete(meetingParticipants)
            .where(
              and(
                eq(meetingParticipants.meetingId, id),
                inArray(meetingParticipants.userId, removed),
              ),
            );
        }
        if (added.length) {
          await tx
            .insert(meetingParticipants)
            .values(added.map((userId) => ({ meetingId: id, userId })));
        }
      }
      if (!changes && !added.length && !removed.length) return;

      if (changes) await tx.update(meetings).set(patch).where(eq(meetings.id, id));
      await auditService.log(
        {
          action: 'update',
          entityType: 'meeting',
          entityId: id,
          oldValues: {
            ...(changes?.oldValues ?? {}),
            ...(nextIds ? { participantIds: before } : {}),
          },
          newValues: {
            ...(changes?.newValues ?? {}),
            ...(nextIds ? { participantIds: [...new Set(nextIds)] } : {}),
          },
        },
        tx,
      );

      const title = patch.title ?? row.title;
      const location = patch.location === undefined ? row.location : patch.location;
      const meetingLink = patch.link === undefined ? row.link : patch.link;
      const where = placeOf({ location, link: meetingLink });
      const summary = `${formatWhen(startsAt)}${where ? ` · ${where}` : ''}`;
      const remaining = before.filter((u) => !removed.includes(u));
      if (changes && remaining.length) {
        await notificationService.notify(
          {
            userIds: remaining,
            excludeUserId: user.id,
            type: 'meeting.updated',
            title: `Meeting updated: ${title}`,
            body: summary,
            link: link(id),
            entityType: 'meeting',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
      if (added.length) {
        await notificationService.notify(
          {
            userIds: added,
            excludeUserId: user.id,
            type: 'meeting.invited',
            title: `Meeting: ${title}`,
            body: `${user.name} invited you · ${summary}`,
            link: link(id),
            entityType: 'meeting',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
      if (removed.length) {
        await notificationService.notify(
          {
            userIds: removed,
            excludeUserId: user.id,
            type: 'meeting.removed',
            title: `You are no longer invited to: ${title}`,
            body: formatWhen(startsAt),
            entityType: 'meeting',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
    });
    return this.get(user, id);
  },

  async cancel(user: AuthUser, id: number, reason?: string | null) {
    await db.transaction(async (tx) => {
      const row = await editable(tx, user, id);
      if (row.status !== 'scheduled') {
        throw AppError.rule(`A ${row.status} meeting cannot be cancelled`);
      }
      await tx.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, id));
      await auditService.log(
        {
          action: 'cancel',
          entityType: 'meeting',
          entityId: id,
          oldValues: { status: row.status },
          newValues: { status: 'cancelled', reason: reason ?? null },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: await participantIds(tx, id),
          excludeUserId: user.id,
          type: 'meeting.cancelled',
          title: `Meeting cancelled: ${row.title}`,
          body: `${formatWhen(row.startsAt)}${reason ? ` — ${reason}` : ''}`,
          link: link(id),
          entityType: 'meeting',
          entityId: id,
          email: true,
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  async remove(user: AuthUser, id: number) {
    await db.transaction(async (tx) => {
      const row = await editable(tx, user, id);
      await tx.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, id));
      await auditService.log(
        { action: 'delete', entityType: 'meeting', entityId: id, oldValues: { title: row.title } },
        tx,
      );
      if (row.status === 'scheduled' && row.startsAt > new Date()) {
        await notificationService.notify(
          {
            userIds: await participantIds(tx, id),
            excludeUserId: user.id,
            type: 'meeting.cancelled',
            title: `Meeting cancelled: ${row.title}`,
            body: formatWhen(row.startsAt),
            entityType: 'meeting',
            entityId: id,
            email: true,
          },
          tx,
        );
      }
    });
  },

  /** FR-MTG-03: minutes; optionally mark the meeting as held. */
  async saveMinutes(user: AuthUser, id: number, input: MinutesInput) {
    await db.transaction(async (tx) => {
      const row = await editable(tx, user, id);
      if (row.status === 'cancelled') throw AppError.rule('A cancelled meeting has no minutes');
      const patch: Partial<MeetingRow> = { minutes: input.minutes || null };
      if (input.complete) patch.status = 'completed';
      const changes = diff(row, patch);
      if (!changes) return;
      await tx.update(meetings).set(patch).where(eq(meetings.id, id));
      await auditService.log(
        { action: 'update', entityType: 'meeting', entityId: id, ...changes },
        tx,
      );
      if (input.complete && row.status !== 'completed') {
        await notificationService.notify(
          {
            userIds: await participantIds(tx, id),
            excludeUserId: user.id,
            type: 'meeting.minutes',
            title: `Minutes available: ${row.title}`,
            link: link(id),
            entityType: 'meeting',
            entityId: id,
          },
          tx,
        );
      }
    });
    return this.get(user, id);
  },

  async addActionPoint(user: AuthUser, id: number, input: ActionPointInput) {
    await db.transaction(async (tx) => {
      const row = await editable(tx, user, id);
      if (row.status === 'cancelled') throw AppError.rule('The meeting was cancelled');
      if (input.assigneeId) await assertActiveUsers(tx, [input.assigneeId]);
      const [res] = await tx.insert(meetingActionPoints).values({
        meetingId: id,
        description: input.description,
        assigneeId: input.assigneeId ?? null,
        dueDate: input.dueDate ?? null,
      });
      await auditService.log(
        {
          action: 'create',
          entityType: 'meeting_action_point',
          entityId: res.insertId,
          newValues: { meetingId: id, ...input },
        },
        tx,
      );
    });
    return this.get(user, id);
  },

  async updateActionPoint(user: AuthUser, id: number, apId: number, input: UpdateActionPointInput) {
    await db.transaction(async (tx) => {
      await editable(tx, user, id);
      const ap = await lockActionPoint(tx, id, apId);
      if (ap.taskId) throw AppError.rule('This action point is already a task; update the task');
      if (input.assigneeId) await assertActiveUsers(tx, [input.assigneeId]);
      const changes = diff(ap, input);
      if (!changes) return;
      await tx.update(meetingActionPoints).set(input).where(eq(meetingActionPoints.id, apId));
      await auditService.log(
        { action: 'update', entityType: 'meeting_action_point', entityId: apId, ...changes },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** Action points have no soft-delete column; only unconverted ones are removable (audited). */
  async removeActionPoint(user: AuthUser, id: number, apId: number) {
    await db.transaction(async (tx) => {
      await editable(tx, user, id);
      const ap = await lockActionPoint(tx, id, apId);
      if (ap.taskId) throw AppError.rule('This action point is already a task');
      await tx.delete(meetingActionPoints).where(eq(meetingActionPoints.id, apId));
      await auditService.log(
        { action: 'delete', entityType: 'meeting_action_point', entityId: apId, oldValues: ap },
        tx,
      );
    });
    return this.get(user, id);
  },

  /** FR-MTG-03: an action point becomes a task for its assignee. */
  async convertToTask(user: AuthUser, id: number, apId: number, input: ActionPointTaskInput) {
    const taskId = await db.transaction(async (tx) => {
      const meeting = await editable(tx, user, id);
      const ap = await lockActionPoint(tx, id, apId);
      if (ap.taskId) throw AppError.conflict('This action point is already a task');
      const assigneeId = input.assigneeId ?? ap.assigneeId;
      if (!assigneeId) throw AppError.rule('Choose who the task is assigned to');
      await assertActiveUsers(tx, [assigneeId]);
      const deadline = input.deadline ?? ap.dueDate ?? null;
      if (input.projectId) {
        const [p] = await tx
          .select({ status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)));
        if (!p) throw AppError.rule('Project does not exist');
        if (p.status === 'closed') throw AppError.rule('Tasks cannot be added to a closed project');
      }
      const title = (input.title ?? ap.description).replace(/\s+/g, ' ').slice(0, 191);
      const [res] = await tx.insert(tasks).values({
        projectId: input.projectId ?? null,
        title,
        description: `${ap.description}\n\nFrom meeting "${meeting.title}" (${formatWhen(meeting.startsAt)})`,
        assigneeId,
        createdBy: user.id,
        priority: input.priority,
        deadline,
        status: 'not_started',
        meetingActionPointId: apId,
      });
      const newTaskId = res.insertId;
      await tx
        .update(meetingActionPoints)
        .set({ taskId: newTaskId, assigneeId, dueDate: deadline })
        .where(eq(meetingActionPoints.id, apId));
      await auditService.log(
        {
          action: 'create',
          entityType: 'task',
          entityId: newTaskId,
          newValues: { title, assigneeId, deadline, meetingActionPointId: apId, meetingId: id },
        },
        tx,
      );
      await notificationService.notify(
        {
          userIds: [assigneeId],
          excludeUserId: user.id,
          type: 'task.assigned',
          title: `New task: ${title}`,
          body: `From meeting "${meeting.title}"${deadline ? ` · due ${deadline}` : ''}`,
          link: `/tasks`,
          entityType: 'task',
          entityId: newTaskId,
          email: true,
        },
        tx,
      );
      return newTaskId;
    });
    return { taskId, meeting: await this.get(user, id) };
  },

  /** Meetings starting within `minutes` that have not been reminded yet (FR-MTG-02). */
  async dueReminders(minutes: number) {
    const now = new Date();
    const until = new Date(now.getTime() + minutes * 60_000);
    return db
      .select({
        id: meetings.id,
        title: meetings.title,
        startsAt: meetings.startsAt,
        location: meetings.location,
        link: meetings.link,
        organizerId: meetings.organizerId,
      })
      .from(meetings)
      .where(
        and(
          isNull(meetings.deletedAt),
          eq(meetings.status, 'scheduled'),
          isNull(meetings.reminderSentAt),
          gte(meetings.startsAt, now),
          lte(meetings.startsAt, until),
        ),
      );
  },

  participantIds(meetingId: number, tx: Executor = db) {
    return participantIds(tx, meetingId);
  },

  /** Document access: anyone who can see the meeting reads; editors attach. */
  async canView(user: AuthUser, id: number): Promise<boolean> {
    if (isDirector(user)) return true;
    const [row] = await db
      .select({ organizerId: meetings.organizerId })
      .from(meetings)
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)));
    if (!row) return false;
    return row.organizerId === user.id || (await participantIds(db, id)).includes(user.id);
  },

  async canAttach(user: AuthUser, id: number): Promise<boolean> {
    const [row] = await db
      .select({ organizerId: meetings.organizerId })
      .from(meetings)
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)));
    return Boolean(row) && canEditMeeting(user, row!);
  },
};

async function lockActionPoint(tx: Executor, meetingId: number, apId: number) {
  const [ap] = await tx
    .select()
    .from(meetingActionPoints)
    .where(and(eq(meetingActionPoints.id, apId), eq(meetingActionPoints.meetingId, meetingId)))
    .for('update');
  if (!ap) throw AppError.notFound('Action point');
  return ap;
}
