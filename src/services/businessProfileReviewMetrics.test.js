import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRange, buildAnalytics, bucketKeyFor, listBucketKeys, addMonths, addDays, pct,
  localDateKey, zonedMidnightUtc, isValidTimezone, EMPTY_ROW,
} from './businessProfileReviewMetrics.js';
import { ratingToSentiment, resolveSentiment } from './businessProfileReviewSentimentService.js';

const NOW = new Date('2026-10-06T20:00:00Z'); // = 2026-10-07 01:30 in Asia/Kolkata

const row = (over = {}) => ({ ...EMPTY_ROW, ...over });
const build = (daily, over = {}, rangeKey = '7d', tz = 'UTC') => buildAnalytics({
  range: resolveRange(rangeKey, NOW, tz), lifetime: row(), daily, recent: {}, google: {}, now: NOW, ...over,
});
/** every number anywhere in the payload must be finite (no NaN / Infinity) */
const allFinite = (v) => {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
};

describe('date range', () => {
  test('7d = today + previous 6 local days; end is "now"', () => {
    const r = resolveRange('7d', NOW, 'UTC');
    assert.equal(r.startKey, '2026-09-30');
    assert.equal(r.endKey, '2026-10-06');
    assert.equal(r.bucket, 'day');
  });
  test('timezone moves the local "today" (IST is already Oct 7)', () => {
    const r = resolveRange('7d', NOW, 'Asia/Kolkata');
    assert.equal(r.endKey, '2026-10-07');
    assert.equal(r.startKey, '2026-10-01');
    assert.equal(r.start.toISOString(), '2026-09-30T18:30:00.000Z'); // local midnight in UTC
  });
  test('month presets use calendar months and the documented bucket sizes', () => {
    assert.deepEqual([resolveRange('90d', NOW).bucket, resolveRange('6m', NOW).bucket, resolveRange('12m', NOW).bucket], ['week', 'week', 'month']);
    assert.equal(resolveRange('12m', NOW).startKey, '2025-10-07');
    assert.equal(resolveRange('6m', NOW).startKey, '2026-04-07');
  });
  test('addMonths clamps to month end', () => {
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
  test('unknown range throws, timezone validation', () => {
    assert.throws(() => resolveRange('1y', NOW));
    assert.equal(isValidTimezone('Asia/Kolkata'), true);
    assert.equal(isValidTimezone('Not/AZone'), false);
    assert.equal(isValidTimezone(undefined), false);
  });
  test('zonedMidnightUtc handles a DST zone', () => {
    assert.equal(zonedMidnightUtc('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z');
    assert.equal(zonedMidnightUtc('2026-01-01', 'America/New_York').toISOString(), '2026-01-01T05:00:00.000Z');
  });
  test('localDateKey follows the timezone', () => {
    assert.equal(localDateKey(new Date('2026-10-06T20:00:00Z'), 'UTC'), '2026-10-06');
    assert.equal(localDateKey(new Date('2026-10-06T20:00:00Z'), 'Asia/Kolkata'), '2026-10-07');
  });
});

describe('bucketing', () => {
  test('weeks start Monday, months on the 1st', () => {
    assert.equal(bucketKeyFor('2026-10-07', 'week'), '2026-10-05'); // Wed -> Mon
    assert.equal(bucketKeyFor('2026-10-05', 'week'), '2026-10-05');
    assert.equal(bucketKeyFor('2026-10-11', 'week'), '2026-10-05'); // Sun
    assert.equal(bucketKeyFor('2026-10-20', 'month'), '2026-10-01');
  });
  test('listBucketKeys is continuous and ordered', () => {
    assert.deepEqual(listBucketKeys('2026-09-30', '2026-10-06', 'day').length, 7);
    assert.deepEqual(listBucketKeys('2026-09-28', '2026-10-11', 'week'), ['2026-09-28', '2026-10-05']);
    assert.deepEqual(listBucketKeys('2026-08-15', '2026-10-06', 'month'), ['2026-08-01', '2026-09-01', '2026-10-01']);
  });
  test('range sizes stay chart-friendly', () => {
    const points = (k) => build([], {}, k).trends.length;
    assert.equal(points('7d'), 7);
    assert.equal(points('30d'), 30);
    assert.ok(points('90d') <= 15);
    assert.ok(points('6m') <= 28);
    assert.ok(points('12m') <= 13);
  });
});

describe('buildAnalytics - edge cases', () => {
  test('0 reviews: no NaN/Infinity, null average, 0 rates, zero-filled axes', () => {
    const a = build([]);
    assert.ok(allFinite(a));
    assert.equal(a.overview.lifetime.averageRating, null);
    assert.equal(a.overview.period.averageRating, null);
    assert.equal(a.response.period.responseRate, 0);
    assert.equal(a.sentiment.period.positivePercent, 0);
    assert.equal(a.glance.treatment.notRespondedPercent, 0);
    assert.equal(a.trends.length, 7);
    assert.ok(a.trends.every((t) => t.reviewCount === 0 && t.averageRating === null));
  });
  test('1 review (5 stars, text, replied)', () => {
    const r = row({ total: 1, ratingSum: 5, r5: 1, withText: 1, responded: 1, positive: 1 });
    const a = build([{ _id: '2026-10-06', ...r }], { lifetime: r });
    assert.equal(a.overview.period.averageRating, 5);
    assert.equal(a.response.period.responseRate, 100);
    assert.equal(a.sentiment.period.positivePercent, 100);
    assert.equal(a.trends.at(-1).reviewCount, 1);
    assert.equal(a.trends.at(-1).averageRating, 5);
  });
  test('only 1-star reviews are all negative, average 1', () => {
    const r = row({ total: 3, ratingSum: 3, r1: 3, negative: 3 });
    const a = build([{ _id: '2026-10-05', ...r }], { lifetime: r });
    assert.equal(a.overview.period.averageRating, 1);
    assert.deepEqual(a.ratings.period.map((x) => x.count), [0, 0, 0, 0, 3]); // 5★..1★
    assert.equal(a.sentiment.period.negativePercent, 100);
  });
  test('only 5-star reviews, none replied, none with text', () => {
    const r = row({ total: 4, ratingSum: 20, r5: 4, positive: 4 });
    const a = build([{ _id: '2026-10-05', ...r }], { lifetime: r });
    assert.equal(a.response.period.responded, 0);
    assert.equal(a.response.period.notResponded, 4);
    assert.equal(a.response.period.responseRate, 0);
    assert.equal(a.overview.period.withoutText, 4);
    assert.equal(a.distribution.totals.withoutText, 4);
  });
  test('rows outside the range are ignored everywhere (totals and series agree)', () => {
    const r = row({ total: 9, ratingSum: 45, r5: 9, positive: 9 });
    const a = build([{ _id: '2020-01-01', ...r }]);
    assert.equal(a.overview.period.totalReviews, 0);
    assert.equal(a.trends.reduce((s, t) => s + t.reviewCount, 0), 0);
  });
});

describe('buildAnalytics - invariants on mixed data', () => {
  const days = [
    { _id: '2026-10-01', ...row({ total: 5, ratingSum: 22, r5: 3, r4: 1, r3: 1, withText: 4, responded: 5, positive: 4, neutral: 1 }) },
    { _id: '2026-10-02', ...row({ total: 3, ratingSum: 8, r5: 1, r2: 1, r1: 1, withText: 2, responded: 2, positive: 1, negative: 2 }) },
    { _id: '2026-10-06', ...row({ total: 2, ratingSum: 10, r5: 2, withText: 1, responded: 0, positive: 2 }) },
  ];
  const life = row({ total: 40, ratingSum: 180, r5: 25, r4: 10, r3: 2, r2: 1, r1: 2, withText: 30, responded: 38, positive: 35, neutral: 2, negative: 3, storedSentiment: 0 });
  const a = build(days, { lifetime: life });

  test('period totals', () => {
    assert.equal(a.overview.period.totalReviews, 10);
    assert.equal(a.overview.period.averageRating, 4);
    assert.equal(a.overview.period.withText, 7);
    assert.equal(a.overview.period.withText + a.overview.period.withoutText, 10);
  });
  test('rating distribution sums to the period total and percents are right', () => {
    assert.equal(a.ratings.period.reduce((s, x) => s + x.count, 0), 10);
    assert.deepEqual(a.ratings.period.find((x) => x.stars === 5), { stars: 5, count: 6, percent: 60 });
  });
  test('response numbers', () => {
    assert.equal(a.response.period.responded + a.response.period.notResponded, a.response.period.total);
    assert.equal(a.response.period.responseRate, 70);
    assert.equal(a.response.lifetime.responseRate, 95);
    assert.equal(a.glance.treatment.respondedPercent + a.glance.treatment.notRespondedPercent, 100);
  });
  test('sentiment + timeline agree with the period totals', () => {
    assert.equal(a.sentiment.period.positive + a.sentiment.period.neutral + a.sentiment.period.negative, 10);
    const t = a.sentiment.timeline;
    assert.equal(t.reduce((s, x) => s + x.total, 0), 10);
    assert.equal(t.reduce((s, x) => s + x.positive, 0), a.sentiment.period.positive);
    assert.equal(t.find((x) => x.bucket === '2026-10-02').negative, 2);
  });
  test('trends and distribution series agree with the period totals', () => {
    assert.equal(a.trends.reduce((s, x) => s + x.reviewCount, 0), 10);
    assert.equal(a.trends.find((x) => x.bucket === '2026-10-01').averageRating, 4.4);
    assert.equal(a.distribution.series.reduce((s, x) => s + x.withText + x.withoutText, 0), 10);
    assert.deepEqual(a.distribution.totals, { withText: 7, withoutText: 3 });
  });
  test('weekly bucketing sums days of the same week', () => {
    const w = build(days, { lifetime: life }, '90d');
    assert.equal(w.range.bucket, 'week');
    assert.equal(w.trends.find((x) => x.bucket === '2026-09-28').reviewCount, 8); // Oct 1 + Oct 2 (Mon Sep 28 week)
    assert.equal(w.trends.find((x) => x.bucket === '2026-10-05').reviewCount, 2);
  });
  test('ratings.series: per-bucket star counts that add up to the period distribution', () => {
    const s = a.ratings.series;
    assert.equal(s.length, a.trends.length);
    const total = (k) => s.reduce((sum, x) => sum + x[k], 0);
    assert.deepEqual([total('five'), total('four'), total('three'), total('two'), total('one')], a.ratings.period.map((x) => x.count));
    assert.deepEqual(s.find((x) => x.bucket === '2026-10-02'), { bucket: '2026-10-02', one: 1, two: 1, three: 0, four: 0, five: 1 });
    // every bucket's stars add up to that bucket's review count
    for (const x of s) assert.equal(x.one + x.two + x.three + x.four + x.five, a.trends.find((t) => t.bucket === x.bucket).reviewCount);
  });
  test('lifetime stays independent of the range; sentiment basis is reported', () => {
    assert.equal(a.overview.lifetime.totalReviews, 40);
    assert.equal(a.sentiment.basis.derivedFromRating, 40);
    assert.equal(a.sentiment.basis.storedLabels, 0);
    assert.ok(allFinite(a));
  });
  test('recent windows come straight from the fixed-window counts', () => {
    const b = build(days, { lifetime: life, recent: { pos7: 3, neg7: 1, tot7: 4, pos30: 9, neg30: 2, neu30: 1, tot30: 12 } });
    assert.deepEqual(b.glance.last7Days, { positive: 3, neutral: 0, negative: 1, total: 4 });
    assert.deepEqual(b.glance.last30Days, { positive: 9, neutral: 1, negative: 2, total: 12 });
  });
});

describe('sentiment rules', () => {
  test('rating fallback: 4-5 positive, 3 neutral, 1-2 negative', () => {
    assert.deepEqual([5, 4, 3, 2, 1].map(ratingToSentiment), ['positive', 'positive', 'neutral', 'negative', 'negative']);
  });
  test('a stored label takes precedence over the rating', () => {
    assert.equal(resolveSentiment({ storedLabel: 'negative', rating: 5 }), 'negative');
    assert.equal(resolveSentiment({ storedLabel: null, rating: 5 }), 'positive');
    assert.equal(resolveSentiment({ storedLabel: 'bogus', rating: 1 }), 'negative');
  });
  test('pct is safe for zero denominators', () => {
    assert.equal(pct(5, 0), 0);
    assert.equal(pct(1047, 1053), 99.43);
  });
});
