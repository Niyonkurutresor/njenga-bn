import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import { today } from '../../common/utils/dates.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { leadService } from './leads.service.js';

/**
 * FR-BDV-03, US-BD-004 AC2: on the follow-up date, remind the lead owner (in-app + email).
 * `followUpNotifiedAt` is cleared whenever the follow-up date changes, so each date fires once.
 */
export async function sendLeadFollowUpReminders(): Promise<void> {
  const due = await leadService.dueFollowUps(today());
  for (const lead of due) {
    await db.transaction(async (tx) => {
      await notificationService.notify(
        {
          userIds: [lead.ownerId],
          type: 'lead.follow_up',
          title: `Follow up today: ${lead.title}`,
          body: `${lead.companyName} — follow-up due ${lead.followUpDate}`,
          link: `/crm/leads/${lead.id}`,
          entityType: 'lead',
          entityId: lead.id,
          email: true,
        },
        tx,
      );
      await tx
        .update(leads)
        .set({ followUpNotifiedAt: new Date() })
        .where(and(eq(leads.id, lead.id), isNull(leads.followUpNotifiedAt)));
    });
  }
}

export const crmJobs: JobDefinition[] = [
  { name: 'crm:lead-follow-ups', schedule: '0 7 * * *', run: sendLeadFollowUpReminders },
];
