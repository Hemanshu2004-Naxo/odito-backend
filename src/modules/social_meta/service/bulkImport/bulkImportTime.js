import { BULK_ERROR } from './bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 timezone handling.
 *
 * The backend has NO luxon (it lives only in the frontend's
 * lib/scheduleTime.js). Rather than add a dependency, this converts a
 * local wall-clock time in a named IANA zone to an absolute UTC instant
 * using the platform `Intl` timezone database — which also gives free
 * IANA-zone validation (an unknown zone throws `RangeError`).
 *
 * The result is a real `Date` (absolute instant). Phase 3, when it feeds
 * this into the existing createPublication(), can hand it
 * `date.toISOString()` — the exact "absolute ISO with explicit offset"
 * shape socialPublishingService.parseAbsoluteScheduledAt already requires,
 * so nothing in the publishing pipeline changes.
 *
 * The server's own local timezone is NEVER consulted — every conversion
 * goes through an explicit `timeZone`.
 */

/** True if `tz` is a resolvable IANA time zone name. */
export function isValidIanaZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    // Throws RangeError for an unknown zone; "UTC" and offsets like
    // "+05:30" are accepted by Intl and are fine here too.
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset (ms) to ADD to `instant` to get the wall-clock time shown in
 * `timeZone` at that instant: wallClockMs - instantMs.
 */
function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const shownAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return shownAsUtc - instant.getTime();
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_EXPLICIT_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses `input` into an absolute `Date`.
 *
 *  - If `input` already carries an explicit UTC offset (`...Z` or
 *    `...+05:30`), it is an absolute instant on its own and `timeZone`
 *    is not needed.
 *  - Otherwise `input` must be `YYYY-MM-DD HH:mm` (or `...:ss`, or with a
 *    `T` separator) and is interpreted as a wall-clock time IN
 *    `timeZone`.
 *
 * Returns `{ date }` on success, or `{ error: { code, message } }` — never
 * throws. `code` is INVALID_SCHEDULE for a bad/rolled-over date,
 * INVALID_TIMEZONE for a missing/unknown zone.
 */
export function parseScheduledAt(input, timeZone) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return { error: { code: BULK_ERROR.INVALID_SCHEDULE, message: 'scheduled_at is empty.' } };
  }

  if (HAS_EXPLICIT_OFFSET_RE.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return { error: { code: BULK_ERROR.INVALID_SCHEDULE, message: `scheduled_at "${raw}" is not a valid date.` } };
    }
    return { date: d };
  }

  const m = raw.match(WALL_RE);
  if (!m) {
    return { error: { code: BULK_ERROR.INVALID_SCHEDULE, message: `scheduled_at "${raw}" must look like "2026-09-10 10:00" (YYYY-MM-DD HH:mm).` } };
  }
  const [, ys, mos, ds, hs, mis, ss] = m;
  const year = Number(ys); const month = Number(mos); const day = Number(ds);
  const hour = Number(hs); const minute = Number(mis); const second = Number(ss || '0');

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return { error: { code: BULK_ERROR.INVALID_SCHEDULE, message: `scheduled_at "${raw}" is out of range.` } };
  }

  const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!tz) {
    return { error: { code: BULK_ERROR.INVALID_TIMEZONE, message: 'A timezone is required for a scheduled row (e.g. "Asia/Kolkata").' } };
  }
  if (!isValidIanaZone(tz)) {
    return { error: { code: BULK_ERROR.INVALID_TIMEZONE, message: `Unknown timezone "${tz}". Use an IANA name such as "Asia/Kolkata".` } };
  }

  // Reject rolled-over dates (e.g. 2026-02-30): the naive UTC instant's
  // components must match what was written.
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(naiveUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return { error: { code: BULK_ERROR.INVALID_SCHEDULE, message: `scheduled_at "${raw}" is not a real calendar date.` } };
  }

  // Two passes settle DST boundaries: the offset just before the naive
  // instant, then re-checked at the corrected instant.
  let offset = zoneOffsetMs(check, tz);
  let utcMs = naiveUtc - offset;
  const offset2 = zoneOffsetMs(new Date(utcMs), tz);
  if (offset2 !== offset) {
    utcMs = naiveUtc - offset2;
    offset = offset2;
  }

  return { date: new Date(utcMs) };
}
