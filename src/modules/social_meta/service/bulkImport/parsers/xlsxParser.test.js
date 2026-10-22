import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { parseXlsx } from './xlsxParser.js';
import { BULK_ERROR, BULK_IMPORT_LIMITS } from '../bulkImportConstants.js';

/** Bulk Upload — Phase 2 XLSX parser. Pure; workbooks are built in-memory. */

const HEADER = ['platform', 'content', 'media_urls', 'scheduled_at', 'timezone', 'action'];

async function xlsxBuffer(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseXlsx — well-formed', () => {
  test('reads the first worksheet, header + data rows, real row numbers', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('Posts');
      ws.addRow(HEADER);
      ws.addRow(['facebook', 'Hello', '', '', '', 'draft']);
      ws.addRow(['instagram', 'Hi', 'https://x/a.jpg', '', '', 'draft']);
    });
    const r = await parseXlsx(b);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.headers, HEADER);
    assert.deepEqual(r.rows.map((x) => x.rowNumber), [2, 3]);
    assert.equal(r.rows[0].cells[0], 'facebook');
  });

  test('only the FIRST worksheet is read', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws1 = wb.addWorksheet('First');
      ws1.addRow(HEADER);
      ws1.addRow(['facebook', 'from first', '', '', '', 'draft']);
      const ws2 = wb.addWorksheet('Second');
      ws2.addRow(HEADER);
      ws2.addRow(['instagram', 'from second', '', '', '', 'draft']);
    });
    const r = await parseXlsx(b);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].cells[1], 'from first');
  });

  test('a formula cell contributes its CACHED result, never an evaluation', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(HEADER);
      const row = ws.addRow(['facebook', '', '', '', '', 'draft']);
      row.getCell(2).value = { formula: 'A1&"-x"', result: 'safe cached text' };
    });
    const r = await parseXlsx(b);
    assert.equal(r.rows[0].cells[1], 'safe cached text');
  });

  test('a formula cell with no cached result reads as empty', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(HEADER);
      const row = ws.addRow(['facebook', 'ok', '', '', '', 'draft']);
      row.getCell(3).value = { formula: 'SUM(1,2)' };
    });
    const r = await parseXlsx(b);
    assert.equal(r.rows[0].cells[2], '');
  });

  test('trailing empty rows are ignored', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(HEADER);
      ws.addRow(['facebook', 'Hello', '', '', '', 'draft']);
      ws.addRow([]);
      ws.addRow([]);
    });
    const r = await parseXlsx(b);
    assert.equal(r.rows.length, 1);
  });
});

describe('parseXlsx — file-level rejections', () => {
  test('not a workbook at all is MALFORMED_XLSX', async () => {
    const r = await parseXlsx(Buffer.from('this is not a zip / xlsx', 'utf8'));
    assert.equal(r.error.code, BULK_ERROR.MALFORMED_XLSX);
  });

  test('empty buffer', async () => {
    assert.equal((await parseXlsx(Buffer.alloc(0))).error.code, BULK_ERROR.EMPTY_FILE);
  });

  test('header row but no data rows', async () => {
    const b = await xlsxBuffer((wb) => { wb.addWorksheet('S').addRow(HEADER); });
    assert.equal((await parseXlsx(b)).error.code, BULK_ERROR.EMPTY_FILE);
  });

  test('too many columns', async () => {
    const wide = Array.from({ length: BULK_IMPORT_LIMITS.MAX_COLUMNS + 1 }, (_, i) => `c${i}`);
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(wide);
      ws.addRow(wide.map(() => 'x'));
    });
    assert.equal((await parseXlsx(b)).error.code, BULK_ERROR.TOO_MANY_COLUMNS);
  });

  test('too many rows', async () => {
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(HEADER);
      for (let i = 0; i < BULK_IMPORT_LIMITS.MAX_ROWS + 1; i += 1) ws.addRow(['facebook', `r${i}`, '', '', '', 'draft']);
    });
    assert.equal((await parseXlsx(b)).error.code, BULK_ERROR.TOO_MANY_ROWS);
  });

  test('an oversized cell', async () => {
    const big = 'x'.repeat(BULK_IMPORT_LIMITS.MAX_CELL_CHARS + 1);
    const b = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(HEADER);
      ws.addRow(['facebook', big, '', '', '', 'draft']);
    });
    assert.equal((await parseXlsx(b)).error.code, BULK_ERROR.CELL_TOO_LARGE);
  });
});
