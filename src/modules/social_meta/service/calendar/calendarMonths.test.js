import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCalendarInput, previewCalendarPlan, periodEndDate, addMonthsClamped, buildSlots, validateSlotPlan, parseDate, formatDate, calendarSeed,
} from './calendarPlanner.js';
import { CALENDAR_MAX_POSTS, CALENDAR_BATCH_SIZE } from './calendarConfig.js';

/**
 * Pure tests (no database, no AI): the month-based calendar. One date rule is pinned here and used everywhere:
 *   start date INCLUSIVE; period = start .. (start + N calendar months, exclusive); the stored END date is the LAST day (inclusive);
 *   a start day missing from the target month is clamped to that month's last day; plain calendar dates in UTC (no DST, no zones).
 */

const DAY = 86400000;
const TODAY = '2026-10-12'; // a Monday
const body = (over = {}) => ({ startDate: '2026-10-13', months: 1, postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced', ...over });
const preview = (over = {}) => previewCalendarPlan(body(over), { today: TODAY });

/** An independent statement of the quota rule, straight from the documented spec (not a call into the planner): a Monday-first week
 *  that is wholly inside the period gets postsPerWeek; a partial week gets the pro-rated share, never more than its days. */
function expectedTotal(startDate, endDate, ppw) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const daysByWeek = new Map();
  for (let ms = start; ms <= end; ms += DAY) {
    const mondayOffset = (new Date(ms).getUTCDay() + 6) % 7;
    const monday = ms - mondayOffset * DAY;
    daysByWeek.set(monday, (daysByWeek.get(monday) || 0) + 1);
  }
  let total = 0;
  for (const days of daysByWeek.values()) total += days >= 7 ? ppw : Math.min(days, Math.round((ppw * days) / 7));
  return total;
}

describe('periodEndDate — start inclusive, end inclusive, month ends clamped', () => {
  test('1: whole-month periods end on the day before the same day next month', () => {
    assert.equal(periodEndDate('2026-10-13', 1), '2026-11-12');
    assert.equal(periodEndDate('2026-10-01', 1), '2026-10-31');
    assert.equal(periodEndDate('2026-01-01', 3), '2026-03-31');
    assert.equal(periodEndDate('2026-07-01', 6), '2026-12-31');
    assert.equal(periodEndDate('2026-10-13', 6), '2027-04-12');
    assert.equal(periodEndDate('2026-12-15', 2), '2027-02-14', 'crosses a year boundary');
  });

  test('2: a start day that does not exist in the target month is clamped - February is never skipped and the period never spills over', () => {
    assert.equal(periodEndDate('2026-01-31', 1), '2026-02-27', 'Jan 31 + 1 month = Feb 28 (exclusive)');
    assert.equal(periodEndDate('2026-01-30', 1), '2026-02-27');
    assert.equal(periodEndDate('2026-01-29', 1), '2026-02-27');
    assert.equal(periodEndDate('2026-03-31', 1), '2026-04-29', 'Mar 31 + 1 month = Apr 30 (exclusive)');
    assert.equal(periodEndDate('2026-08-31', 6), '2027-02-27', 'Aug 31 + 6 months = Feb 28 (exclusive)');
    assert.equal(periodEndDate('2026-08-31', 2), '2026-10-30', 'Oct has a 31st, so no clamping');
    assert.equal(periodEndDate('2026-05-31', 1), '2026-06-29');
  });

  test('3: leap years', () => {
    assert.equal(periodEndDate('2028-01-31', 1), '2028-02-28', 'Jan 31 + 1 month = Feb 29 (exclusive) in a leap year');
    assert.equal(periodEndDate('2028-01-29', 1), '2028-02-28');
    assert.equal(periodEndDate('2028-02-01', 1), '2028-02-29', 'the whole leap February');
    assert.equal(periodEndDate('2026-02-01', 1), '2026-02-28', 'the whole ordinary February');
    assert.equal(periodEndDate('2028-02-29', 6), '2028-08-28');
    assert.equal(periodEndDate('2027-08-31', 6), '2028-02-28', 'Aug 31 + 6 months lands in a leap February (29 exclusive)');
    assert.equal(periodEndDate('2028-12-31', 2), '2029-02-27');
  });

  test('4: it is pure calendar arithmetic - the process time zone and daylight saving cannot move a date', () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
        process.env.TZ = tz;
        assert.equal(periodEndDate('2026-03-08', 1), '2026-04-07', `US DST change, ${tz}`);
        assert.equal(periodEndDate('2026-10-25', 1), '2026-11-24', `EU DST change, ${tz}`);
        assert.equal(formatDate(addMonthsClamped(parseDate('2026-01-31'), 1)), '2026-02-28', tz);
      }
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });

  test('5: bad input gives null, never a wrong date', () => {
    for (const bad of [['2026-02-30', 1], ['2026-10-13', 0], ['2026-10-13', 1.5], ['2026-10-13', '2'], ['soon', 1], [null, 1], ['2026-10-13', undefined]]) {
      assert.equal(periodEndDate(...bad), null, JSON.stringify(bad));
    }
  });
});

describe('validateCalendarInput — months', () => {
  test('6: months derives the end date; the request reports days and the period', () => {
    const r = validateCalendarInput(body({ months: 3 }), { today: TODAY });
    assert.equal(r.error, undefined);
    assert.equal(r.value.endDate, '2027-01-12');
    assert.equal(r.value.months, 3);
    assert.equal(r.value.days, 92);
  });

  test('7: months must be a whole number from 1 to 6', () => {
    for (const bad of [0, 7, -1, 2.5, '3', null, NaN, Infinity, [3], { $gt: 1 }, true]) {
      assert.equal(validateCalendarInput(body({ months: bad }), { today: TODAY }).error?.code, 'INVALID_DURATION', JSON.stringify(bad));
    }
    for (const ok of [1, 2, 3, 4, 5, 6]) assert.equal(validateCalendarInput(body({ months: ok }), { today: TODAY }).error, undefined, String(ok));
  });

  test('8: an endDate sent with months must agree with it (a client cannot ask for one length and another end)', () => {
    assert.equal(validateCalendarInput(body({ months: 1, endDate: '2026-11-12' }), { today: TODAY }).error, undefined);
    assert.equal(validateCalendarInput(body({ months: 1, endDate: '2026-11-13' }), { today: TODAY }).error?.code, 'INVALID_DATE_RANGE');
    assert.equal(validateCalendarInput(body({ months: 6, endDate: '2026-11-12' }), { today: TODAY }).error?.code, 'INVALID_DATE_RANGE');
  });

  test('9: a legacy {startDate, endDate} request still works (months is then null) but never beyond 6 months', () => {
    const { months: _m, ...legacy } = body({ endDate: '2026-11-12' });
    const r = validateCalendarInput(legacy, { today: TODAY });
    assert.equal(r.error, undefined);
    assert.equal(r.value.months, null);
    assert.equal(validateCalendarInput({ ...legacy, endDate: '2027-04-12' }, { today: TODAY }).error, undefined, 'exactly 6 months');
    assert.equal(validateCalendarInput({ ...legacy, endDate: '2027-04-13' }, { today: TODAY }).error?.code, 'INVALID_DATE_RANGE');
    assert.equal(validateCalendarInput({ startDate: '2026-10-13', postsPerWeek: 3, platforms: ['facebook'] }, { today: TODAY }).error?.code, 'INVALID_DATE', 'neither months nor endDate');
  });

  test('10: the start date may not be in the past (one day of slack for time zones) nor absurdly far ahead', () => {
    assert.equal(validateCalendarInput(body({ startDate: '2026-10-11' }), { today: TODAY }).error, undefined, 'yesterday (UTC) is tolerated');
    assert.equal(validateCalendarInput(body({ startDate: '2026-10-10' }), { today: TODAY }).error?.code, 'DATE_IN_PAST');
    assert.equal(validateCalendarInput(body({ startDate: '2027-10-12' }), { today: TODAY }).error, undefined, 'a year ahead is the limit');
    assert.equal(validateCalendarInput(body({ startDate: '2027-10-14' }), { today: TODAY }).error?.code, 'DATE_TOO_FAR');
  });
});

describe('previewCalendarPlan — the exact size of a calendar, before any AI call', () => {
  const SCENARIOS = [
    // [label, months, ppw, [min, max] sanity range from the requirement]
    ['3 posts/week, 1 month', 1, 3, [12, 14]],
    ['5 posts/week, 1 month', 1, 5, [20, 23]],
    ['3 posts/week, 3 months', 3, 3, [36, 40]],
    ['5 posts/week, 3 months', 3, 5, [60, 66]],
    ['1 post/week, 6 months', 6, 1, [25, 27]],
  ];

  for (const [label, months, ppw, [min, max]] of SCENARIOS) {
    test(`11: ${label}: the count follows the actual dates and the documented quota rule (and sits in the expected range)`, () => {
      const r = preview({ months, postsPerWeek: ppw });
      assert.equal(r.error, undefined);
      assert.equal(r.value.totalPosts, expectedTotal(r.value.startDate, r.value.endDate, ppw), 'exactly the weekly quotas, nothing more');
      assert.ok(r.value.totalPosts >= min && r.value.totalPosts <= max, `${r.value.totalPosts} is within ${min}-${max}`);
      assert.equal(r.value.steps, Math.ceil(r.value.totalPosts / CALENDAR_BATCH_SIZE));
    });
  }

  test('12: 7 posts/week for 6 months is one post every day - a long but valid calendar, inside the safety limit', () => {
    const r = preview({ startDate: '2026-10-13', months: 6, postsPerWeek: 7 });
    assert.equal(r.error, undefined);
    assert.equal(r.value.totalPosts, r.value.days, 'every day of the period');
    assert.equal(r.value.days, 182);
    const worst = previewCalendarPlan(body({ startDate: '2026-11-01', months: 6, postsPerWeek: 7 }), { today: TODAY });
    assert.equal(worst.value.days, 181);
    const longest = previewCalendarPlan(body({ startDate: '2027-07-01', months: 6, postsPerWeek: 7 }), { today: TODAY });
    assert.equal(longest.value.days, 184, 'Jul 1 - Dec 31 is the longest possible 6 months');
    assert.equal(longest.value.totalPosts, 184);
    assert.ok(longest.value.totalPosts <= CALENDAR_MAX_POSTS, 'the default safety limit never refuses a valid request');
  });

  test('13: partial weeks at the edges are reported with their pro-rated share', () => {
    const r = preview({ startDate: '2026-10-14', months: 1, postsPerWeek: 3 }); // Wed .. Tue
    assert.deepEqual(r.value.partialWeeks.map((w) => w.days), [5, 5]); // Wed Oct 14 .. Fri Nov 13
    for (const w of r.value.partialWeeks) assert.ok(w.posts <= w.days);
    const wholeWeeks = previewCalendarPlan({ startDate: '2026-10-19', endDate: '2026-11-15', postsPerWeek: 3, platforms: ['facebook'] }, { today: TODAY }); // Mon .. Sun, 4 weeks (a legacy range)
    assert.deepEqual(wholeWeeks.value.partialWeeks, []);
    assert.equal(wholeWeeks.value.totalPosts, 12, 'four whole weeks x 3');
  });

  test('14: the count is the same whatever the seed or the platforms: it is the server\'s quota, not the AI\'s and not per platform', () => {
    const one = preview({ months: 3, postsPerWeek: 3, platforms: ['facebook'] });
    const both = preview({ months: 3, postsPerWeek: 3, platforms: ['facebook', 'instagram'], distributionMode: 'ai_optimized' });
    assert.equal(one.value.totalPosts, both.value.totalPosts);
    const counts = new Set();
    for (let i = 0; i < 15; i += 1) counts.add(buildSlots({ startDate: '2026-10-13', endDate: '2027-01-12', postsPerWeek: 3, seed: `s${i}` }).length);
    assert.deepEqual([...counts], [one.value.totalPosts]);
  });

  test('15: bad input is refused with the same codes as /generate', () => {
    assert.equal(preview({ months: 9 }).error.code, 'INVALID_DURATION');
    assert.equal(preview({ postsPerWeek: 0 }).error.code, 'INVALID_POSTS_PER_WEEK');
    assert.equal(preview({ startDate: '2026-02-30' }).error.code, 'INVALID_DATE');
  });
});

describe('the planner at month scale — a property sweep', () => {
  const STARTS = ['2026-10-12', '2026-10-14', '2026-10-18', '2026-12-31', '2027-01-31', '2028-02-29'];

  test('16: for every start day x duration x frequency: unique in-range dates, the exact quota, a valid weekday plan, deterministic', () => {
    for (const startDate of STARTS) {
      for (let months = 1; months <= 6; months += 1) {
        const endDate = periodEndDate(startDate, months);
        for (let ppw = 1; ppw <= 7; ppw += 1) {
          const label = `${startDate} +${months}m @${ppw}/wk`;
          const seed = calendarSeed({ projectId: 'p1', version: 1, startDate, endDate, strategyVersion: 1 });
          const slots = buildSlots({ startDate, endDate, postsPerWeek: ppw, seed });
          assert.equal(slots.length, expectedTotal(startDate, endDate, ppw), label);
          assert.deepEqual(validateSlotPlan(slots, { startDate, endDate, postsPerWeek: ppw }), [], label);
          assert.equal(new Set(slots.map((s) => s.date)).size, slots.length, `${label}: no date used twice`);
          for (const s of slots) assert.ok(s.date >= startDate && s.date <= endDate, `${label}: ${s.date} inside the period`);
          assert.deepEqual(buildSlots({ startDate, endDate, postsPerWeek: ppw, seed }), slots, `${label}: same input, same plan`);
        }
      }
    }
  });

  test('17: dates that cross a leap day or a month end are real dates in order', () => {
    const slots = buildSlots({ startDate: '2028-02-20', endDate: periodEndDate('2028-02-20', 2), postsPerWeek: 5, seed: 'x' });
    const dates = slots.map((s) => s.date);
    assert.ok(dates.includes('2028-02-29') || dates.some((d) => d > '2028-02-29'), 'the leap day is inside the period');
    assert.deepEqual([...dates].sort(), dates, 'in order');
    for (const d of dates) assert.equal(formatDate(parseDate(d)), d, `${d} is a real date`);
  });
});
