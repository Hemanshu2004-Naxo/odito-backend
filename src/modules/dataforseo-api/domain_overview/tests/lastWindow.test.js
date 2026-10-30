import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekStart, toIsoDay, windowStartDay } from '../../shared/dates.js';

const day = (iso) => toIsoDay(isoWeekStart(`${iso}T12:00:00Z`));

describe('isoWeekStart', () => {
  test('every day of one week rounds down to that week\'s Monday (a Sunday belongs to the week that ends on it)', () => {
    for (const d of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']) {
      assert.equal(day(d), '2026-10-26', d);
    }
    assert.equal(day('2026-11-02'), '2026-11-02');
  });
  test('crosses month and year boundaries', () => {
    assert.equal(day('2026-01-01'), '2025-12-29'); // a Thursday
    assert.equal(day('2024-03-01'), '2024-02-26'); // leap year
    assert.equal(day('2026-03-01'), '2026-02-23'); // a Sunday
  });
  test('is UTC: the time of day and the server zone do not matter', () => {
    assert.equal(toIsoDay(isoWeekStart('2026-10-28T00:00:00Z')), '2026-10-26');
    assert.equal(toIsoDay(isoWeekStart('2026-10-28T23:59:59Z')), '2026-10-26');
    assert.equal(isoWeekStart('2026-10-28T23:59:59Z').getUTCHours(), 0);
  });
  test('accepts a Date or a timestamp; an invalid date throws', () => {
    assert.equal(toIsoDay(isoWeekStart(new Date('2026-10-28T10:00:00Z'))), '2026-10-26');
    assert.equal(toIsoDay(isoWeekStart(Date.parse('2026-10-28T10:00:00Z'))), '2026-10-26');
    assert.throws(() => isoWeekStart('nope'), TypeError);
  });
});

describe('windowStartDay (today - 30 days, rounded down to a Monday)', () => {
  test('is a Monday, never later than today - 30 days, and less than 37 days before today', () => {
    for (let i = 0; i < 60; i += 1) {
      const now = Date.parse('2026-09-01T09:00:00Z') + i * 86_400_000;
      const since = new Date(`${windowStartDay(now, 30)}T00:00:00Z`);
      assert.equal(since.getUTCDay(), 1);
      assert.ok(since.getTime() <= now - 30 * 86_400_000);
      assert.ok(now - since.getTime() < 37 * 86_400_000);
    }
  });
  test('stays the same for a whole week, so the 7-day cache key is stable', () => {
    const starts = new Set();
    for (let i = 0; i < 7; i += 1) starts.add(windowStartDay(Date.parse('2026-10-28T10:00:00Z') + i * 86_400_000, 30)); // Wed Oct 28 .. Tue Nov 3
    assert.deepEqual([...starts], ['2026-09-28']);
    starts.add(windowStartDay(Date.parse('2026-11-04T10:00:00Z'), 30)); // the next day starts a new window
    assert.equal(starts.size, 2);
  });
  test('a worked example: Wednesday 2026-10-28 -> 2026-09-28 is a Monday, so the window starts then', () => {
    assert.equal(windowStartDay(Date.parse('2026-10-28T12:00:00Z'), 30), '2026-09-28');
  });
});
