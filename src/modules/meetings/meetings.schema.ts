import { z } from 'zod';
import { dateRangeSchema, listQuerySchema } from '../../common/http/pagination.js';
import { MEETING_STATUSES, PRIORITIES } from '../../db/enums.js';
import { richText } from '../../common/utils/rich-text.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const dateTime = z.iso.datetime({ offset: true, message: 'Enter a valid date and time' });
const userIds = z.array(z.coerce.number().int().positive()).max(200);

const meetingFields = z.object({
  title: z.string().trim().min(3, 'Give the meeting a title').max(191),
  startsAt: dateTime,
  endsAt: dateTime.nullable().optional(),
  location: optionalText(191),
  link: z
    .union([z.literal(''), z.url('Enter a valid link (https://…)').max(500)])
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  agenda: richText({ label: 'Agenda' }),
  participantIds: userIds,
});

const endsAfterStart = (v: { startsAt?: string | undefined; endsAt?: string | null | undefined }) =>
  !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt);

/** FR-MTG-01: title, date, time, location or link, participants, agenda. */
export const createMeetingSchema = meetingFields
  .extend({ participantIds: userIds.min(1, 'Invite at least one participant') })
  .refine(endsAfterStart, { message: 'The meeting must end after it starts', path: ['endsAt'] });
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = meetingFields
  .partial()
  .refine(endsAfterStart, { message: 'The meeting must end after it starts', path: ['endsAt'] });
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

export const cancelMeetingSchema = z.object({ reason: optionalText(2000) });

/** FR-MTG-03 minutes; `complete` marks the meeting as held. */
export const minutesSchema = z.object({
  minutes: richText({ label: 'Minutes' }),
  complete: z.boolean().default(false),
});
export type MinutesInput = z.infer<typeof minutesSchema>;

export const actionPointSchema = z.object({
  description: z.string().trim().min(3, 'Describe the action').max(5000),
  assigneeId: z.coerce.number().int().positive().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
});
export type ActionPointInput = z.infer<typeof actionPointSchema>;
export const updateActionPointSchema = actionPointSchema.partial();
export type UpdateActionPointInput = z.infer<typeof updateActionPointSchema>;

/** Converting an action point to a task (FR-MTG-03). Missing values come from the action point. */
export const actionPointTaskSchema = z.object({
  title: z.string().trim().min(3).max(191).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  deadline: z.iso.date().optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  projectId: z.coerce.number().int().positive().nullable().optional(),
});
export type ActionPointTaskInput = z.infer<typeof actionPointTaskSchema>;

export const actionPointParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  apId: z.coerce.number().int().positive(),
});

export const meetingListQuerySchema = listQuerySchema.extend(dateRangeSchema.shape).extend({
  scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  status: z.enum(MEETING_STATUSES).optional(),
});
export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;
