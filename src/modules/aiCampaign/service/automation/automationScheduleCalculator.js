/**
 * automationScheduleCalculator — Phase 8. Pure date math, no Mongo, no
 * network. Computes the next UTC instant a policy is due to run, given its
 * user-configured `schedule` (frequency + optional hour-of-day/day-of-week
 * + IANA timezone).
 *
 * No date/timezone library exists in this backend's dependencies
 * (node-cron is the only date-adjacent package installed) — rather than add
 * one, this uses Node's built-in `Intl.DateTimeFormat` with a `timeZone`
 * option, which is timezone-database-accurate (including DST) without any
 * new dependency. Converting a LOCAL wall-clock time back to a UTC instant
 * (the hard direction) uses the standard iterative-refinement technique:
 * guess a UTC instant, format it back into the target zone, measure the
 * drift, and correct — two passes are enough because a timezone's UTC
 * offset only ever changes by whole hours, at most once within a single day.
 */

import { ELAPSED_TIME_FREQUENCIES } from '../../constants/automationEnums.js';

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(timezone) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: map.hour === '24' ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday],
  };
}

/** Local wall-clock Y-M-D H:00:00 in `timezone` -> the UTC Date it corresponds to. */
function zonedWallTimeToUtc(year, month, day, hour, timezone) {
  const targetUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = new Date(targetUtcMs);
  for (let i = 0; i < 2; i += 1) {
    const zoned = getZonedParts(guess, timezone);
    const zonedAsUtcMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    guess = new Date(guess.getTime() + (targetUtcMs - zonedAsUtcMs));
  }
  return guess;
}

function nextDailyOccurrence({ hourOfDay, timezone, fromDate }) {
  const zoned = getZonedParts(fromDate, timezone);
  let candidate = zonedWallTimeToUtc(zoned.year, zoned.month, zoned.day, hourOfDay, timezone);
  if (candidate <= fromDate) {
    const tomorrow = getZonedParts(new Date(candidate.getTime() + 24 * 60 * 60 * 1000), timezone);
    candidate = zonedWallTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hourOfDay, timezone);
  }
  return candidate;
}

function nextWeeklyOccurrence({ hourOfDay, dayOfWeek, timezone, fromDate }) {
  let candidate = nextDailyOccurrence({ hourOfDay, timezone, fromDate });
  for (let i = 0; i < 8; i += 1) {
    const zoned = getZonedParts(candidate, timezone);
    if (zoned.weekday === dayOfWeek && candidate > fromDate) return candidate;
    const advancedGuess = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    const advancedParts = getZonedParts(advancedGuess, timezone);
    candidate = zonedWallTimeToUtc(advancedParts.year, advancedParts.month, advancedParts.day, hourOfDay, timezone);
  }
  return candidate; // bounded fallback — always resolves within one week + 1 day of iteration
}

/**
 * @param {object} schedule - { frequency, hourOfDay, dayOfWeek, timezone }
 * @param {Date} [fromDate] - defaults to now; pass explicitly in tests
 * @returns {Date} the next UTC instant this policy is due
 */
export function computeNextRunAt(schedule, fromDate = new Date()) {
  const { frequency, hourOfDay = 9, dayOfWeek = 1, timezone = 'UTC' } = schedule || {};

  if (ELAPSED_TIME_FREQUENCIES.includes(frequency)) {
    const intervalMs = frequency === 'every_6_hours' ? 6 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    return new Date(fromDate.getTime() + intervalMs);
  }
  if (frequency === 'daily') {
    return nextDailyOccurrence({ hourOfDay, timezone, fromDate });
  }
  if (frequency === 'weekly') {
    return nextWeeklyOccurrence({ hourOfDay, dayOfWeek, timezone, fromDate });
  }
  throw new Error(`Unknown automation schedule frequency "${frequency}".`);
}

export default { isValidTimezone, computeNextRunAt };
