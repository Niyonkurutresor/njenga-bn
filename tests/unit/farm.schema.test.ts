import { describe, expect, it } from 'vitest';
import {
  createInspectionSchema,
  submitFarmReportSchema,
} from '../../src/modules/farm/farm.schema.js';

const base = { greenhouseId: 1, inspectionDate: '2026-11-18' };

describe('inspection findings (rich text or report file)', () => {
  it('requires findings when no report file is attached', () => {
    expect(createInspectionSchema.safeParse({ ...base, findings: '<p></p>' }).success).toBe(false);
    expect(createInspectionSchema.safeParse(base).success).toBe(false);
  });
  it('accepts an empty body when the report is attached as a file', () => {
    const r = createInspectionSchema.safeParse({ ...base, findings: '', withReportFile: true });
    expect(r.success).toBe(true);
    expect(r.data?.findings).toBeNull();
  });
  it('sanitises the HTML', () => {
    const r = createInspectionSchema.parse({
      ...base,
      findings: '<p onclick="x()">Blight<script>alert(1)</script></p>',
      recommendedTreatment: '<p><strong>Copper</strong></p>',
    });
    expect(r.findings).toBe('<p>Blight</p>');
    expect(r.recommendedTreatment).toBe('<p><strong>Copper</strong></p>');
  });
});

describe('daily report body', () => {
  it('stores the general notes as sanitised rich text, empty as null', () => {
    const entries = [{ greenhouseId: 1 }];
    expect(
      submitFarmReportSchema.parse({ entries, generalNotes: '<h2>Day</h2><img src=x>' })
        .generalNotes,
    ).toBe('<h2>Day</h2>');
    expect(submitFarmReportSchema.parse({ entries, generalNotes: '<p></p>' }).generalNotes).toBe(
      null,
    );
  });
});
