import ExcelJS from 'exceljs';
import { BULK_IMPORT_LIMITS, BULK_ERROR } from '../bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 XLSX parser. Buffer in, structured rows out —
 * the SAME `{ headers, rows }` / `{ error }` contract as csvParser.js.
 *
 * Security:
 *  - The workbook is only ever READ. Formulas are never evaluated — a
 *    formula cell contributes its cached `result` (plain data), nothing
 *    is computed.
 *  - No macros are run. Macro-enabled `.xlsm` is rejected earlier by the
 *    upload middleware's extension allow-list; this parser also never
 *    executes anything.
 *  - Only the FIRST worksheet is read.
 */

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    // Surface a date cell as "YYYY-MM-DD HH:mm:ss" so the schedule parser
    // can read it; users are still encouraged to use plain text.
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'object') {
    // Formula: use the CACHED result only — never evaluate.
    if ('formula' in value || 'sharedFormula' in value) {
      const r = value.result;
      if (r === null || r === undefined) return '';
      if (r instanceof Date) return r.toISOString().slice(0, 19).replace('T', ' ');
      if (typeof r === 'object' && 'error' in r) return '';
      return String(r);
    }
    if (Array.isArray(value.richText)) return value.richText.map((rt) => rt.text || '').join('');
    if ('text' in value) return String(value.text); // hyperlink object
    if ('error' in value) return ''; // #REF! / #DIV0! etc → treat as empty
  }
  return '';
}

function rowIsBlank(cells) {
  return cells.every((c) => c.trim() === '');
}

export async function parseXlsx(buffer, limits = BULK_IMPORT_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The uploaded file is empty.' } };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    return { error: { code: BULK_ERROR.MALFORMED_XLSX, message: `The file is not a readable .xlsx workbook (${err.message}).` } };
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The workbook has no sheets or no rows.' } };
  }

  const headerRow = worksheet.getRow(1);
  const headerCount = Math.max(headerRow.cellCount || 0, headerRow.actualCellCount || 0);
  const headers = [];
  for (let c = 1; c <= headerCount; c += 1) {
    headers.push(cellText(headerRow.getCell(c).value));
  }
  while (headers.length > 0 && headers[headers.length - 1].trim() === '') headers.pop();

  if (headers.length === 0) {
    return { error: { code: BULK_ERROR.MISSING_REQUIRED_COLUMN, message: 'The workbook has no header row.' } };
  }
  if (headers.length > limits.MAX_COLUMNS) {
    return { error: { code: BULK_ERROR.TOO_MANY_COLUMNS, message: `The file has ${headers.length} columns; the maximum is ${limits.MAX_COLUMNS}.` } };
  }

  const rows = [];
  const lastRow = worksheet.rowCount;
  for (let r = 2; r <= lastRow; r += 1) {
    const excelRow = worksheet.getRow(r);
    const cells = [];
    for (let c = 1; c <= headers.length; c += 1) {
      cells.push(cellText(excelRow.getCell(c).value));
    }
    if (rowIsBlank(cells)) continue; // skip blank rows (incl. trailing) without renumbering

    for (const cell of cells) {
      if (cell.length > limits.MAX_CELL_CHARS) {
        return {
          error: {
            code: BULK_ERROR.CELL_TOO_LARGE,
            message: `A cell on row ${r} is ${cell.length} characters; the maximum is ${limits.MAX_CELL_CHARS}.`,
          },
        };
      }
    }

    rows.push({ rowNumber: r, cells });
  }

  if (rows.length === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The workbook has a header row but no data rows.' } };
  }
  if (rows.length > limits.MAX_ROWS) {
    return { error: { code: BULK_ERROR.TOO_MANY_ROWS, message: `The file has ${rows.length} rows; the maximum is ${limits.MAX_ROWS}.` } };
  }

  return { headers, rows };
}

export default { parseXlsx };
