/**
 * Shared Day/Week/Month range resolution for the Social Overview cards
 * (Facebook Page Views, Instagram Comments vs Likes). One place so both
 * platforms' overview services compute the exact same window for the
 * same `range` value instead of each re-deriving it slightly differently.
 */

const RANGE_DAYS = { day: 1, week: 7, month: 30 };

export const VALID_RANGES = Object.keys(RANGE_DAYS);
export const DEFAULT_RANGE = 'month';

export function resolveRange(range) {
  return VALID_RANGES.includes(range) ? range : DEFAULT_RANGE;
}

/** { since, until } as Date objects — `until` is now, `since` is `until` minus the range's day count. */
export function resolveRangeWindow(range) {
  const resolved = resolveRange(range);
  const until = new Date();
  const since = new Date(until.getTime() - RANGE_DAYS[resolved] * 24 * 60 * 60 * 1000);
  return { since, until };
}
