import {
  boolean,
  date,
  decimal,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
  mediumtext,
} from 'drizzle-orm/mysql-core';
import {
  CROP_HEALTH,
  HARVEST_GRADES,
  HARVEST_UNITS,
  INSPECTION_STATUSES,
  OBSERVATION_SEVERITIES,
  PLOT_KINDS,
  PLOT_STATUSES,
} from '../enums.js';
import { id, quantity, ref, softDelete, timestamps } from './_columns.js';
import { users } from './auth.js';

/** Greenhouses and field blocks register (FR-FRM-01). */
export const greenhouses = mysqlTable(
  'greenhouses',
  {
    id: id(),
    name: varchar('name', { length: 100 }).notNull(),
    kind: mysqlEnum('kind', PLOT_KINDS).notNull().default('greenhouse'),
    sizeSqm: decimal('size_sqm', { precision: 12, scale: 2, mode: 'number' }),
    currentCrop: varchar('current_crop', { length: 100 }),
    plantingDate: date('planting_date', { mode: 'string' }),
    status: mysqlEnum('status', PLOT_STATUSES).notNull().default('active'),
    notes: text('notes'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [uniqueIndex('greenhouses_name_uq').on(t.name)],
);

/** Farm Manager daily report header (FR-FRM-02). One per day. */
export const farmReports = mysqlTable(
  'farm_reports',
  {
    id: id(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    submittedBy: ref('submitted_by')
      .notNull()
      .references(() => users.id),
    irrigationNotes: text('irrigation_notes'),
    visitors: text('visitors'),
    equipmentCondition: text('equipment_condition'),
    generalNotes: mediumtext('general_notes'),
    clientRef: varchar('client_ref', { length: 64 }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('farm_reports_date_uq').on(t.reportDate),
    uniqueIndex('farm_reports_client_ref_uq').on(t.clientRef),
  ],
);

/** Per-greenhouse observations within a daily farm report (crop health, pests — US-FM-002). */
export const farmReportEntries = mysqlTable(
  'farm_report_entries',
  {
    id: id(),
    reportId: ref('report_id')
      .notNull()
      .references(() => farmReports.id, { onDelete: 'cascade' }),
    greenhouseId: ref('greenhouse_id')
      .notNull()
      .references(() => greenhouses.id),
    greenhouseStatus: varchar('greenhouse_status', { length: 191 }),
    cropHealth: mysqlEnum('crop_health', CROP_HEALTH).notNull().default('good'),
    irrigationDone: boolean('irrigation_done').notNull().default(false),
    pestsObserved: text('pests_observed'),
    severity: mysqlEnum('severity', OBSERVATION_SEVERITIES).notNull().default('none'),
  },
  (t) => [uniqueIndex('farm_report_entries_uq').on(t.reportId, t.greenhouseId)],
);

/** Harvest records (FR-FRM-03). */
export const harvests = mysqlTable(
  'harvests',
  {
    id: id(),
    greenhouseId: ref('greenhouse_id')
      .notNull()
      .references(() => greenhouses.id),
    crop: varchar('crop', { length: 100 }).notNull(),
    quantity: quantity('quantity').notNull(),
    unit: mysqlEnum('unit', HARVEST_UNITS).notNull().default('kg'),
    grade: mysqlEnum('grade', HARVEST_GRADES).notNull().default('A'),
    harvestDate: date('harvest_date', { mode: 'string' }).notNull(),
    notes: text('notes'),
    recordedBy: ref('recorded_by')
      .notNull()
      .references(() => users.id),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('harvests_date_idx').on(t.harvestDate),
    index('harvests_gh_idx').on(t.greenhouseId),
  ],
);

/** Agronomist inspections (FR-FRM-06..08). Photos are `documents` with entity_type 'inspection'. */
export const inspections = mysqlTable(
  'inspections',
  {
    id: id(),
    greenhouseId: ref('greenhouse_id')
      .notNull()
      .references(() => greenhouses.id),
    agronomistId: ref('agronomist_id')
      .notNull()
      .references(() => users.id),
    inspectionDate: date('inspection_date', { mode: 'string' }).notNull(),
    findings: mediumtext('findings').notNull(),
    diseaseIdentified: varchar('disease_identified', { length: 191 }),
    severity: mysqlEnum('severity', OBSERVATION_SEVERITIES).notNull().default('none'),
    recommendedTreatment: mediumtext('recommended_treatment'),
    recommendedFertiliser: mediumtext('recommended_fertiliser'),
    followUpDate: date('follow_up_date', { mode: 'string' }),
    status: mysqlEnum('status', INSPECTION_STATUSES).notNull().default('open'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('inspections_gh_idx').on(t.greenhouseId, t.inspectionDate)],
);
