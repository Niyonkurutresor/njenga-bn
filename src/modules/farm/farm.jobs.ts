import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { greenhouses, inspections } from '../../db/schema/index.js';
import { today } from '../../common/utils/dates.js';
import { richTextToPlain } from '../../common/utils/rich-text.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { farmReportService } from './farm-reports.service.js';
import { farmManagerIds } from './farm.recipients.js';

/** US-FM-001 AC2: remind Farm Managers when today's daily report has not been submitted. */
export async function remindDailyReport(): Promise<void> {
  const date = today();
  if (await farmReportService.isSubmitted(date)) return;
  await notificationService.notify({
    userIds: await farmManagerIds(),
    type: 'farm.report_reminder',
    title: "Today's farm report has not been submitted",
    body: `Please submit the daily farm report for ${date}.`,
    link: `/farm/reports/daily?date=${date}`,
    entityType: 'farm_report',
    sms: true,
  });
}

/** Agronomist dashboard: treatment follow-ups due today (FR-FRM-08). */
export async function notifyInspectionFollowUps(): Promise<void> {
  const date = today();
  const due = await db
    .select({
      id: inspections.id,
      agronomistId: inspections.agronomistId,
      diseaseIdentified: inspections.diseaseIdentified,
      recommendedTreatment: inspections.recommendedTreatment,
      greenhouse: greenhouses.name,
    })
    .from(inspections)
    .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
    .where(
      and(
        isNull(inspections.deletedAt),
        eq(inspections.followUpDate, date),
        ne(inspections.status, 'closed'),
      ),
    );
  for (const i of due) {
    await notificationService.notify({
      userIds: [i.agronomistId],
      type: 'farm.inspection_follow_up',
      title:
        `Follow-up due today: ${i.greenhouse}${i.diseaseIdentified ? ` (${i.diseaseIdentified})` : ''}`.slice(
          0,
          200,
        ),
      body: i.recommendedTreatment
        ? `Treatment: ${richTextToPlain(i.recommendedTreatment)}`.slice(0, 2000)
        : undefined,
      link: `/farm/inspections/${i.id}`,
      entityType: 'inspection',
      entityId: i.id,
    });
  }
}

export const farmJobs: JobDefinition[] = [
  { name: 'farm:daily-report-reminder', schedule: '0 17 * * *', run: remindDailyReport },
  { name: 'farm:inspection-follow-ups', schedule: '0 7 * * *', run: notifyInspectionFollowUps },
];
