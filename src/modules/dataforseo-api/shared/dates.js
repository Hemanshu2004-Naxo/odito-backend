/**
 * Date helpers shared by the sections whose cache key carries a date. Everything is UTC and calendar-day based: the same instant gives the
 * same answer on every server, whatever its time zone.
 */

const DAY_MS = 86_400_000;

/**
 * The Monday (00:00 UTC) of the ISO week that contains `date`. A Sunday belongs to the week that ENDS on it, so it rounds down to the Monday
 * six days earlier.
 * @param {Date|number|string} date
 * @returns {Date}
 */
export function isoWeekStart(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('isoWeekStart: invalid date');
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7; // Mon = 0 ... Sun = 6
  return new Date(midnight - sinceMonday * DAY_MS);
}

/** "YYYY-MM-DD" (UTC). */
export const toIsoDay = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * The start of the "last N days" window: now minus N days, rounded down to the Monday of that ISO week — so every request in the same week
 * (and the cache entry it makes) shares one date, and the window is always at least N days long.
 * @returns {string} "YYYY-MM-DD"
 */
export function windowStartDay(now, days) {
  return toIsoDay(isoWeekStart(new Date(new Date(now).getTime() - days * DAY_MS)));
}
