import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseScheduledAt, isValidIanaZone } from './bulkImportTime.js';
import { BULK_ERROR } from './bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2. Wall-clock + IANA timezone -> absolute UTC.
 * Pure, no DB. The server's own local timezone is never consulted.
 */

describe('isValidIanaZone', () => {
  test('accepts real IANA names and UTC', () => {
    assert.equal(isValidIanaZone('Asia/Kolkata'), true);
    assert.equal(isValidIanaZone('America/New_York'), true);
    assert.equal(isValidIanaZone('UTC'), true);
  });
  test('rejects garbage / empty', () => {
    assert.equal(isValidIanaZone('Not/AZone'), false);
    assert.equal(isValidIanaZone(''), false);
    assert.equal(isValidIanaZone(null), false);
    assert.equal(isValidIanaZone('   '), false);
  });
});

describe('parseScheduledAt', () => {
  test('interprets a wall time in the given zone (Asia/Kolkata is UTC+5:30)', () => {
    const { date } = parseScheduledAt('2026-09-10 10:00', 'Asia/Kolkata');
    assert.equal(date.toISOString(), '2026-09-10T04:30:00.000Z');
  });

  test('accepts a "T" separator and optional seconds', () => {
    assert.equal(parseScheduledAt('2026-09-10T10:00', 'Asia/Kolkata').date.toISOString(), '2026-09-10T04:30:00.000Z');
    assert.equal(parseScheduledAt('2026-09-10 10:00:30', 'UTC').date.toISOString(), '2026-09-10T10:00:30.000Z');
  });

  test('a string with an explicit offset / Z is absolute — no timezone needed', () => {
    assert.equal(parseScheduledAt('2026-09-10T10:00:00Z', null).date.toISOString(), '2026-09-10T10:00:00.000Z');
    assert.equal(parseScheduledAt('2026-09-10T10:00:00+05:30', undefined).date.toISOString(), '2026-09-10T04:30:00.000Z');
  });

  test('DST: America/New_York in July is UTC-4', () => {
    const { date } = parseScheduledAt('2026-07-01 12:00', 'America/New_York');
    assert.equal(date.toISOString(), '2026-07-01T16:00:00.000Z');
  });

  test('DST: America/New_York in January is UTC-5', () => {
    const { date } = parseScheduledAt('2026-01-01 12:00', 'America/New_York');
    assert.equal(date.toISOString(), '2026-01-01T17:00:00.000Z');
  });

  test('missing timezone on a bare wall time is INVALID_TIMEZONE', () => {
    const { error } = parseScheduledAt('2026-09-10 10:00', '');
    assert.equal(error.code, BULK_ERROR.INVALID_TIMEZONE);
  });

  test('unknown timezone is INVALID_TIMEZONE', () => {
    const { error } = parseScheduledAt('2026-09-10 10:00', 'Not/AZone');
    assert.equal(error.code, BULK_ERROR.INVALID_TIMEZONE);
  });

  test('a rolled-over date (Feb 30) is INVALID_SCHEDULE, not silently shifted to March', () => {
    const { error } = parseScheduledAt('2026-02-30 10:00', 'Asia/Kolkata');
    assert.equal(error.code, BULK_ERROR.INVALID_SCHEDULE);
  });

  test('out-of-range components are INVALID_SCHEDULE', () => {
    assert.equal(parseScheduledAt('2026-13-01 10:00', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
    assert.equal(parseScheduledAt('2026-09-10 25:00', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
  });

  test('a non-matching format is INVALID_SCHEDULE', () => {
    assert.equal(parseScheduledAt('next tuesday', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
    assert.equal(parseScheduledAt('10/09/2026 10:00', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
  });

  test('empty input is INVALID_SCHEDULE', () => {
    assert.equal(parseScheduledAt('', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
    assert.equal(parseScheduledAt('   ', 'UTC').error.code, BULK_ERROR.INVALID_SCHEDULE);
  });
});
