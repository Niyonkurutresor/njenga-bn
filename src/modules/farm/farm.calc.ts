/**
 * Pure farm rules and aggregations (no database access), unit-tested in tests/unit/farm.calc.test.ts.
 */
import type {
  CropHealth,
  HarvestGrade,
  HarvestUnit,
  InspectionStatus,
  ObservationSeverity,
} from '../../db/enums.js';
import { HARVEST_GRADES } from '../../db/enums.js';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** FR-FRM-07: alert only when an observation becomes high severity (not on every re-save). */
export function becameHigh(
  before: ObservationSeverity | null | undefined,
  after: ObservationSeverity,
): boolean {
  return after === 'high' && before !== 'high';
}

/** A follow-up is due when its date is today or earlier and the case is not closed. */
export function isFollowUpDue(
  followUpDate: string | null,
  status: InspectionStatus,
  asOf: string,
): boolean {
  return Boolean(followUpDate) && status !== 'closed' && followUpDate! <= asOf;
}

/** Open disease/pest case: anything with a severity that has not been closed. */
export function isOpenCase(severity: ObservationSeverity, status: InspectionStatus): boolean {
  return severity !== 'none' && status !== 'closed';
}

export interface Totals {
  kg: number;
  units: number;
}

export interface HarvestAggRow {
  crop: string;
  greenhouseId: number;
  greenhouseName: string;
  /** YYYY-MM */
  month: string;
  unit: HarvestUnit;
  grade: HarvestGrade;
  quantity: number;
}

const zero = (): Totals => ({ kg: 0, units: 0 });

function add(t: Totals, unit: HarvestUnit, qty: number) {
  t[unit === 'kg' ? 'kg' : 'units'] = round3(t[unit === 'kg' ? 'kg' : 'units'] + qty);
}

function gradeMap(): Record<HarvestGrade, Totals> {
  return Object.fromEntries(HARVEST_GRADES.map((g) => [g, zero()])) as Record<HarvestGrade, Totals>;
}

/**
 * Harvest totals and trends (FR-FRM-09): by crop, by greenhouse and by month, with kg and
 * units kept separate (they cannot be added together) and split by quality grade.
 */
export function summariseHarvests(rows: readonly HarvestAggRow[]) {
  const totals = zero();
  const byGrade = gradeMap();
  const crops = new Map<string, Totals & { grades: Record<HarvestGrade, Totals> }>();
  const houses = new Map<number, Totals & { greenhouseId: number; name: string }>();
  const months = new Map<string, Totals & { grades: Record<HarvestGrade, Totals> }>();
  const monthCrop = new Map<string, Totals & { month: string; crop: string }>();

  for (const r of rows) {
    const qty = Number(r.quantity) || 0;
    add(totals, r.unit, qty);
    add(byGrade[r.grade], r.unit, qty);

    const c = crops.get(r.crop) ?? { ...zero(), grades: gradeMap() };
    add(c, r.unit, qty);
    add(c.grades[r.grade], r.unit, qty);
    crops.set(r.crop, c);

    const h = houses.get(r.greenhouseId) ?? {
      ...zero(),
      greenhouseId: r.greenhouseId,
      name: r.greenhouseName,
    };
    add(h, r.unit, qty);
    houses.set(r.greenhouseId, h);

    const m = months.get(r.month) ?? { ...zero(), grades: gradeMap() };
    add(m, r.unit, qty);
    add(m.grades[r.grade], r.unit, qty);
    months.set(r.month, m);

    const key = `${r.month}|${r.crop}`;
    const mc = monthCrop.get(key) ?? { ...zero(), month: r.month, crop: r.crop };
    add(mc, r.unit, qty);
    monthCrop.set(key, mc);
  }

  const byWeight = (a: Totals, b: Totals) => b.kg - a.kg || b.units - a.units;
  return {
    totals,
    byGrade: HARVEST_GRADES.map((grade) => ({ grade, ...byGrade[grade] })),
    byCrop: [...crops.entries()]
      .map(([crop, t]) => ({ crop, ...t }))
      .sort((a, b) => byWeight(a, b) || a.crop.localeCompare(b.crop)),
    byGreenhouse: [...houses.values()].sort(
      (a, b) => byWeight(a, b) || a.name.localeCompare(b.name),
    ),
    monthly: [...months.entries()]
      .map(([month, t]) => ({ month, ...t }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    monthlyByCrop: [...monthCrop.values()].sort(
      (a, b) => a.month.localeCompare(b.month) || a.crop.localeCompare(b.crop),
    ),
  };
}

export type HarvestSummary = ReturnType<typeof summariseHarvests>;

/** Counts of good / fair / poor across greenhouses (overview, crop report). */
export function healthCounts(values: readonly (CropHealth | null | undefined)[]) {
  const counts = { good: 0, fair: 0, poor: 0, unknown: 0 };
  for (const v of values) counts[v ?? 'unknown']++;
  return counts;
}

/** Highest severity in a list (none < low < medium < high). */
export function worstSeverity(values: readonly ObservationSeverity[]): ObservationSeverity {
  const order: ObservationSeverity[] = ['none', 'low', 'medium', 'high'];
  return values.reduce<ObservationSeverity>(
    (worst, v) => (order.indexOf(v) > order.indexOf(worst) ? v : worst),
    'none',
  );
}
