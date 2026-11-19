import { db } from '../../db/client.js';
import { today } from '../../common/utils/dates.js';
import { PERMISSIONS as P } from '../../rbac/permissions.js';
import type { JobDefinition } from '../../jobs/job.types.js';
import { notificationService } from '../notifications/notifications.service.js';
import { formatCell, formatDateLabel } from './reports.format.js';
import { reportsService } from './reports.service.js';

/**
 * FR-RPT-02: generate the day's financial report automatically, store it in
 * `daily_financial_reports` (upsert by date) and tell finance-report holders.
 */
export async function generateDailyFinancialReport(date = today()): Promise<void> {
  const result = await reportsService.saveDailyFinancialSnapshot(date);
  const pick = (label: string) => {
    const item = result.summary.find((s) => s.label === label);
    return item ? `RWF ${formatCell(item.value, item.type)}` : '—';
  };
  await db.transaction(async (tx) => {
    await notificationService.notify(
      {
        userIds: await notificationService.userIdsWithPermission(P.REPORTS_FINANCE, tx),
        type: 'report.daily_financial',
        title: `Daily financial report — ${formatDateLabel(date)}`,
        body: `Payments ${pick('Payments made')} · received ${pick('Money received')} · cash position ${pick('Cash position (closing)')}`,
        link: `/reports/daily-financial?from=${date}&to=${date}`,
        entityType: 'daily_financial_report',
        entityId: date,
      },
      tx,
    );
  });
}

export const reportJobs: JobDefinition[] = [
  {
    name: 'reports:daily-financial',
    schedule: '55 23 * * *',
    run: () => generateDailyFinancialReport(),
  },
];
