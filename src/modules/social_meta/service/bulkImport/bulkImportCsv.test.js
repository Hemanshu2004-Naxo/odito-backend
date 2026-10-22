import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, buildTemplateCsv, buildErrorReportCsv } from './bulkImportCsv.js';

/** Bulk Upload — the single CSV-escaping helper for files Odito emits. Pure. */

describe('csvCell — RFC-4180 quoting + formula-injection guard', () => {
  test('plain values pass through', () => {
    assert.equal(csvCell('facebook'), 'facebook');
    assert.equal(csvCell(7), '7');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  test('commas, quotes and newlines are quoted', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  });

  test('a leading formula trigger is neutralised with a leading quote', () => {
    assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('\tstuff'), "'\tstuff");
  });

  test('formula trigger + comma → guarded AND quoted', () => {
    assert.equal(csvCell('=1+1,danger'), '"\'=1+1,danger"');
  });
});

describe('buildTemplateCsv', () => {
  test('canonical header + example rows, CRLF terminated', () => {
    const csv = buildTemplateCsv();
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'platform,content,media_urls,scheduled_at,timezone,action');
    assert.ok(lines.length >= 5); // header + 3 examples + trailing ''
    assert.equal(csv.endsWith('\r\n'), true);
  });
});

describe('buildErrorReportCsv', () => {
  test('emits the fixed header and one line per row, safe fields only', () => {
    const csv = buildErrorReportCsv([
      { rowNumber: 3, status: 'invalid', normalized: { platform: null, content: 'hi, there' }, raw: { platform: 'pinterest' }, errors: [{ code: 'UNSUPPORTED_PLATFORM', message: 'no' }] },
      { rowNumber: 4, status: 'failed', normalized: { platform: 'facebook', content: '=EVIL()' }, raw: {}, errors: [{ code: 'MEDIA_NOT_OWNED', message: 'use Odito media' }, { code: 'X', message: 'y' }] },
    ]);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'row_number,platform,content,status,error_codes,error_messages');
    assert.equal(lines.length, 3);
    // row 3: platform falls back to raw, content has a comma -> quoted
    assert.ok(lines[1].startsWith('3,pinterest,"hi, there",invalid,UNSUPPORTED_PLATFORM,no'));
    // row 4: formula content guarded; two error codes/messages joined
    assert.ok(lines[2].includes("'=EVIL()"));
    assert.ok(lines[2].includes('MEDIA_NOT_OWNED; X'));
    assert.ok(lines[2].includes('use Odito media | y'));
  });
});
