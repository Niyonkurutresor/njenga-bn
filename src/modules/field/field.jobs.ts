import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { progressReports, projectMembers, projects } from '../../db/schema/index.js';
import { today } from '../../common/utils/dates.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { usersWithOpenProjectTasks } from '../tasks/tasks.service.js';

/**
 * 18:00 reminder (US-TECH-001, NFR-08): technicians on a project in execution — as team
 * members or with open tasks on it — who have not submitted a progress report today.
 */
async function remindMissingProgressReports(): Promise<void> {
  const date = today();
  const [technicians, members, withTasks, reported] = await Promise.all([
    notificationService.userIdsWithPermission(P.FIELD_REPORTS_SUBMIT),
    db
      .selectDistinct({ id: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(isNull(projects.deletedAt), eq(projects.status, 'in_execution'))),
    usersWithOpenProjectTasks(),
    db
      .selectDistinct({ id: progressReports.technicianId })
      .from(progressReports)
      .where(eq(progressReports.reportDate, date)),
  ]);
  const onSite = new Set([...members.map((m) => m.id), ...withTasks]);
  const done = new Set(reported.map((r) => r.id));
  const due = technicians.filter((id) => onSite.has(id) && !done.has(id));
  if (!due.length) return;
  await notificationService.notify({
    userIds: due,
    type: 'field.report_reminder',
    title: 'Reminder: submit today’s progress report',
    body: 'Your project is in execution and no progress report has been sent today.',
    link: '/field/reports/new',
  });
}

export const fieldJobs: JobDefinition[] = [
  { name: 'field:report-reminder', schedule: '0 18 * * *', run: remindMissingProgressReports },
];
