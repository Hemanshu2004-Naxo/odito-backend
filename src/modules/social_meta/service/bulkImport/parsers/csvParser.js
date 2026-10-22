import Papa from 'papaparse';
import { BULK_IMPORT_LIMITS, BULK_ERROR } from '../bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 CSV parser. Buffer in, structured rows out.
 *
 * Returns `{ headers, rows }` on success, `{ error: { code, message } }`
 * on a file-level failure. `rows` is `[{ rowNumber, cells }]` where
 * `rowNumber` is the 1-based SOURCE LINE (header = line 1) — blank lines
 * are skipped but never renumber the rows around them.
 *
 * Formula injection is a NON-issue on import: values are read as plain
 * strings and never evaluated. The only place Odito emits a spreadsheet
 * is the template endpoint, whose cells are all literal safe text.
 */
export function parseCsv(buffer, limits = BULK_IMPORT_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The uploaded file is empty.' } };
  }

  // Strip a UTF-8 BOM if present, decode as UTF-8.
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (text.trim() === '') {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The uploaded file has no content.' } };
  }

  const result = Papa.parse(text, {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
    // Never run any transform / evaluation on a value.
  });

  // An unterminated quote is a genuinely malformed file — Papa reports it
  // as a "Quotes" error. Field-count mismatches (ragged rows) are NOT
  // fatal: short rows become empty cells and are caught per-row by the
  // validator; extra cells past the known columns are simply unused.
  const fatal = (result.errors || []).find((e) => e.type === 'Quotes');
  if (fatal) {
    return {
      error: {
        code: BULK_ERROR.MALFORMED_CSV,
        message: `The CSV is malformed near line ${(fatal.row ?? 0) + 1}: ${fatal.message || 'unterminated quoted field'}.`,
      },
    };
  }

  const table = result.data;
  if (!Array.isArray(table) || table.length === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The CSV has no rows.' } };
  }

  const headers = (table[0] || []).map((h) => (h == null ? '' : String(h)));
  if (headers.length > limits.MAX_COLUMNS) {
    return { error: { code: BULK_ERROR.TOO_MANY_COLUMNS, message: `The file has ${headers.length} columns; the maximum is ${limits.MAX_COLUMNS}.` } };
  }

  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const sourceLine = i + 1; // header is line 1
    const rawCells = Array.isArray(table[i]) ? table[i] : [];
    const cells = rawCells.map((c) => (c == null ? '' : String(c)));

    // Skip a completely blank line entirely (universal CSV behaviour) —
    // it produces no row, and the following rows keep their true line
    // numbers.
    if (cells.every((c) => c.trim() === '')) continue;

    for (const c of cells) {
      if (c.length > limits.MAX_CELL_CHARS) {
        return {
          error: {
            code: BULK_ERROR.CELL_TOO_LARGE,
            message: `A cell on line ${sourceLine} is ${c.length} characters; the maximum is ${limits.MAX_CELL_CHARS}.`,
          },
        };
      }
    }

    rows.push({ rowNumber: sourceLine, cells });
  }

  if (rows.length === 0) {
    return { error: { code: BULK_ERROR.EMPTY_FILE, message: 'The CSV has a header row but no data rows.' } };
  }
  if (rows.length > limits.MAX_ROWS) {
    return { error: { code: BULK_ERROR.TOO_MANY_ROWS, message: `The file has ${rows.length} rows; the maximum is ${limits.MAX_ROWS}.` } };
  }

  return { headers, rows };
}

export default { parseCsv };
