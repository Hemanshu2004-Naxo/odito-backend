import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The safety ceiling on the posts of one calendar is configuration (SOCIAL_AI_CALENDAR_MAX_POSTS). Config is read at import, so
 * this file lowers it BEFORE importing the planner, in its own process (node --test runs each file separately). Pure: no database.
 */
process.env.SOCIAL_AI_CALENDAR_MAX_POSTS = '20';
process.env.SOCIAL_AI_CALENDAR_MAX_START_AHEAD_DAYS = '30';

let previewCalendarPlan;
let validateCalendarInput;
let CALENDAR_MAX_POSTS;
let CALENDAR_MAX_ITEMS;
before(async () => {
  ({ previewCalendarPlan, validateCalendarInput } = await import('./calendarPlanner.js'));
  ({ CALENDAR_MAX_POSTS, CALENDAR_MAX_ITEMS } = await import('./calendarConfig.js'));
});

const TODAY = '2026-10-12';
const body = (over = {}) => ({ startDate: '2026-10-13', months: 1, postsPerWeek: 3, platforms: ['facebook'], ...over });

describe('calendar size limits (configured, checked before any AI call)', () => {
  test('1: the limit comes from configuration, and manual posts get room on top of it', () => {
    assert.equal(CALENDAR_MAX_POSTS, 20);
    assert.equal(CALENDAR_MAX_ITEMS, 70);
  });

  test('2: a calendar within the limit is previewed; one above it is refused with CALENDAR_TOO_LARGE and a way out', () => {
    assert.equal(previewCalendarPlan(body({ months: 1, postsPerWeek: 3 }), { today: TODAY }).error, undefined, '14 posts');
    const tooBig = previewCalendarPlan(body({ months: 3, postsPerWeek: 3 }), { today: TODAY });
    assert.equal(tooBig.error.code, 'CALENDAR_TOO_LARGE');
    assert.match(tooBig.error.message, /at most 20/);
    assert.match(tooBig.error.message, /fewer posts per week or a shorter calendar/);
    assert.equal(previewCalendarPlan(body({ months: 1, postsPerWeek: 7 }), { today: TODAY }).error.code, 'CALENDAR_TOO_LARGE', '~31 posts');
  });

  test('3: the start-ahead limit is configured too', () => {
    assert.equal(validateCalendarInput(body({ startDate: '2026-11-11' }), { today: TODAY }).error, undefined);
    assert.equal(validateCalendarInput(body({ startDate: '2026-11-12' }), { today: TODAY }).error?.code, 'DATE_TOO_FAR');
  });
});
