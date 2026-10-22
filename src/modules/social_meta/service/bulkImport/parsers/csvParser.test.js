import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from './csvParser.js';
import { BULK_ERROR, BULK_IMPORT_LIMITS } from '../bulkImportConstants.js';

/** Bulk Upload — Phase 2 CSV parser. Pure, no DB. */

const buf = (s) => Buffer.from(s, 'utf8');
const HEADER = 'platform,content,media_urls,scheduled_at,timezone,action';

describe('parseCsv — well-formed', () => {
  test('parses a header + data rows, keeping source line numbers', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,Hello,,,,draft\r\ninstagram,Hi,https://x/a.jpg,,,draft\r\n`));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.headers, ['platform', 'content', 'media_urls', 'scheduled_at', 'timezone', 'action']);
    assert.deepEqual(r.rows.map((x) => x.rowNumber), [2, 3]);
    assert.deepEqual(r.rows[0].cells, ['facebook', 'Hello', '', '', '', 'draft']);
  });

  test('handles a quoted comma', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,"Hello, world",,,,draft\r\n`));
    assert.equal(r.rows[0].cells[1], 'Hello, world');
  });

  test('handles a quoted newline', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,"line one\nline two",,,,draft\r\n`));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].cells[1], 'line one\nline two');
  });

  test('strips a UTF-8 BOM from the first header', () => {
    const r = parseCsv(buf(`﻿${HEADER}\r\nfacebook,Hi,,,,draft\r\n`));
    assert.equal(r.headers[0], 'platform');
  });

  test('skips a fully-blank line without renumbering the rows around it', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,A,,,,draft\r\n\r\nfacebook,B,,,,draft\r\n`));
    assert.deepEqual(r.rows.map((x) => x.rowNumber), [2, 4]);
  });

  test('UTF-8 content is preserved', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,"नमस्ते 🎉",,,,draft\r\n`));
    assert.equal(r.rows[0].cells[1], 'नमस्ते 🎉');
  });
});

describe('parseCsv — file-level rejections', () => {
  test('empty buffer / whitespace-only', () => {
    assert.equal(parseCsv(Buffer.alloc(0)).error.code, BULK_ERROR.EMPTY_FILE);
    assert.equal(parseCsv(buf('   \r\n  ')).error.code, BULK_ERROR.EMPTY_FILE);
  });

  test('header row but no data rows', () => {
    assert.equal(parseCsv(buf(`${HEADER}\r\n`)).error.code, BULK_ERROR.EMPTY_FILE);
  });

  test('an unterminated quote is MALFORMED_CSV', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,"never closed,,,,draft\r\n`));
    assert.equal(r.error.code, BULK_ERROR.MALFORMED_CSV);
  });

  test('too many columns', () => {
    const wide = Array.from({ length: BULK_IMPORT_LIMITS.MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(',');
    assert.equal(parseCsv(buf(`${wide}\r\nx\r\n`)).error.code, BULK_ERROR.TOO_MANY_COLUMNS);
  });

  test('too many rows', () => {
    const rows = Array.from({ length: BULK_IMPORT_LIMITS.MAX_ROWS + 1 }, () => 'facebook,Hi,,,,draft').join('\r\n');
    assert.equal(parseCsv(buf(`${HEADER}\r\n${rows}\r\n`)).error.code, BULK_ERROR.TOO_MANY_ROWS);
  });

  test('an oversized cell', () => {
    const big = 'x'.repeat(BULK_IMPORT_LIMITS.MAX_CELL_CHARS + 1);
    assert.equal(parseCsv(buf(`${HEADER}\r\nfacebook,${big},,,,draft\r\n`)).error.code, BULK_ERROR.CELL_TOO_LARGE);
  });

  test('exactly at the row limit is accepted', () => {
    const rows = Array.from({ length: BULK_IMPORT_LIMITS.MAX_ROWS }, () => 'facebook,Hi,,,,draft').join('\r\n');
    const r = parseCsv(buf(`${HEADER}\r\n${rows}\r\n`));
    assert.equal(r.error, undefined);
    assert.equal(r.rows.length, BULK_IMPORT_LIMITS.MAX_ROWS);
  });
});

describe('parseCsv — ragged rows are tolerated (not silently dropped)', () => {
  test('a short row yields empty trailing cells and still appears', () => {
    const r = parseCsv(buf(`${HEADER}\r\nfacebook,Hello\r\n`));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].cells[0], 'facebook');
    assert.equal(r.rows[0].cells[1], 'Hello');
  });
});
