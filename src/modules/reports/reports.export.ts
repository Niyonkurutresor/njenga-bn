import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import PdfDocument from 'pdfkit';
import {
  columnWidths,
  formatCell,
  formatDateLabel,
  formatPeriod,
  pdfColumnWeights,
} from './reports.format.js';
import type { ReportColumn, ReportResult, ReportRow, ReportTable } from './report.types.js';

/** Report exports (FR-RPT-03): PDF via pdfkit, Excel via exceljs. */

const BRAND = '#2f6b3a';
const BRAND_LIGHT = '#e8f1ea';
const TEXT = '#1e293b';
const MUTED = '#64748b';
const RED = '#b91c1c';
const FOOTER = 'Confidential | Njenga Greens (NGL)';

function allTables(report: ReportResult): ReportTable[] {
  return [
    { key: 'main', title: '', columns: report.columns, rows: report.rows, totals: report.totals },
    ...(report.sections ?? []),
  ];
}

function generatedLabel(iso: string): string {
  return `${formatDateLabel(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------- PDF

type Doc = PDFKit.PDFDocument;

function drawBrandHeader(doc: Doc, report: ReportResult) {
  const { width } = doc.page;
  doc.save().rect(0, 0, width, 58).fill(BRAND).restore();
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(16)
    .text('Njenga Greens', 36, 16, { lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).text('NGL Management System', 36, 36, { lineBreak: false });
  doc.fontSize(8.5).text(`Generated ${generatedLabel(report.generatedAt)}`, 36, 36, {
    width: width - 72,
    align: 'right',
    lineBreak: false,
  });
  doc.fillColor(TEXT);
  doc.x = 36;
  doc.y = 74;
  doc.font('Helvetica-Bold').fontSize(15).text(report.title);
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(`Period: ${formatPeriod(report.period.from, report.period.to)}`);
  const filters = Object.entries(report.filters).filter(([, v]) => v !== undefined && v !== '');
  if (filters.length) {
    doc.text(`Filters: ${filters.map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`);
  }
  doc.fillColor(TEXT).moveDown(0.6);
}

function drawSummary(doc: Doc, report: ReportResult) {
  if (!report.summary.length) return;
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const perRow = usable > 600 ? 4 : 3;
  const gap = 8;
  const boxW = (usable - gap * (perRow - 1)) / perRow;
  const boxH = 38;
  let y = doc.y;
  report.summary.forEach((item, i) => {
    const col = i % perRow;
    if (col === 0 && i > 0) y += boxH + gap;
    if (y + boxH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
    }
    const x = left + col * (boxW + gap);
    doc.save().roundedRect(x, y, boxW, boxH, 4).fill(BRAND_LIGHT).restore();
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(item.label, x + 7, y + 6, { width: boxW - 14, lineBreak: false, ellipsis: true });
    const value = formatCell(item.value, item.type);
    const negative = (item.type === 'money' || item.type === 'number') && Number(item.value) < 0;
    doc
      .fillColor(negative ? RED : TEXT)
      .font('Helvetica-Bold')
      .fontSize(item.type === 'text' ? 8 : 11)
      .text(item.type === 'money' ? `RWF ${value}` : value, x + 7, y + 18, {
        width: boxW - 14,
        height: 16,
        lineBreak: item.type === 'text',
        ellipsis: true,
      });
  });
  doc.fillColor(TEXT);
  doc.x = left;
  doc.y = y + boxH + 14;
}

function cellText(row: ReportRow, col: ReportColumn): string {
  return formatCell(row[col.key], col.type);
}

function drawTable(doc: Doc, table: ReportTable) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const weights = pdfColumnWeights(table.columns, table.rows);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / totalWeight) * usable);
  const pad = 3;
  const fontSize = table.columns.length > 8 ? 7 : 8;

  if (table.title) {
    if (doc.y + 60 > bottom()) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND).text(table.title, left, doc.y);
    doc.fillColor(TEXT).moveDown(0.3);
  }

  const rowHeight = (row: ReportRow | null, bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    let h = 0;
    table.columns.forEach((c, i) => {
      const text = row ? cellText(row, c) : c.label;
      h = Math.max(h, doc.heightOfString(text, { width: widths[i]! - pad * 2 }));
    });
    return Math.min(h, 110) + pad * 2;
  };

  const drawRow = (
    row: ReportRow | null,
    y: number,
    h: number,
    kind: 'header' | 'body' | 'total',
    zebra: boolean,
  ) => {
    if (kind === 'header') doc.save().rect(left, y, usable, h).fill(BRAND).restore();
    else if (kind === 'total') doc.save().rect(left, y, usable, h).fill(BRAND_LIGHT).restore();
    else if (zebra) doc.save().rect(left, y, usable, h).fill('#f8fafc').restore();
    let x = left;
    table.columns.forEach((c, i) => {
      const w = widths[i]!;
      const raw = row ? row[c.key] : null;
      const text = row ? (raw === undefined && kind === 'total' ? '' : cellText(row, c)) : c.label;
      const numeric = c.type !== 'text' && c.type !== 'date';
      const negative = row && numeric && Number(raw) < 0;
      doc
        .font(kind === 'body' ? 'Helvetica' : 'Helvetica-Bold')
        .fontSize(fontSize)
        .fillColor(kind === 'header' ? '#ffffff' : negative ? RED : TEXT)
        .text(text, x + pad, y + pad, {
          width: w - pad * 2,
          height: h - pad * 2,
          align: numeric ? 'right' : 'left',
          ellipsis: true,
        });
      x += w;
    });
    doc.fillColor(TEXT);
  };

  const header = () => {
    const h = rowHeight(null, true);
    if (doc.y + h > bottom()) doc.addPage();
    const y = doc.y;
    drawRow(null, y, h, 'header', false);
    doc.y = y + h;
  };

  header();
  if (!table.rows.length) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(MUTED)
      .text('No records for this period.', left + pad, doc.y + 6);
    doc.fillColor(TEXT).moveDown(1);
    return;
  }
  table.rows.forEach((row, idx) => {
    const h = rowHeight(row, false);
    if (doc.y + h > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    drawRow(row, y, h, 'body', idx % 2 === 1);
    doc.y = y + h;
  });
  if (table.totals) {
    const h = rowHeight(table.totals, true);
    if (doc.y + h > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    drawRow(table.totals, y, h, 'total', false);
    doc.y = y + h;
  }
  doc.x = left;
  doc.moveDown(1.2);
}

/** Streams the report as a branded PDF with page-x-of-y footers. */
export async function writeReportPdf(report: ReportResult, out: Writable): Promise<void> {
  const wide = allTables(report).some((t) => t.columns.length > 6);
  const doc = new PdfDocument({
    size: 'A4',
    layout: wide ? 'landscape' : 'portrait',
    margins: { top: 40, bottom: 44, left: 36, right: 36 },
    bufferPages: true,
    info: {
      Title: report.title,
      Author: 'Njenga Greens (NGL)',
      Subject: formatPeriod(report.period.from, report.period.to),
    },
  });
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    doc.on('error', reject);
  });
  doc.pipe(out);

  // Continuation pages carry a slim header with the report title.
  doc.on('pageAdded', () => {
    doc.save().rect(0, 0, doc.page.width, 4).fill(BRAND).restore();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        `Njenga Greens · ${report.title} · ${formatPeriod(report.period.from, report.period.to)}`,
        36,
        14,
        {
          lineBreak: false,
        },
      );
    doc.fillColor(TEXT);
    doc.x = 36;
    doc.y = 32;
  });

  drawBrandHeader(doc, report);
  drawSummary(doc, report);
  for (const table of allTables(report)) drawTable(doc, table);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`${FOOTER} · Page ${i - range.start + 1} of ${range.count}`, 36, doc.page.height - 28, {
        width: doc.page.width - 72,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  await done;
}

// ---------------------------------------------------------------- Excel

function sheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    candidate = `${base.slice(0, 28)} ${i}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function excelValue(value: unknown, col: ReportColumn): ExcelJS.CellValue {
  if (value === null || value === undefined || value === '') return null;
  if (col.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return new Date(`${value.slice(0, 10)}T00:00:00Z`);
  }
  if (col.type !== 'text') {
    const n = Number(value);
    return Number.isFinite(n) ? n : String(value);
  }
  return String(value);
}

const NUM_FMT: Record<ReportColumn['type'], string | undefined> = {
  money: '#,##0',
  percent: '0.0"%"',
  date: 'dd mmm yyyy',
  number: undefined,
  text: undefined,
};

function addTableSheet(
  wb: ExcelJS.Workbook,
  name: string,
  heading: string,
  period: string,
  table: ReportTable,
) {
  const ws = wb.addWorksheet(name);
  ws.getCell('A1').value = heading;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF2F6B3A' } };
  ws.getCell('A2').value = `Njenga Greens (NGL) · ${period}`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };

  const headerRowNo = 4;
  const header = ws.getRow(headerRowNo);
  table.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6B3A' } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: c.type === 'text' || c.type === 'date' ? 'left' : 'right',
    };
  });
  header.height = 20;

  table.rows.forEach((row) => {
    ws.addRow(table.columns.map((c) => excelValue(row[c.key], c)));
  });
  if (!table.rows.length) {
    ws.addRow(['No records for this period.']).font = { italic: true, color: { argb: 'FF64748B' } };
  }
  if (table.totals) {
    const totals = table.totals;
    const r = ws.addRow(table.columns.map((c) => excelValue(totals[c.key], c)));
    r.font = { bold: true };
    r.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EA' } };
      cell.border = { top: { style: 'thin', color: { argb: 'FF2F6B3A' } } };
    });
  }

  const widths = columnWidths(table.columns, [
    ...table.rows,
    ...(table.totals ? [table.totals] : []),
  ]);
  table.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = widths[i];
    const fmt = NUM_FMT[c.type];
    if (fmt) col.numFmt = fmt;
  });
  ws.views = [{ state: 'frozen', ySplit: headerRowNo }];
  if (table.rows.length) {
    ws.autoFilter = {
      from: { row: headerRowNo, column: 1 },
      to: { row: headerRowNo, column: table.columns.length },
    };
  }
}

/** Streams the report as an Excel workbook: main table, one sheet per section, then the summary. */
export async function writeReportXlsx(report: ReportResult, out: Writable): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Njenga Greens (NGL)';
  wb.created = new Date(report.generatedAt);
  const period = formatPeriod(report.period.from, report.period.to);
  const used = new Set<string>();

  addTableSheet(wb, sheetName(report.title, used), report.title, period, {
    key: 'main',
    title: report.title,
    columns: report.columns,
    rows: report.rows,
    totals: report.totals,
  });
  for (const section of report.sections ?? []) {
    addTableSheet(
      wb,
      sheetName(section.title, used),
      `${report.title} — ${section.title}`,
      period,
      section,
    );
  }

  const ws = wb.addWorksheet(sheetName('Summary', used));
  ws.addRow([report.title]).font = { bold: true, size: 14, color: { argb: 'FF2F6B3A' } };
  ws.addRow([`Period: ${period}`]);
  ws.addRow([`Generated: ${generatedLabel(report.generatedAt)}`]);
  ws.addRow([]);
  const head = ws.addRow(['Item', 'Value']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6B3A' } };
  });
  for (const item of report.summary) {
    const r = ws.addRow([
      item.label,
      excelValue(item.value, { key: 'v', label: '', type: item.type }),
    ]);
    const fmt = NUM_FMT[item.type];
    if (fmt) r.getCell(2).numFmt = fmt;
  }
  ws.getColumn(1).width = 36;
  ws.getColumn(2).width = 28;
  ws.addRow([]);
  ws.addRow([FOOTER]).font = { italic: true, color: { argb: 'FF64748B' } };

  await wb.xlsx.write(out);
  if (!out.writableEnded) out.end();
}
