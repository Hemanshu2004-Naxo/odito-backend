import { previewCalendarPlan, formatDate } from '../calendar/calendarPlanner.js';
import { CALENDAR_MIN_MONTHS, CALENDAR_MAX_MONTHS } from '../calendar/calendarConfig.js';
import { PLATFORMS } from './strategyOutputSchema.js';

/**
 * strategyPlanning - the person's content-planning choice made while creating a strategy: how many posts per week, for how many months, on
 * which platforms. It is validated here and nowhere else, BY THE CALENDAR PLANNER (the single authority for supported values, dates and counts):
 * this module only adds the strategy-level rules (the three keys, a duration is required). The count is the planner's exact count for a calendar
 * that starts tomorrow; the real calendar recomputes it from the real start date, so it is called an estimate.
 *
 * Saved with the strategy version (SocialAIStrategy.planning), sent to the strategy prompt, and offered as the default of the first calendar.
 */

export const PLANNING_KEYS = Object.freeze(['postsPerWeek', 'months', 'platforms']);

const bad = (code, message) => ({ error: { code, message } });
const addDay = (isoDate) => formatDate(Date.parse(`${isoDate}T00:00:00Z`) + 86_400_000);

/**
 * @param {unknown} input  { postsPerWeek, months, platforms } as the client sent them
 * @param {{ today?: string }} [options]  tests only: the date "tomorrow" is counted from
 * @returns {{ value: { postsPerWeek: number, months: number, platforms: string[], estimatedPosts: number, basisStartDate: string, basisEndDate: string, partialWeeks: object[] } } | { error: { code: string, message: string } }}
 */
export function validateStrategyPlanning(input, { today = formatDate(Date.now()) } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return bad('INVALID_BODY', 'The planning choice must be an object.');
  for (const key of Object.keys(input)) if (!PLANNING_KEYS.includes(key)) return bad('UNKNOWN_FIELD', `"${key}" is not a planning setting.`);
  if (input.months === undefined) return bad('INVALID_DURATION', `Choose how many months to plan for (${CALENDAR_MIN_MONTHS} to ${CALENDAR_MAX_MONTHS}).`);
  if (input.postsPerWeek === undefined) return bad('INVALID_POSTS_PER_WEEK', 'Choose how many posts per week.');
  if (input.platforms === undefined) return bad('INVALID_PLATFORMS', 'Choose at least one platform.');
  const startDate = addDay(today);
  const planned = previewCalendarPlan({ startDate, months: input.months, postsPerWeek: input.postsPerWeek, platforms: input.platforms, distributionMode: 'balanced' }, { today });
  if (planned.error) return planned;
  const v = planned.value;
  return { value: { postsPerWeek: v.postsPerWeek, months: v.months, platforms: v.platforms, estimatedPosts: v.totalPosts, basisStartDate: v.startDate, basisEndDate: v.endDate, partialWeeks: v.partialWeeks } };
}

/** What is stored on the strategy version (no dates that would age: only the choice and the estimate it produced). */
export const toStoredPlanning = (value, now = new Date()) => ({
  postsPerWeek: value.postsPerWeek, months: value.months, platforms: [...value.platforms], estimatedPosts: value.estimatedPosts, basisStartDate: value.basisStartDate, confirmedAt: now,
});

/** The stored planning as the client may see it (null for a strategy saved before the wizard existed). */
export function toApiPlanning(stored) {
  if (!stored || !Number.isInteger(stored.postsPerWeek) || !Number.isInteger(stored.months)) return null;
  return {
    postsPerWeek: stored.postsPerWeek,
    months: stored.months,
    platforms: [...(stored.platforms || [])].filter((p) => PLATFORMS.includes(p)),
    estimatedPosts: stored.estimatedPosts ?? null,
    confirmedAt: stored.confirmedAt ? new Date(stored.confirmedAt).toISOString() : null,
  };
}

/** Splits `total` over weighted entries with whole numbers that add up to exactly `total` (largest remainder). */
export function splitAcross(weights, total) {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => Math.floor(total / weights.length) + (i < total % weights.length ? 1 : 0));
  const exact = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((s, n) => s + n, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) out[order[k][1]] += 1;
  return out;
}

export default { validateStrategyPlanning, toStoredPlanning, toApiPlanning, splitAcross, PLANNING_KEYS };
