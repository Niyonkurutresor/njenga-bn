import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { meetings } from '../../db/schema/index.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { formatWhen, meetingService } from './meetings.service.js';

const REMINDER_WINDOW_MINUTES = 30;

/** FR-MTG-02: remind participants (and the organizer) shortly before a meeting starts. */
export async function sendMeetingReminders(): Promise<void> {
  const due = await meetingService.dueReminders(REMINDER_WINDOW_MINUTES);
  for (const m of due) {
    await db.transaction(async (tx) => {
      const participants = await meetingService.participantIds(m.id, tx);
      const where = m.location ?? (m.link ? m.link : null);
      await notificationService.notify(
        {
          userIds: [m.organizerId, ...participants],
          type: 'meeting.reminder',
          title: `Starting soon: ${m.title}`,
          body: `${formatWhen(m.startsAt)}${where ? ` · ${where}` : ''}`,
          link: `/meetings/${m.id}`,
          entityType: 'meeting',
          entityId: m.id,
          email: true,
        },
        tx,
      );
      await tx.update(meetings).set({ reminderSentAt: new Date() }).where(eq(meetings.id, m.id));
    });
  }
}

export const meetingJobs: JobDefinition[] = [
  { name: 'meetings:reminders', schedule: '*/5 * * * *', run: sendMeetingReminders },
];
