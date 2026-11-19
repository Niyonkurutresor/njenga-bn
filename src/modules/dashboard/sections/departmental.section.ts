import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { reportRequestService } from '../../reports/report-requests.service.js';
import { reportsService } from '../../reports/reports.service.js';
import type { Kpi, SectionBuilder } from '../dashboard.types.js';

export interface DepartmentalSection {
  kpis: Kpi[];
  departments: Awaited<ReturnType<typeof reportsService.departmental>>['departments'];
}

/** Director: departmental reports with missing daily reports flagged (US-CEO-002, FR-RPT-04). */
export const departmentalSection: SectionBuilder<DepartmentalSection> = {
  key: 'departmental',
  visible: (ctx) => ctx.can(P.REPORT_REQUESTS_CREATE),
  async build(ctx) {
    const [status, counts] = await Promise.all([
      reportsService.departmental(ctx.today),
      reportRequestService.counts(ctx.user),
    ]);
    const missing = status.departments.filter((d) => d.missing).length;
    return {
      kpis: [
        {
          key: 'missing',
          label: 'Missing daily reports',
          value: missing,
          format: 'number',
          tone: missing ? 'red' : 'green',
          link: '/reports/departmental',
        },
        {
          key: 'requests',
          label: 'Report requests open',
          value: counts.sentOpen,
          format: 'number',
          tone: counts.sentOverdue ? 'red' : 'neutral',
          hint: `${counts.sentOverdue} overdue`,
          link: '/reports/requests?box=sent',
        },
      ],
      departments: status.departments,
    };
  },
};
