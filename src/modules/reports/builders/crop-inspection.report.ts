import { and, asc, between, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.js';
import { greenhouses, inspections, users } from '../../../db/schema/index.js';
import { OBSERVATION_SEVERITIES } from '../../../db/enums.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { clip } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { labelOf, optionalId } from './_shared.js';

const filterSchema = z.object({
  greenhouseId: optionalId,
  severity: z.enum(OBSERVATION_SEVERITIES).optional(),
});
type Filters = z.infer<typeof filterSchema>;

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'greenhouse', label: 'Greenhouse', type: 'text' },
  { key: 'agronomist', label: 'Agronomist', type: 'text' },
  { key: 'findings', label: 'Findings', type: 'text' },
  { key: 'disease', label: 'Disease / pest', type: 'text' },
  { key: 'severity', label: 'Severity', type: 'text' },
  { key: 'treatment', label: 'Treatment', type: 'text' },
  { key: 'fertiliser', label: 'Fertiliser', type: 'text' },
  { key: 'followUp', label: 'Follow-up', type: 'date' },
  { key: 'status', label: 'Status', type: 'text' },
];

/** Crop inspection report (BRD 6, US-AG-002): findings, diseases, treatments, fertiliser. */
export const cropInspectionReport: ReportDefinition<Filters> = {
  key: 'crop-inspection',
  title: 'Crop inspection report',
  description: 'Inspection findings, diseases, treatments and fertiliser recommendations',
  department: 'farm',
  permissions: [P.REPORTS_FARM],
  defaultPeriod: 'month',
  filters: [
    { key: 'greenhouseId', label: 'Greenhouse', source: 'greenhouses' },
    {
      key: 'severity',
      label: 'Severity',
      options: OBSERVATION_SEVERITIES.map((s) => ({ value: s, label: labelOf(s) })),
    },
  ],
  filterSchema,
  async build({ from, to, filters }) {
    const where: SQL[] = [
      isNull(inspections.deletedAt),
      between(inspections.inspectionDate, from, to),
    ];
    if (filters.greenhouseId) where.push(eq(inspections.greenhouseId, filters.greenhouseId));
    if (filters.severity) where.push(eq(inspections.severity, filters.severity));

    const rowsDb = await db
      .select({
        date: inspections.inspectionDate,
        greenhouse: greenhouses.name,
        agronomist: users.name,
        findings: inspections.findings,
        disease: inspections.diseaseIdentified,
        severity: inspections.severity,
        treatment: inspections.recommendedTreatment,
        fertiliser: inspections.recommendedFertiliser,
        followUp: inspections.followUpDate,
        status: inspections.status,
      })
      .from(inspections)
      .innerJoin(greenhouses, eq(greenhouses.id, inspections.greenhouseId))
      .innerJoin(users, eq(users.id, inspections.agronomistId))
      .where(and(...where))
      .orderBy(asc(inspections.inspectionDate), asc(greenhouses.name));

    const rows = rowsDb.map((r) => ({
      ...r,
      findings: clip(r.findings, 400),
      treatment: clip(r.treatment, 300),
      fertiliser: clip(r.fertiliser, 300),
      severity: labelOf(r.severity),
      status: labelOf(r.status),
    }));
    const count = (pred: (r: (typeof rowsDb)[number]) => boolean) => rowsDb.filter(pred).length;

    return {
      columns,
      rows,
      totals: null,
      summary: [
        { label: 'Inspections', value: rows.length, type: 'number' },
        {
          label: 'Greenhouses inspected',
          value: new Set(rowsDb.map((r) => r.greenhouse)).size,
          type: 'number',
        },
        {
          label: 'Diseases / pests identified',
          value: count((r) => Boolean(r.disease)),
          type: 'number',
        },
        { label: 'High severity', value: count((r) => r.severity === 'high'), type: 'number' },
        {
          label: 'Treatments recommended',
          value: count((r) => Boolean(r.treatment)),
          type: 'number',
        },
        { label: 'Still open', value: count((r) => r.status !== 'closed'), type: 'number' },
      ],
    };
  },
};
