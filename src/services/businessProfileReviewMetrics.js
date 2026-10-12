/**
 * Business Profile review analytics - PURE metric logic (no DB, no I/O).
 *
 * The analytics service (businessProfileReviewAnalyticsService.js) asks MongoDB
 * for per-LOCAL-DAY rows plus lifetime totals; everything here turns those rows
 * into the response: range resolution, bucketing (day/week/month), zero-filling,
 * rates and percentages. Kept pure so every rule below is unit-tested.
 *
 * ── Metric rules (single source of truth) ───────────────────────────────────
 *  LIFETIME   every stored, non-deleted review of the connected location.
 *  PERIOD     reviews whose review_create_time falls in the selected range
 *             (local days, inclusive of today).
 *  hasText    comment, trimmed, is non-empty.
 *  responded  reply.comment is non-empty (same rule as the Reviews list).
 *  sentiment  stored sentiment_label if present, otherwise derived from the
 *             star rating (see businessProfileReviewSentimentService.js).
 *  averages   arithmetic mean of star_rating (2 dp). null when there are no
 *             reviews - never 0, never NaN.
 *  percents   2 dp, 0 when the denominator is 0.
 */

export const RANGE_PRESETS = {
  '7d': { days: 7, bucket: 'day' },
  '30d': { days: 30, bucket: 'day' },
  '90d': { days: 90, bucket: 'week' },
  '6m': { months: 6, bucket: 'week' },
  '12m': { months: 12, bucket: 'month' },
};
export const DEFAULT_RANGE = '90d';

// ── timezone / date-key helpers (date keys are 'YYYY-MM-DD' in the viewer's tz)

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localDateKey(date, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant at which local calendar day `key` starts in `tz`. */
export function zonedMidnightUtc(key, tz = 'UTC') {
  const guess = Date.parse(`${key}T00:00:00Z`);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz)); // second pass settles DST edges
}

const toUtcDate = (key) => new Date(`${key}T00:00:00Z`);
const toKey = (d) => d.toISOString().slice(0, 10);

export function addDays(key, n) {
  const d = toUtcDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}

export function addMonths(key, n) {
  const d = toUtcDate(key);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toKey(d);
}

/** Start key of the bucket `dayKey` belongs to. Weeks start on Monday. */
export function bucketKeyFor(dayKey, unit) {
  if (unit === 'day') return dayKey;
  if (unit === 'month') return `${dayKey.slice(0, 7)}-01`;
  const dow = (toUtcDate(dayKey).getUTCDay() + 6) % 7; // Mon=0
  return addDays(dayKey, -dow);
}

export function listBucketKeys(startKey, endKey, unit) {
  const keys = [];
  for (let k = startKey; k <= endKey; k = addDays(k, 1)) {
    const b = bucketKeyFor(k, unit);
    if (keys[keys.length - 1] !== b) keys.push(b);
  }
  return keys;
}

/**
 * Resolve a preset into the concrete window. `now` is injectable for tests.
 * "7d" = today + the previous 6 local days; "6m"/"12m" = same calendar day N
 * months ago (+1 day) through today.
 */
export function resolveRange(rangeKey, now = new Date(), tz = 'UTC') {
  const preset = RANGE_PRESETS[rangeKey];
  if (!preset) throw new Error(`Unknown range: ${rangeKey}`);
  const endKey = localDateKey(now, tz);
  const startKey = preset.days
    ? addDays(endKey, -(preset.days - 1))
    : addDays(addMonths(endKey, -preset.months), 1);
  return {
    key: rangeKey,
    bucket: preset.bucket,
    timezone: tz,
    startKey,
    endKey,
    start: zonedMidnightUtc(startKey, tz),
    end: now,
  };
}

// ── row arithmetic ─────────────────────────────────────────────────────────

/** Accumulator row produced by the Mongo $group (see analytics service). */
export const EMPTY_ROW = Object.freeze({
  total: 0, ratingSum: 0, r1: 0, r2: 0, r3: 0, r4: 0, r5: 0,
  withText: 0, responded: 0, positive: 0, neutral: 0, negative: 0, storedSentiment: 0,
});

export function sumRows(rows) {
  const out = { ...EMPTY_ROW };
  for (const r of rows) for (const k of Object.keys(EMPTY_ROW)) out[k] += r?.[k] || 0;
  return out;
}

export const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);
const avg = (sum, n) => (n > 0 ? Math.round((sum / n) * 100) / 100 : null);

/**
 * Reviews that carry a 1-5 star rating. Every rating metric (average, bucket
 * percentages) uses THIS as its denominator, never `total`: a stored review
 * without a usable rating still counts in `total` but has no bucket and no
 * star value, so dividing by `total` would understate the average and make the
 * bucket percentages sum to less than 100. With complete data rated === total
 * and nothing changes. `total - rated` is reported as `unrated`.
 */
export const ratedCount = (row) => (row.r1 || 0) + (row.r2 || 0) + (row.r3 || 0) + (row.r4 || 0) + (row.r5 || 0);

function ratingBreakdown(row) {
  const rated = ratedCount(row);
  return [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: row[`r${stars}`],
    percent: pct(row[`r${stars}`], rated),
  }));
}

function responseBlock(row) {
  return {
    total: row.total,
    responded: row.responded,
    notResponded: row.total - row.responded,
    responseRate: pct(row.responded, row.total),
  };
}

function sentimentBlock(row) {
  const classified = row.positive + row.neutral + row.negative;
  return {
    positive: row.positive, neutral: row.neutral, negative: row.negative, total: classified,
    positivePercent: pct(row.positive, classified),
    neutralPercent: pct(row.neutral, classified),
    negativePercent: pct(row.negative, classified),
  };
}

/**
 * Version of the metric rules above (hasText / responded / sentiment / average
 * definitions). Stored on every historical snapshot so a future change to a
 * rule never makes old snapshots ambiguous. Bump when a definition changes.
 */
export const METRIC_RULES_VERSION = 1;

/**
 * Flat headline metrics for ONE accumulator row, using exactly the same
 * helpers (avg / pct) and field meanings as buildAnalytics(). The historical
 * snapshot is built from this - there is no second set of formulas.
 */
export function summarizeRow(row) {
  const r = { ...EMPTY_ROW, ...(row || {}) };
  return {
    totalReviews: r.total,
    averageRating: avg(r.ratingSum, ratedCount(r)),
    ratingDistribution: { one: r.r1, two: r.r2, three: r.r3, four: r.r4, five: r.r5 },
    withText: r.withText,
    withoutText: r.total - r.withText,
    responded: r.responded,
    notResponded: r.total - r.responded,
    responseRate: pct(r.responded, r.total),
    sentiment: { positive: r.positive, neutral: r.neutral, negative: r.negative },
    storedSentimentLabels: r.storedSentiment,
  };
}

/**
 * @param {object} p
 * @param {object} p.range     from resolveRange()
 * @param {object} p.lifetime  accumulator row over ALL stored reviews
 * @param {Array}  p.daily     [{ _id:'YYYY-MM-DD', ...accumulator row }] for the range
 * @param {object} p.recent    { pos7, neu7, neg7, tot7, pos30, neu30, neg30, tot30 } (fixed windows ending now)
 * @param {object} p.google    { averageRating, totalReviewCount, lastSyncedAt } from Google (reconciliation only)
 */
export function buildAnalytics({ range, lifetime, daily, recent, google, now = new Date() }) {
  const life = { ...EMPTY_ROW, ...(lifetime || {}) };
  // Totals and series are built from the same in-range rows, so they always agree.
  const byDay = new Map(
    (daily || []).filter((r) => r._id >= range.startKey && r._id <= range.endKey).map((r) => [r._id, r])
  );
  const period = sumRows(byDay.values());

  // Bucket the daily rows (zero-filled so charts keep a continuous axis).
  const keys = listBucketKeys(range.startKey, range.endKey, range.bucket);
  const buckets = new Map(keys.map((k) => [k, []]));
  for (const [day, row] of byDay) {
    const b = bucketKeyFor(day, range.bucket);
    if (buckets.has(b)) buckets.get(b).push(row);
  }
  const bucketRows = keys.map((k) => [k, sumRows(buckets.get(k))]);

  const rc = recent || {};
  return {
    range: {
      key: range.key,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      startDate: range.startKey,
      endDate: range.endKey,
      timezone: range.timezone,
      bucket: range.bucket,
    },
    generatedAt: now.toISOString(),

    // Cards: LIFETIME is primary, PERIOD is the same figures for the range.
    overview: {
      lifetime: {
        totalReviews: life.total,
        averageRating: avg(life.ratingSum, ratedCount(life)),
        withText: life.withText,
        withoutText: life.total - life.withText,
      },
      period: {
        totalReviews: period.total,
        averageRating: avg(period.ratingSum, ratedCount(period)),
        withText: period.withText,
        withoutText: period.total - period.withText,
      },
      // Google's own numbers, shown for transparency (stored reviews can lag a sync).
      google: {
        totalReviewCount: google?.totalReviewCount ?? null,
        averageRating: google?.averageRating ?? null,
        lastSyncedAt: google?.lastSyncedAt ?? null,
      },
    },

    ratings: {
      period: ratingBreakdown(period),
      lifetime: ratingBreakdown(life),
      // Reviews counted in the totals but without a 1-5 rating (excluded from
      // the buckets, the percentages and the averages). 0 for complete data.
      unrated: { period: period.total - ratedCount(period), lifetime: life.total - ratedCount(life) },
      // Per-bucket star counts (stacked rating chart). Same daily rows as everything
      // else, so bucket sums always equal `period`.
      series: bucketRows.map(([bucket, r]) => ({ bucket, one: r.r1, two: r.r2, three: r.r3, four: r.r4, five: r.r5 })),
    },

    trends: bucketRows.map(([bucket, r]) => ({
      bucket,
      reviewCount: r.total,
      averageRating: avg(r.ratingSum, ratedCount(r)), // null for empty buckets - no invented values
    })),

    glance: {
      periodReviews: period.total,
      lifetimeReviews: life.total,
      treatment: {
        respondedPercent: pct(period.responded, period.total),
        notRespondedPercent: period.total > 0 ? Math.round((100 - pct(period.responded, period.total)) * 100) / 100 : 0,
      },
      last7Days: { positive: rc.pos7 || 0, neutral: rc.neu7 || 0, negative: rc.neg7 || 0, total: rc.tot7 || 0 },
      last30Days: { positive: rc.pos30 || 0, neutral: rc.neu30 || 0, negative: rc.neg30 || 0, total: rc.tot30 || 0 },
    },

    response: { period: responseBlock(period), lifetime: responseBlock(life) },

    distribution: {
      totals: { withText: period.withText, withoutText: period.total - period.withText },
      series: bucketRows.map(([bucket, r]) => ({ bucket, withText: r.withText, withoutText: r.total - r.withText })),
    },

    sentiment: {
      period: sentimentBlock(period),
      lifetime: sentimentBlock(life),
      // Transparency: how many lifetime reviews carry a stored (analysed) label
      // vs. one derived from the star rating.
      basis: {
        storedLabels: life.storedSentiment,
        derivedFromRating: life.total - life.storedSentiment,
      },
      timeline: bucketRows.map(([bucket, r]) => ({
        bucket, positive: r.positive, neutral: r.neutral, negative: r.negative,
        total: r.positive + r.neutral + r.negative,
      })),
    },
  };
}
