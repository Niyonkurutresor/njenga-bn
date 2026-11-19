import { and, asc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { meetingParticipants, meetings } from '../../../db/schema/index.js';
import type { SectionBuilder } from '../dashboard.types.js';

export interface MeetingsSection {
  upcoming: {
    id: number;
    title: string;
    startsAt: Date;
    location: string | null;
    link: string;
  }[];
}

/** FR-MTG-01: my upcoming meetings (organiser or participant). Everyone gets this section. */
export const meetingsSection: SectionBuilder<MeetingsSection> = {
  key: 'meetings',
  visible: () => true,
  async build({ user }) {
    const rows = await db
      .select({
        id: meetings.id,
        title: meetings.title,
        startsAt: meetings.startsAt,
        location: meetings.location,
      })
      .from(meetings)
      .where(
        and(
          isNull(meetings.deletedAt),
          eq(meetings.status, 'scheduled'),
          gte(meetings.startsAt, new Date()),
          or(
            eq(meetings.organizerId, user.id),
            inArray(
              meetings.id,
              db
                .select({ id: meetingParticipants.meetingId })
                .from(meetingParticipants)
                .where(eq(meetingParticipants.userId, user.id)),
            ),
          ),
        ),
      )
      .orderBy(asc(meetings.startsAt))
      .limit(5);
    return { upcoming: rows.map((r) => ({ ...r, link: `/meetings/${r.id}` })) };
  },
};
