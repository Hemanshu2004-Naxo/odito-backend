import crypto from 'node:crypto';
import { PLATFORMS, WEEKDAYS } from '../aiStrategy/strategyOutputSchema.js';
import { CALENDAR_MIN_DAYS, CALENDAR_MIN_MONTHS, CALENDAR_MAX_MONTHS, CALENDAR_MAX_START_AHEAD_DAYS, CALENDAR_MAX_POSTS, CALENDAR_BATCH_SIZE } from './calendarConfig.js';
import { DISTRIBUTION_MODES } from '../../model/SocialContentCalendar.js';

/**
 * Calendar planner — the deterministic half of calendar generation. No AI, no database.
 *
 * The SERVER decides the structure of a calendar, so it is correct whatever the model says:
 *   - which DATES carry a post (from the user's posts-per-week and the strategy's preferred days);
 *   - which content PILLAR each slot belongs to (the strategy's percentages over the whole planning period);
 *   - which PLATFORM(S) each slot targets, for the modes that fix it.
 * The model only fills in the creative plan for each slot (topic, angle, hook, objective, ...), and the service
 * validates every field it returns. So "3 posts a week" is exactly three slots a week and never silently six, and the
 * pillar mix is a counted fact, not a hope.
 *
 * Frequency model (documented in the UI): `postsPerWeek` is the number of calendar ITEMS per week. In the
 * ai_optimized mode one item may be planned for both platforms (it later becomes one publication per platform); in
 * balanced and platform_specific every item targets exactly one platform.
 *
 * Dates are plain "YYYY-MM-DD" calendar dates (no timezone), handled in UTC so a server's local zone never shifts one.
 *
 * DATE SEMANTICS (one rule, used by validation, generation, storage, display and the tests):
 *   - A calendar is a start date plus a number of CALENDAR MONTHS (1-6).
 *   - The start date is INCLUSIVE. The period runs up to, and not including, start + N months; the END DATE stored and shown
 *     everywhere is the LAST day of the period, i.e. INCLUSIVE (start + N months - 1 day).
 *       Oct 13 + 1 month -> ends Nov 12      Jan 1 + 3 months -> ends Mar 31      Jul 1 + 6 months -> ends Dec 31
 *   - When the start's day does not exist in the target month it is CLAMPED to that month's last day, so the period never
 *     skips a month and never spills into the next one:  Jan 31 + 1 month = Feb 28 (29 in a leap year), so the period ends
 *     Feb 27 (28).  Aug 31 + 6 months = Feb 28 (29), so it ends Feb 27 (28).
 *   - Everything is computed on calendar dates in UTC. There is no time of day, so a daylight-saving change can never move a
 *     date, and a date is never converted between time zones.
 *   - Posts per week is a weekly TARGET enforced as an exact quota per Monday-first week (weeklyQuota); a week only partly
 *     inside the period gets a proportional share. The total is therefore known exactly before any AI call (previewCalendarPlan).
 */

export { DISTRIBUTION_MODES };

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_KEYS = ['startDate', 'months', 'endDate', 'postsPerWeek', 'platforms', 'distributionMode'];

const SLOT_ATTEMPTS = 24; // seeded weekday plans tried before the best one is kept (a plan that fails validation is never preferred)

const bad = (code, message) => ({ error: { code, message } });

/** "YYYY-MM-DD" -> epoch ms at UTC midnight, or null when it is not a real calendar date. */
export function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : null;
}

export const formatDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekdayOf = (ms) => WEEKDAYS[(new Date(ms).getUTCDay() + 6) % 7]; // Monday-first

const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** epoch ms of (the date at `ms`) + `months` calendar months, with the day clamped to the target month's last day. */
export function addMonthsClamped(ms, months) {
  const d = new Date(ms);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  return Date.UTC(year, month0, Math.min(d.getUTCDate(), daysInMonth(year, month0)));
}

/** The LAST day (inclusive, "YYYY-MM-DD") of a calendar starting on `startDate` and covering `months` months; null for a bad input. */
export function periodEndDate(startDate, months) {
  const start = parseDate(startDate);
  if (start === null || !Number.isInteger(months) || months < 1) return null;
  return formatDate(addMonthsClamped(start, months) - DAY_MS);
}

/**
 * Validates the user's calendar request. Returns { value } or { error: { code, message } } — never throws.
 * `today` is the server's current UTC date; a start date up to one day earlier is accepted, because a user west of UTC
 * can legitimately be "today" while it is already tomorrow in UTC.
 */
export function validateCalendarInput(body, { today = formatDate(Date.now()) } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('INVALID_BODY', 'The request body must be an object.');
  const { projectId: _projectId, ...fields } = body; // the routing key validateProjectAccess() already used
  for (const key of Object.keys(fields)) if (!INPUT_KEYS.includes(key)) return bad('UNKNOWN_FIELD', `"${key}" is not a calendar setting.`);

  const start = parseDate(fields.startDate);
  if (start === null) return bad('INVALID_DATE', 'startDate must be a real date like 2026-10-01.');
  if (start < parseDate(today) - DAY_MS) return bad('DATE_IN_PAST', 'The calendar cannot start in the past.');
  if (start > parseDate(today) + CALENDAR_MAX_START_AHEAD_DAYS * DAY_MS) return bad('DATE_TOO_FAR', `The calendar cannot start more than ${CALENDAR_MAX_START_AHEAD_DAYS} days from now.`);

  // The length: `months` (1-6, the product's model) - the end date is derived from it. A legacy client may instead send an explicit
  // endDate (no months): still accepted, but never beyond what 6 months would allow.
  let months = null;
  let endDate;
  if (fields.months !== undefined) {
    months = fields.months;
    if (typeof months !== 'number' || !Number.isInteger(months) || months < CALENDAR_MIN_MONTHS || months > CALENDAR_MAX_MONTHS) {
      return bad('INVALID_DURATION', `months must be a whole number from ${CALENDAR_MIN_MONTHS} to ${CALENDAR_MAX_MONTHS}.`);
    }
    endDate = periodEndDate(fields.startDate, months);
    if (fields.endDate !== undefined && fields.endDate !== endDate) {
      return bad('INVALID_DATE_RANGE', `endDate does not match ${months} month${months === 1 ? '' : 's'} from ${fields.startDate} (that period ends ${endDate}). Leave endDate out: it is worked out for you.`);
    }
  } else {
    const end = parseDate(fields.endDate);
    if (end === null) return bad('INVALID_DATE', 'Send months (1-6), or an endDate like 2026-10-31.');
    if (end < start) return bad('INVALID_DATE_RANGE', 'The end date must be on or after the start date.');
    const legacyDays = Math.round((end - start) / DAY_MS) + 1;
    if (legacyDays < CALENDAR_MIN_DAYS) return bad('INVALID_DATE_RANGE', `A calendar must cover at least ${CALENDAR_MIN_DAYS} days.`);
    if (end > parseDate(periodEndDate(fields.startDate, CALENDAR_MAX_MONTHS))) return bad('INVALID_DATE_RANGE', `A calendar can cover at most ${CALENDAR_MAX_MONTHS} months.`);
    endDate = fields.endDate;
  }
  const end = parseDate(endDate);
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days < CALENDAR_MIN_DAYS) return bad('INVALID_DATE_RANGE', `A calendar must cover at least ${CALENDAR_MIN_DAYS} days.`);

  const ppw = fields.postsPerWeek;
  if (typeof ppw !== 'number' || !Number.isInteger(ppw) || ppw < 1 || ppw > 7) return bad('INVALID_POSTS_PER_WEEK', 'postsPerWeek must be a whole number from 1 to 7.');

  const platforms = fields.platforms;
  if (!Array.isArray(platforms) || platforms.length < 1 || platforms.length > PLATFORMS.length) return bad('INVALID_PLATFORMS', 'Choose at least one platform.');
  if (!platforms.every((p) => typeof p === 'string' && PLATFORMS.includes(p))) return bad('INVALID_PLATFORMS', `platforms must be from: ${PLATFORMS.join(', ')}.`);
  if (new Set(platforms).size !== platforms.length) return bad('INVALID_PLATFORMS', 'Each platform can only be chosen once.');

  const mode = fields.distributionMode === undefined ? 'ai_optimized' : fields.distributionMode;
  if (typeof mode !== 'string' || !DISTRIBUTION_MODES.includes(mode)) return bad('INVALID_DISTRIBUTION', `distributionMode must be one of: ${DISTRIBUTION_MODES.join(', ')}.`);

  return {
    value: {
      startDate: fields.startDate,
      endDate,
      months,
      postsPerWeek: ppw,
      platforms: PLATFORMS.filter((p) => platforms.includes(p)), // canonical order, whatever order the client sent
      distributionMode: mode,
      days,
    },
  };
}

// ── which dates carry a post ─────────────────────────────────────────────────
//
// A calendar is cut into Monday-first weeks. Each week gets its OWN set of weekdays: chosen from that week's valid days,
// scored for spacing and spread, penalised for repeating the previous weeks' days and for leaning on the same weekday,
// and then picked with a SEEDED random jitter so the result looks planned rather than mechanically repeated. The seed
// is derived from the calendar (project, version, range, strategy version), so the same calendar always produces the same
// dates, and regenerating (a new version) produces a different valid pattern. Every plan is validated before it is used.
// The weekday has no say in the content pillar, platform or format: those are assigned to the dates afterwards.

/** uint32 seed from any string. */
export function seedFromParts(...parts) {
  return crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest().readUInt32BE(0);
}

/** mulberry32: a small deterministic PRNG returning floats in [0, 1). Never Math.random(). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayIndexOf = (ms) => (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0

/** The range as Monday-first weeks: [{ start: ms of Monday, valid: [weekday indexes inside the range] }]. */
export function splitWeeks(startMs, endMs) {
  const weeks = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const idx = dayIndexOf(ms);
    const monday = ms - idx * DAY_MS;
    let week = weeks[weeks.length - 1];
    if (!week || week.start !== monday) { week = { start: monday, valid: [] }; weeks.push(week); }
    week.valid.push(idx);
  }
  return weeks;
}

/** Posts in a week: the full number for a whole week; a pro-rated share (never more than its days) for a partial week at either end of the range. */
export function weeklyQuota(validDays, postsPerWeek) {
  if (validDays >= 7) return postsPerWeek;
  return Math.min(validDays, Math.round((postsPerWeek * validDays) / 7));
}

function combinations(items, k) {
  const out = [];
  const pick = (from, chosen) => {
    if (chosen.length === k) { out.push(chosen); return; }
    for (let i = from; i <= items.length - (k - chosen.length); i += 1) pick(i + 1, [...chosen, items[i]]);
  };
  if (k > 0 && k <= items.length) pick(0, []);
  return out;
}

const adjacentPairs = (combo) => combo.reduce((n, d, i) => (i > 0 && d - combo[i - 1] === 1 ? n + 1 : n), 0);
const overlap = (a, b) => (b ? a.filter((d) => b.includes(d)).length : 0);
const sameCombo = (a, b) => !!b && a.length === b.length && a.every((d, i) => d === b[i]);

/** Posts that sit on back-to-back days that a week could not avoid: how many adjacent pairs a week is allowed. */
function allowedAdjacency(valid, k) {
  const minimum = Math.min(...combinations(valid, k).map(adjacentPairs));
  return k <= 3 ? minimum : minimum + 1;
}

/** How far apart a week's first and last post must be: posts may not all huddle at one end of the week. */
const minSpan = (k) => (k <= 1 ? 0 : k <= 3 ? k + 1 : Math.min(k, 5));

function pickWeekCombo({ week, k, startMs, prevLastMs, history, usage, recommended, random }) {
  const candidates = combinations(week.valid, k);
  if (candidates.length === 1) return candidates[0];
  const prev = history[history.length - 1] || null;
  const prev2 = history[history.length - 2] || null;
  const full = week.valid.length === 7;
  const ideal = (full ? 7 : week.valid.length) / k;
  const idealSpan = (full ? 7 : week.valid.length) * ((k - 1) / k);
  let best = null;
  for (const combo of candidates) {
    let penalty = 0;
    penalty += adjacentPairs(combo) * 4;
    const firstMs = startMs + combo[0] * DAY_MS;
    if (prevLastMs !== null && firstMs - prevLastMs === DAY_MS) penalty += 4; // back-to-back across the week boundary
    // even spacing, counting the gap from the previous week's last post
    const gaps = combo.slice(1).map((d, i) => d - combo[i]);
    if (prevLastMs !== null) gaps.unshift(Math.round((firstMs - prevLastMs) / DAY_MS));
    penalty += gaps.reduce((s, g) => s + (g - ideal) ** 2, 0) * 0.5;
    if (k > 1) penalty += (combo[combo.length - 1] - combo[0] - idealSpan) ** 2 * 0.3;
    // variety: never the same days as last week, and little in common with the last two
    if (sameCombo(combo, prev)) penalty += 100;
    penalty += overlap(combo, prev) * 0.8 + overlap(combo, prev2) * 0.3;
    // rotate weekday usage across the whole period
    penalty += combo.reduce((s, d) => s + usage[d], 0) * 0.9;
    // the strategy's best days are a mild preference, not a rule
    penalty -= combo.filter((d) => recommended.has(d)).length * 0.8;
    penalty += random() * 2.5; // controlled (seeded) randomness
    if (best === null || penalty < best.penalty) best = { combo, penalty };
  }
  return best.combo;
}

/**
 * The quality check every weekday plan must pass. Returns a list of problems (empty = fine):
 * valid, unique, in-range dates; the right number of posts in every week; no week repeating the previous week's days;
 * varied days across the period; sensible spacing; posts spread over the week rather than huddled at one end.
 */
export function validateSlotPlan(slots, { startDate, endDate, postsPerWeek }) {
  const problems = [];
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start === null || end === null || end < start) return ['invalid range'];
  const seen = new Set();
  let last = -Infinity;
  for (const s of slots) {
    const ms = parseDate(s.date);
    if (ms === null) { problems.push(`invalid date ${s.date}`); continue; }
    if (ms < start || ms > end) problems.push(`${s.date} is outside the range`);
    if (seen.has(s.date)) problems.push(`${s.date} is used twice`);
    if (ms <= last) problems.push('dates are not in order');
    seen.add(s.date);
    last = ms;
  }
  if (problems.length) return problems;

  const weeks = splitWeeks(start, end);
  const byWeek = new Map(weeks.map((w) => [w.start, []]));
  for (const s of slots) {
    const ms = parseDate(s.date);
    byWeek.get(ms - dayIndexOf(ms) * DAY_MS).push(dayIndexOf(ms));
  }
  let previousFull = null;
  const fullCombos = [];
  for (const week of weeks) {
    const combo = byWeek.get(week.start);
    const k = weeklyQuota(week.valid.length, postsPerWeek);
    if (combo.length !== k) problems.push(`week of ${formatDate(week.start)} has ${combo.length} posts, expected ${k}`);
    if (k === 0) { previousFull = null; continue; }
    const full = week.valid.length === 7;
    if (k < week.valid.length && adjacentPairs(combo) > allowedAdjacency(week.valid, k)) problems.push(`week of ${formatDate(week.start)} posts on too many consecutive days`);
    if (full && k >= 2 && k < 7 && combo[combo.length - 1] - combo[0] < minSpan(k)) problems.push(`week of ${formatDate(week.start)} is clustered`);
    if (full && k < 7) {
      if (sameCombo(combo, previousFull)) problems.push(`week of ${formatDate(week.start)} repeats last week's days`);
      fullCombos.push(combo.join(','));
    }
    previousFull = full ? combo : null;
  }
  if (postsPerWeek < 7 && fullCombos.length >= 3 && new Set(fullCombos).size < Math.min(fullCombos.length, 3)) problems.push('the weekday pattern is not varied enough');
  return problems;
}

function planWeekdays({ start, end, postsPerWeek, recommended, seed }) {
  const random = seededRandom(seed);
  const weeks = splitWeeks(start, end);
  const usage = new Array(7).fill(0);
  const history = [];
  const slots = [];
  let prevLastMs = null;
  for (const week of weeks) {
    const k = weeklyQuota(week.valid.length, postsPerWeek);
    if (k === 0) continue;
    const combo = pickWeekCombo({ week, k, startMs: week.start, prevLastMs, history, usage, recommended, random });
    for (const d of combo) {
      const ms = week.start + d * DAY_MS;
      slots.push({ index: slots.length, date: formatDate(ms), dayOfWeek: WEEKDAYS[d] });
      usage[d] += 1;
      prevLastMs = ms;
    }
    if (week.valid.length === 7) history.push(combo); else history.length = 0;
  }
  return slots;
}

/**
 * The dates that carry a post — a different, validated set of weekdays in each week (see above). `seed` makes it
 * reproducible: the same seed always gives the same dates. A plan that fails validation is replaced by another seeded
 * attempt before it is ever used. A 7-day window starting on a Monday yields exactly `postsPerWeek` slots.
 */
export function buildSlots({ startDate, endDate, postsPerWeek, recommendedDays = [], seed = '' }) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start === null || end === null || end < start) return [];
  const recommended = new Set(WEEKDAYS.map((d, i) => (Array.isArray(recommendedDays) && recommendedDays.includes(d) ? i : -1)).filter((i) => i >= 0));
  let best = null;
  for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
    const slots = planWeekdays({ start, end, postsPerWeek, recommended, seed: seedFromParts(seed, attempt) });
    const problems = validateSlotPlan(slots, { startDate, endDate, postsPerWeek });
    if (!problems.length) return slots;
    if (!best || problems.length < best.problems) best = { slots, problems: problems.length };
  }
  return best.slots;
}

/** The seed of a stored calendar document: its project, version, range and the strategy version it was planned from. */
export function calendarSeed({ projectId, version, startDate, endDate, strategyVersion }) {
  return `${projectId}|v${version}|${startDate}|${endDate}|s${strategyVersion}`;
}

/**
 * Smooth weighted interleave: returns `total` keys so each key appears in proportion to its weight and equal keys
 * are spread out rather than clustered. Deterministic: ties go to the earlier key.
 */
export function weightedSequence(entries, total) {
  const live = entries.filter((e) => e.weight > 0);
  if (!live.length || total <= 0) return [];
  const sum = live.reduce((s, e) => s + e.weight, 0);
  // largest-remainder quotas first, so the totals are exact
  const quotas = live.map((e, i) => ({ key: e.key, i, exact: (e.weight / sum) * total }));
  quotas.forEach((q) => { q.count = Math.floor(q.exact); });
  let left = total - quotas.reduce((s, q) => s + q.count, 0);
  [...quotas].sort((a, b) => (b.exact - b.count) - (a.exact - a.count) || a.i - b.i).slice(0, left).forEach((q) => { q.count += 1; });
  // then place them: each step picks the key furthest BEHIND its ideal share
  const placed = new Map(quotas.map((q) => [q.key, 0]));
  const out = [];
  for (let step = 1; step <= total; step += 1) {
    let best = null;
    for (const q of quotas) {
      if (placed.get(q.key) >= q.count) continue;
      const lag = (q.count * step) / total - placed.get(q.key);
      if (best === null || lag > best.lag + 1e-9) best = { q, lag };
    }
    placed.set(best.q.key, placed.get(best.q.key) + 1);
    out.push(best.q.key);
  }
  return out;
}

/** Assigns a content pillar to every slot from the strategy's percentages, over the WHOLE period. */
export function allocatePillars(slots, pillars) {
  const sequence = weightedSequence(pillars.map((p) => ({ key: p.name, weight: p.suggestedPercentage })), slots.length);
  const counts = new Map();
  sequence.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  const total = slots.length || 1;
  return {
    assignments: sequence,
    distribution: pillars.map((p) => ({
      pillar: p.name,
      targetPercent: p.suggestedPercentage,
      plannedCount: counts.get(p.name) || 0,
      plannedPercent: Math.round(((counts.get(p.name) || 0) / total) * 1000) / 10,
    })),
  };
}

/**
 * Platform per slot for the modes that fix it; null for ai_optimized (the model chooses per slot, validated later).
 *   balanced           one platform per slot, shared evenly (counts differ by at most one)
 *   platform_specific  one platform per slot, shared in proportion to the strategy's recommended posts per platform
 * With a single selected platform every mode is simply that platform.
 */
export function assignPlatforms(slots, platforms, mode, strategyPlatforms = [], seed = '') {
  if (platforms.length === 1) return slots.map(() => [platforms[0]]);
  if (mode === 'ai_optimized') return null;
  const weights = platforms.map((platform) => {
    if (mode === 'balanced') return { key: platform, weight: 1 };
    const rec = (strategyPlatforms || []).find((p) => p.platform === platform)?.postsPerWeek;
    return { key: platform, weight: Number.isFinite(rec) && rec > 0 ? rec : 1 };
  });
  const sequence = weightedSequence(weights, slots.length);
  // The even interleave would tie a platform to a position in the week (and so often to a weekday). Shuffling inside small
  // windows, with the calendar's seed, breaks that without changing the totals or letting one platform run for long.
  const random = seededRandom(seedFromParts(seed, 'platforms'));
  const window = mode === 'balanced' ? platforms.length : 4;
  for (let from = 0; from < sequence.length; from += window) {
    const end = Math.min(sequence.length, from + window);
    for (let i = end - 1; i > from; i -= 1) {
      const j = from + Math.floor(random() * (i - from + 1));
      [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
    }
  }
  return sequence.map((p) => [p]);
}

/**
 * What a calendar request means, WITHOUT any AI call or database access: the validated period, the exact number of posts the
 * planner will schedule, and the weeks that are only partly inside the period (their share is pro-rated). The count is exact
 * because the server's quota per week does not depend on the seed or on the AI. Refuses a calendar larger than
 * CALENDAR_MAX_POSTS before anything expensive starts. Returns { value } or { error: { code, message } }.
 */
export function previewCalendarPlan(body, options) {
  const checked = validateCalendarInput(body, options);
  if (checked.error) return checked;
  const { startDate, endDate, months, postsPerWeek, days } = checked.value;
  const slots = buildSlots({ startDate, endDate, postsPerWeek });
  if (!slots.length) return bad('INVALID_DATE_RANGE', 'That date range has no posting days. Choose a longer range.');
  if (slots.length > CALENDAR_MAX_POSTS) return bad('CALENDAR_TOO_LARGE', `That would be ${slots.length} posts; a calendar can hold at most ${CALENDAR_MAX_POSTS}. Choose fewer posts per week or a shorter calendar.`);
  const partialWeeks = splitWeeks(parseDate(startDate), parseDate(endDate))
    .filter((w) => w.valid.length < 7)
    .map((w) => ({ weekStart: formatDate(w.start), days: w.valid.length, posts: weeklyQuota(w.valid.length, postsPerWeek) }));
  return { value: { ...checked.value, months, days, totalPosts: slots.length, partialWeeks, steps: Math.ceil(slots.length / CALENDAR_BATCH_SIZE) } };
}

export default { validateCalendarInput, previewCalendarPlan, periodEndDate, addMonthsClamped, buildSlots, validateSlotPlan, calendarSeed, weeklyQuota, splitWeeks, weightedSequence, allocatePillars, assignPlatforms, parseDate, formatDate };
