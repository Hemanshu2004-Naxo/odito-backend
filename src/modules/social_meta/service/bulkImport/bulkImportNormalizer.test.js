import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHeader, analyzeHeaders, normalizeRow } from './bulkImportNormalizer.js';
import { BULK_ERROR } from './bulkImportConstants.js';

/** Bulk Upload — Phase 2. Header + row normalization. Pure, no DB. */

describe('normalizeHeader', () => {
  test('lower-cases, trims, and underscores spaces / hyphens', () => {
    assert.equal(normalizeHeader('Platform'), 'platform');
    assert.equal(normalizeHeader(' CONTENT '), 'content');
    assert.equal(normalizeHeader('Scheduled At'), 'scheduled_at');
    assert.equal(normalizeHeader('Media-URLs'), 'media_urls');
    assert.equal(normalizeHeader('media   urls'), 'media_urls');
  });
  test('strips punctuation and collapses underscores', () => {
    assert.equal(normalizeHeader('scheduled_at!!'), 'scheduled_at');
    assert.equal(normalizeHeader('__action__'), 'action');
  });
});

describe('analyzeHeaders', () => {
  test('maps the canonical columns to their positions', () => {
    const r = analyzeHeaders(['platform', 'content', 'media_urls', 'scheduled_at', 'timezone', 'action']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.columnIndex, { platform: 0, content: 1, media_urls: 2, scheduled_at: 3, timezone: 4, action: 5 });
  });

  test('accepts a subset with only the required columns', () => {
    const r = analyzeHeaders(['Platform', 'Content']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.columnIndex, { platform: 0, content: 1 });
  });

  test('a missing required column is a file-level error', () => {
    const r = analyzeHeaders(['content', 'action']);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === BULK_ERROR.MISSING_REQUIRED_COLUMN && /platform/.test(e.message)));
  });

  test('duplicate headers (after normalization) are rejected', () => {
    const r = analyzeHeaders(['platform', 'content', 'Content']);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === BULK_ERROR.DUPLICATE_COLUMN));
  });

  test('an unknown column is rejected, never silently ignored', () => {
    const r = analyzeHeaders(['platform', 'content', 'first_comment']);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === BULK_ERROR.UNSUPPORTED_COLUMN && /first_comment/.test(e.message)));
  });

  test('no header row at all is a file-level error', () => {
    assert.equal(analyzeHeaders([]).ok, false);
    assert.equal(analyzeHeaders(['', '  ']).ok, false);
  });
});

const IDX = { platform: 0, content: 1, media_urls: 2, scheduled_at: 3, timezone: 4, action: 5 };

describe('normalizeRow', () => {
  test('a well-formed facebook row', () => {
    const r = normalizeRow(['facebook', 'Hello', 'https://cdn.example.com/a.png', '2026-09-10 10:00', 'Asia/Kolkata', 'schedule'], IDX);
    assert.equal(r.normalized.platform, 'facebook');
    assert.equal(r.normalized.content, 'Hello');
    assert.deepEqual(r.normalized.media, [{ url: 'https://cdn.example.com/a.png', type: 'image' }]);
    assert.equal(r.normalized.timezone, 'Asia/Kolkata');
    assert.equal(r.normalized.action, 'schedule');
    assert.equal(r.scheduledAtInput, '2026-09-10 10:00');
    assert.equal(r.errors.length, 0);
  });

  test('platform is lower-cased and validated against the supported set', () => {
    assert.equal(normalizeRow(['FaceBook', 'x', '', '', '', ''], IDX).normalized.platform, 'facebook');
    const bad = normalizeRow(['pinterest', 'x', '', '', '', ''], IDX);
    assert.equal(bad.normalized.platform, null); // schema-safe
    assert.ok(bad.errors.some((e) => e.code === BULK_ERROR.UNSUPPORTED_PLATFORM));
  });

  test('empty / whitespace content becomes null', () => {
    assert.equal(normalizeRow(['facebook', '   ', '', '', '', ''], IDX).normalized.content, null);
  });

  test('media_urls split on semicolons; commas inside a URL are safe', () => {
    const r = normalizeRow(['facebook', 'x', 'https://x/a.jpg?a=1,2 ; https://x/b.mp4', '', '', ''], IDX);
    assert.deepEqual(r.mediaInputs, ['https://x/a.jpg?a=1,2', 'https://x/b.mp4']);
    assert.deepEqual(r.normalized.media, [{ url: 'https://x/a.jpg?a=1,2', type: 'image' }, { url: 'https://x/b.mp4', type: 'video' }]);
  });

  test('media type is inferred from the extension, ignoring the query string', () => {
    const r = normalizeRow(['facebook', 'x', 'https://x/pic.PNG?v=9', '', '', ''], IDX);
    assert.deepEqual(r.normalized.media, [{ url: 'https://x/pic.PNG?v=9', type: 'image' }]);
  });

  test('an untyped media URL is left OUT of normalized.media (schema requires a type)', () => {
    const r = normalizeRow(['facebook', 'x', 'https://x/file.txt', '', '', ''], IDX);
    assert.deepEqual(r.normalized.media, []);
  });

  test('an unknown action becomes null with an INVALID_ACTION error', () => {
    const r = normalizeRow(['facebook', 'x', '', '', '', 'post-now'], IDX);
    assert.equal(r.normalized.action, null);
    assert.ok(r.errors.some((e) => e.code === BULK_ERROR.INVALID_ACTION));
  });

  test('a missing action defaults to draft', () => {
    assert.equal(normalizeRow(['facebook', 'x', '', '', '', ''], IDX).normalized.action, 'draft');
  });

  test('raw only carries the recognized columns, as strings', () => {
    const r = normalizeRow(['facebook', 'Hello', '', '', '', 'draft'], IDX);
    assert.deepEqual(r.raw, { platform: 'facebook', content: 'Hello', media_urls: '', scheduled_at: '', timezone: '', action: 'draft' });
  });
});
