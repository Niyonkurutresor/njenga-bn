import { and, asc, between, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  attendance,
  farmReportEntries,
  farmReports,
  greenhouses,
  harvests,
  users,
} from '../../../db/schema/index.js';
import { round2, toNumber } from '../../../common/utils/money.js';
import { PERMISSIONS as P } from '../../../rbac/permissions.js';
import { clip, computeTotals } from '../reports.format.js';
import type { ReportColumn, ReportDefinition } from '../report.types.js';
import { labelOf, noFilters } from './_shared.js';

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'greenhouse', label: 'Greenhouse / block', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'cropHealth', label: 'Crop health', type: 'text' },
  { key: 'irrigation', label: 'Irrigated', type: 'text' },
  { key: 'pests', label: 'Pests & diseases', type: 'text' },
  { key: 'severity', label: 'Severity', type: 'text' },
];

const notesColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'submittedBy', label: 'Submitted by', type: 'text' },
  { key: 'irrigation', label: 'Irrigation', type: 'text' },
  { key: 'visitors', label: 'Visitors', type: 'text' },
  { key: 'equipment', label: 'Equipment condition', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'text' },
];

const harvestColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'greenhouse', label: 'Greenhouse', type: 'text' },
  { key: 'crop', label: 'Crop', type: 'text' },
  { key: 'grade', label: 'Grade', type: 'text' },
  { key: 'unit', label: 'Unit', type: 'text' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
];

const attendanceColumns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'present', label: 'Present', type: 'number' },
  { key: 'absent', label: 'Absent', type: 'number' },
];

/**
 * Daily farm report (BRD 6, FR-FRM-02..04): greenhouses, crop health, irrigation, pests,
 * attendance, harvest, visitors and equipment for the period.
 */
export const dailyFarmReport: ReportDefinition = {
  key: 'daily-farm',
  title: 'Daily farm report',
  description:
    'Greenhouses, crop health, irrigation, pests, attendance, harvest, visitors, equipment',
  department: 'farm',
  permissions: [P.REPORTS_FARM],
  defaultPeriod: 'day',
  filters: [],
  filterSchema: noFilters,
  async build({ from, to }) {
    const [entries, headers, harvestRows, attendanceRows] = await Promise.all([
      db
        .select({
          date: farmReports.reportDate,
          greenhouse: greenhouses.name,
          status: farmReportEntries.greenhouseStatus,
          cropHealth: farmReportEntries.cropHealth,
          irrigationDone: farmReportEntries.irrigationDone,
          pests: farmReportEntries.pestsObserved,
          severity: farmReportEntries.severity,
        })
        .from(farmReportEntries)
        .innerJoin(farmReports, eq(farmReports.id, farmReportEntries.reportId))
        .innerJoin(greenhouses, eq(greenhouses.id, farmReportEntries.greenhouseId))
        .where(between(farmReports.reportDate, from, to))
        .orderBy(asc(farmReports.reportDate), asc(greenhouses.name)),
      db
        .select({
          date: farmReports.reportDate,
          submittedBy: users.name,
          irrigation: farmReports.irrigationNotes,
          visitors: farmReports.visitors,
          equipment: farmReports.equipmentCondition,
          notes: farmReports.generalNotes,
        })
        .from(farmReports)
        .innerJoin(users, eq(users.id, farmReports.submittedBy))
        .where(between(farmReports.reportDate, from, to))
        .orderBy(asc(farmReports.reportDate)),
      db
        .select({
          date: harvests.harvestDate,
          greenhouse: greenhouses.name,
          crop: harvests.crop,
          grade: harvests.grade,
          unit: harvests.unit,
          quantity: harvests.quantity,
        })
        .from(harvests)
        .innerJoin(greenhouses, eq(greenhouses.id, harvests.greenhouseId))
        .where(and(isNull(harvests.deletedAt), between(harvests.harvestDate, from, to)))
        .orderBy(asc(harvests.harvestDate), asc(greenhouses.name)),
      db
        .select({
          date: attendance.workDate,
          present: sql<number>`SUM(CASE WHEN ${attendance.present} = 1 THEN 1 ELSE 0 END)`,
          absent: sql<number>`SUM(CASE WHEN ${attendance.present} = 0 THEN 1 ELSE 0 END)`,
        })
        .from(attendance)
        .where(and(eq(attendance.siteType, 'farm'), between(attendance.workDate, from, to)))
        .groupBy(attendance.workDate)
        .orderBy(asc(attendance.workDate)),
    ]);

    const rows = entries.map((e) => ({
      date: e.date,
      greenhouse: e.greenhouse,
      status: e.status,
      cropHealth: labelOf(e.cropHealth),
      irrigation: e.irrigationDone ? 'Yes' : 'No',
      pests: clip(e.pests, 200),
      severity: labelOf(e.severity),
    }));
    const harvestTable = harvestRows.map((h) => ({ ...h, quantity: toNumber(h.quantity) }));
    const attTable = attendanceRows.map((a) => ({
      date: a.date,
      present: Number(a.present ?? 0),
      absent: Number(a.absent ?? 0),
    }));
    const kg = round2(
      harvestTable.filter((h) => h.unit === 'kg').reduce((a, h) => a + h.quantity, 0),
    );
    const units = round2(
      harvestTable.filter((h) => h.unit === 'units').reduce((a, h) => a + h.quantity, 0),
    );
    const health = (h: string) => entries.filter((e) => e.cropHealth === h).length;

    return {
      columns,
      rows,
      totals: null,
      summary: [
        { label: 'Daily reports submitted', value: headers.length, type: 'number' },
        { label: 'Greenhouse observations', value: rows.length, type: 'number' },
        {
          label: 'Good / fair / poor',
          value: `${health('good')} / ${health('fair')} / ${health('poor')}`,
          type: 'text',
        },
        {
          label: 'High-severity pests/diseases',
          value: entries.filter((e) => e.severity === 'high').length,
          type: 'number',
        },
        { label: 'Harvest (kg)', value: kg, type: 'number' },
        { label: 'Harvest (units)', value: units, type: 'number' },
        {
          label: 'Worker-days present',
          value: attTable.reduce((a, r) => a + r.present, 0),
          type: 'number',
        },
      ],
      sections: [
        {
          key: 'notes',
          title: 'Irrigation, visitors and equipment',
          columns: notesColumns,
          rows: headers.map((h) => ({
            ...h,
            irrigation: clip(h.irrigation, 300),
            visitors: clip(h.visitors, 300),
            equipment: clip(h.equipment, 300),
            notes: clip(h.notes, 300),
          })),
          totals: null,
        },
        {
          key: 'harvests',
          title: 'Harvests',
          columns: harvestColumns,
          rows: harvestTable,
          totals: null,
        },
        {
          key: 'attendance',
          title: 'Farm worker attendance',
          columns: attendanceColumns,
          rows: attTable,
          totals: computeTotals(attendanceColumns, attTable, ['present', 'absent']),
        },
      ],
    };
  },
};
