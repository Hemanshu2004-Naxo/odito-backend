import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComparison, comparisonWindows, analyzePeriod, compareMetric, percentageChange, percentagePointChange,
  incomparableMetricKeys, periodKind, inclusiveDays, COMPARISON_METRICS, COMPARISON_RULES, METRIC_RULE_CHANGES,
} from './businessProfileReviewComparisonMetrics.js';
import { resolveRange, addDays } from './businessProfileReviewMetrics.js';

const NOW = new Date('2026-10-07T06:00:00Z');
const rangeOf = (startKey, endKey, key = '30d') => ({ key, startKey, endKey });
const def = (key) => COMPARISON_METRICS.find((d) => d.key === key);

/** a snapshot row; `m` overrides the stored metrics */
const metrics = (over = {}) => ({
  total_reviews: 1000, average_rating: 4.8, with_text: 850, without_text: 150,
  responded: 980, not_responded: 20, response_rate: 98,
  sentiment: { positive: 960, neutral: 10, negative: 30 },
  rating_distribution: { one: 10, two: 5, three: 10, four: 40, five: 935 },
  ...over,
});
const snap = (date, over = {}, tz = 'UTC', version = 1) => ({ snapshot_date: date, timezone: tz, metric_rules_version: version, metrics: metrics(over) });
/** one row per day from..to inclusive (all days when `skip` is empty) */
const days = (from, to, over = {}, { skip = [], tz = 'UTC', version = 1 } = {}) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!skip.includes(d)) out.push(snap(d, over, tz, version));
  return out;
};

describe('period calculation', () => {
  test('1/2. a full calendar month vs the previous calendar month (labelled as such, lengths flagged)', () => {
    const w = comparisonWindows(rangeOf('2026-10-01', '2026-10-31'));
    assert.deepEqual(w.mom, { startKey: '2026-09-01', endKey: '2026-09-30' });
    assert.equal(periodKind('2026-10-01', '2026-10-31'), 'calendar_month');
    assert.equal(periodKind('2026-09-01', '2026-09-30'), 'calendar_month');
    const c = buildComparison({ range: rangeOf('2026-10-01', '2026-10-31'), rows: [], snapshotTimezone: 'UTC' });
    assert.equal(c.mom.equalLength, false); // 31 vs 30 days is stated, not hidden
    assert.equal(c.mom.currentPeriod.lengthDays, 31);
    assert.equal(c.mom.previousPeriod.lengthDays, 30);
  });
  test('3/4. a partial current month is compared with the SAME elapsed days of the previous month', () => {
    const w = comparisonWindows(rangeOf('2026-10-01', '2026-10-07', '7d'));
    assert.deepEqual(w.mom, { startKey: '2026-09-01', endKey: '2026-09-07' });
    assert.equal(inclusiveDays(w.mom.startKey, w.mom.endKey), 7);
    assert.equal(periodKind('2026-10-01', '2026-10-07'), 'range'); // not mislabelled as a whole month
  });
  test('5/6. full year, and a partial (year-to-date) year vs the same elapsed days', () => {
    assert.deepEqual(comparisonWindows(rangeOf('2026-01-01', '2026-12-31')).yoy, { startKey: '2025-01-01', endKey: '2025-12-31' });
    assert.equal(periodKind('2026-01-01', '2026-12-31'), 'calendar_year');
    assert.deepEqual(comparisonWindows(rangeOf('2026-01-01', '2026-10-07')).yoy, { startKey: '2025-01-01', endKey: '2025-10-07' });
    assert.deepEqual(comparisonWindows(rangeOf('2026-10-01', '2026-10-07')).yoy, { startKey: '2025-10-01', endKey: '2025-10-07' });
  });
  test('7. leap year: Feb 29 clamps to Feb 28 and the shorter length is flagged', () => {
    const w = comparisonWindows(rangeOf('2028-02-01', '2028-02-29'));
    assert.deepEqual(w.yoy, { startKey: '2027-02-01', endKey: '2027-02-28' });
    assert.deepEqual(w.mom, { startKey: '2028-01-01', endKey: '2028-01-29' });
    assert.equal(periodKind('2028-02-01', '2028-02-29'), 'calendar_month');
    assert.equal(buildComparison({ range: rangeOf('2028-02-01', '2028-02-29'), rows: [], snapshotTimezone: 'UTC' }).yoy.equalLength, false);
  });
  test('8. February / short months', () => {
    assert.deepEqual(comparisonWindows(rangeOf('2026-03-01', '2026-03-31')).mom, { startKey: '2026-02-01', endKey: '2026-02-28' });
    assert.deepEqual(comparisonWindows(rangeOf('2026-03-01', '2026-03-30')).mom, { startKey: '2026-02-01', endKey: '2026-02-28' });
  });
  test('9. different month lengths clamp to the previous month end', () => {
    assert.deepEqual(comparisonWindows(rangeOf('2026-05-01', '2026-05-31')).mom, { startKey: '2026-04-01', endKey: '2026-04-30' });
    assert.deepEqual(comparisonWindows(rangeOf('2026-01-01', '2026-01-31')).mom, { startKey: '2025-12-01', endKey: '2025-12-31' });
    assert.deepEqual(comparisonWindows(rangeOf('2026-08-31', '2026-08-31')).mom, { startKey: '2026-07-31', endKey: '2026-07-31' });
  });
  test('every dashboard range maps consistently (current = the selected window, shifted by 1 month / 1 year)', () => {
    for (const k of ['7d', '30d', '90d', '6m', '12m']) {
      const r = resolveRange(k, NOW, 'UTC');
      const w = comparisonWindows(r);
      assert.deepEqual(w.current, { startKey: r.startKey, endKey: r.endKey });
      assert.equal(w.mom.endKey, '2026-09-07');
      assert.equal(w.yoy.endKey, '2025-10-07');
    }
  });
  test('10. timezone boundaries: the same instant is a different local "today" in IST vs UTC, and the windows follow', () => {
    const late = new Date('2026-10-06T20:00:00Z');
    assert.equal(resolveRange('7d', late, 'UTC').endKey, '2026-10-06');
    assert.equal(resolveRange('7d', late, 'Asia/Kolkata').endKey, '2026-10-07');
    assert.equal(comparisonWindows(resolveRange('7d', late, 'Asia/Kolkata')).mom.endKey, '2026-09-07');
  });
  test('10b. rows stored in ANOTHER timezone are never mixed in (excluded and counted)', () => {
    const win = { startKey: '2026-10-01', endKey: '2026-10-07' };
    const rows = [...days('2026-10-01', '2026-10-04', {}, { tz: 'UTC' }), ...days('2026-10-05', '2026-10-07', {}, { tz: 'Asia/Kolkata' })];
    const a = analyzePeriod(win, rows, 'Asia/Kolkata').period;
    assert.equal(a.coverage.snapshotDays, 3);
    assert.equal(a.coverage.excludedOtherTimezone, 4);
  });
});

describe('snapshot coverage (a missing day is UNKNOWN, never zero)', () => {
  const win = { startKey: '2026-10-01', endKey: '2026-10-07' };
  const analyze = (rows) => analyzePeriod(win, rows, 'UTC').period;

  test('11. full coverage', () => {
    const a = analyze(days('2026-10-01', '2026-10-07'));
    assert.deepEqual([a.coverage.expectedDays, a.coverage.snapshotDays, a.coverage.percent, a.quality], [7, 7, 100, 'full']);
    assert.equal(a.asOfDate, '2026-10-07');
  });
  test('12. partial coverage', () => {
    const a = analyze(days('2026-10-01', '2026-10-07', {}, { skip: ['2026-10-03', '2026-10-05'] }));
    assert.deepEqual([a.coverage.snapshotDays, a.coverage.percent, a.coverage.missingDays, a.quality], [5, 71.43, 2, 'partial']);
  });
  test('13. missing first day', () => {
    const a = analyze(days('2026-10-01', '2026-10-07', {}, { skip: ['2026-10-01'] }));
    assert.equal(a.coverage.hasStartSnapshot, false);
    assert.equal(a.coverage.firstSnapshotDate, '2026-10-02');
    assert.equal(a.quality, 'partial');
  });
  test('14. missing last day: the end state is the last snapshot actually taken, and its date is reported', () => {
    const a = analyze(days('2026-10-01', '2026-10-07', {}, { skip: ['2026-10-07'] }));
    assert.equal(a.coverage.hasEndSnapshot, false);
    assert.equal(a.coverage.endGapDays, 1);
    assert.equal(a.asOfDate, '2026-10-06');
    assert.equal(a.quality, 'partial');
  });
  test('14b. a stale end state (older than the tolerance) is not usable', () => {
    const a = analyze(days('2026-10-01', '2026-10-03'));
    assert.equal(a.coverage.endGapDays, 4);
    assert.ok(a.coverage.endGapDays > COMPARISON_RULES.endToleranceDays);
    assert.equal(a.quality, 'insufficient');
  });
  test('15. missing middle day', () => {
    const a = analyze(days('2026-10-01', '2026-10-07', {}, { skip: ['2026-10-04'] }));
    assert.deepEqual([a.coverage.missingDays, a.coverage.percent, a.coverage.hasStartSnapshot, a.coverage.hasEndSnapshot, a.quality], [1, 85.71, true, true, 'partial']);
  });
  test('16. no snapshots', () => {
    const a = analyze([]);
    assert.deepEqual([a.quality, a.coverage.snapshotDays, a.coverage.percent, a.asOfDate, a.coverage.firstSnapshotDate], ['none', 0, 0, null, null]);
  });
  test('17. one snapshot is not enough for a multi-day period (but is, for a one-day period)', () => {
    assert.equal(analyze([snap('2026-10-07')]).quality, 'insufficient'); // 1/7 = 14.29%
    assert.equal(analyzePeriod({ startKey: '2026-10-07', endKey: '2026-10-07' }, [snap('2026-10-07')], 'UTC').period.quality, 'full');
  });
  test('rows outside the window are ignored', () => {
    assert.equal(analyze(days('2026-09-01', '2026-09-30')).quality, 'none');
  });
});

describe('metric comparison', () => {
  const cmp = (key, cur, prev, incomparable) => compareMetric(def(key), cur, prev, incomparable);

  test('18. total review growth = end total - end total (never a sum of daily totals)', () => {
    const r = cmp('totalReviews', metrics({ total_reviews: 1053 }), metrics({ total_reviews: 1020 }));
    assert.deepEqual([r.current, r.previous, r.absoluteChange, r.percentageChange, r.trend, r.assessment], [1053, 1020, 33, 3.24, 'up', 'improved']);
  });
  test('19. average rating change, with both the absolute and the relative change', () => {
    const r = cmp('averageRating', metrics({ average_rating: 4.87 }), metrics({ average_rating: 4.82 }));
    assert.deepEqual([r.absoluteChange, r.percentageChange], [0.05, 1.04]);
    const down = cmp('averageRating', metrics({ average_rating: 4.62 }), metrics({ average_rating: 4.87 }));
    assert.deepEqual([down.absoluteChange, down.percentageChange, down.assessment], [-0.25, -5.13, 'worsened']);
  });
  test('20/21. response rate is a PERCENTAGE-POINT change, with no percentage change reported', () => {
    const r = cmp('responseRate', metrics({ response_rate: 99.62 }), metrics({ response_rate: 98.7 }));
    assert.equal(r.percentagePointChange, 0.92);
    assert.ok(!('percentageChange' in r) && !('absoluteChange' in r));
    assert.equal(cmp('responseRate', metrics({ response_rate: 95.2 }), metrics({ response_rate: 99.6 })).percentagePointChange, -4.4);
    assert.equal(percentagePointChange(99.62, 98.7), 0.92);
    assert.equal(percentagePointChange(null, 98.7), null);
  });
  test('22. percentage change formula and rounding', () => {
    assert.deepEqual(percentageChange(1020, 1053), { value: -3.13, state: 'changed' });
    assert.deepEqual(percentageChange(110, 100), { value: 10, state: 'changed' });
    assert.deepEqual(percentageChange(100, 100), { value: 0, state: 'unchanged' });
  });
  test('23. rating-distribution change per star (absolute and relative kept apart)', () => {
    const cur = metrics({ rating_distribution: { one: 17, two: 4, three: 6, four: 48, five: 977 } });
    const prev = metrics({ rating_distribution: { one: 20, two: 4, three: 5, four: 40, five: 940 } });
    const five = cmp('fiveStar', cur, prev);
    assert.deepEqual([five.current, five.previous, five.absoluteChange, five.percentageChange, five.assessment], [977, 940, 37, 3.94, 'improved']);
    assert.deepEqual([cmp('oneStar', cur, prev).absoluteChange, cmp('oneStar', cur, prev).assessment], [-3, 'improved']); // fewer 1-star = good
    assert.equal(cmp('twoStar', cur, prev).assessment, 'unchanged');
    assert.equal(cmp('threeStar', cur, prev).assessment, 'neutral');
  });
  test('24/25. a zero previous value is "new" - never Infinity or NaN', () => {
    assert.deepEqual(percentageChange(5, 0), { value: null, state: 'new' });
    assert.deepEqual(percentageChange(0, 0), { value: 0, state: 'unchanged' });
    const r = cmp('negative', metrics({ sentiment: { positive: 0, neutral: 0, negative: 5 } }), metrics({ sentiment: { positive: 0, neutral: 0, negative: 0 } }));
    assert.deepEqual([r.absoluteChange, r.percentageChange, r.percentageChangeState, r.assessment], [5, null, 'new', 'worsened']);
  });
  test('missing / non-finite inputs are "unavailable", not zero', () => {
    for (const [c, p] of [[null, 5], [5, undefined], [NaN, 1], [1, Infinity]]) assert.deepEqual(percentageChange(c, p), { value: null, state: 'unavailable' });
    assert.equal(cmp('averageRating', metrics({ average_rating: null }), metrics()).status, 'unknown'); // no reviews -> no average
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(COMPARISON_METRICS.map((d) => compareMetric(d, {}, {})))));
  });
  test('26/27/28. increase, decrease, no change - with the right good/bad meaning per metric', () => {
    const A = (key, c, p, field) => cmp(key, metrics(field(c)), metrics(field(p)));
    assert.equal(A('totalReviews', 11, 10, (v) => ({ total_reviews: v })).trend, 'up');
    assert.equal(A('totalReviews', 9, 10, (v) => ({ total_reviews: v })).trend, 'down');
    assert.equal(A('totalReviews', 10, 10, (v) => ({ total_reviews: v })).assessment, 'unchanged');
    // direction is NOT "up = green"
    assert.equal(A('notResponded', 30, 20, (v) => ({ not_responded: v })).assessment, 'worsened');
    assert.equal(A('notResponded', 10, 20, (v) => ({ not_responded: v })).assessment, 'improved');
    assert.equal(A('negative', 40, 30, (v) => ({ sentiment: { positive: 0, neutral: 0, negative: v } })).assessment, 'worsened');
    assert.equal(A('positive', 40, 30, (v) => ({ sentiment: { positive: v, neutral: 0, negative: 0 } })).assessment, 'improved');
    assert.equal(A('responseRate', 90, 95, (v) => ({ response_rate: v })).assessment, 'worsened');
    assert.equal(A('withoutText', 200, 150, (v) => ({ without_text: v })).assessment, 'neutral');
    assert.equal(A('neutral', 20, 10, (v) => ({ sentiment: { positive: 0, neutral: v, negative: 0 } })).assessment, 'neutral');
  });
  test('all 15 requested metrics exist', () => {
    assert.deepEqual(COMPARISON_METRICS.map((d) => d.key).sort(), [
      'averageRating', 'fiveStar', 'fourStar', 'negative', 'neutral', 'notResponded', 'oneStar', 'positive',
      'responded', 'responseRate', 'threeStar', 'totalReviews', 'twoStar', 'withText', 'withoutText',
    ]);
  });
});

describe('metric rule versions', () => {
  test('32. identical rules -> everything comparable', () => {
    assert.equal(incomparableMetricKeys(1, 1).size, 0);
  });
  test('33. different rules, change not recorded -> nothing is silently assumed equivalent', () => {
    assert.equal(incomparableMetricKeys(1, 2).size, COMPARISON_METRICS.length);
    assert.equal(incomparableMetricKeys(null, 1).size, COMPARISON_METRICS.length);
  });
  test('33b. a recorded change marks only the affected metrics', () => {
    METRIC_RULE_CHANGES[2] = ['positive', 'neutral', 'negative'];
    try {
      assert.deepEqual([...incomparableMetricKeys(1, 2)].sort(), ['negative', 'neutral', 'positive']);
      assert.deepEqual([...incomparableMetricKeys(2, 1)].sort(), ['negative', 'neutral', 'positive']); // symmetric
      const rows = [...days('2026-10-01', '2026-10-07', {}, { version: 2 }), ...days('2026-09-01', '2026-09-07', {}, { version: 1 })];
      const c = buildComparison({ range: rangeOf('2026-10-01', '2026-10-07', '7d'), rows, snapshotTimezone: 'UTC' }).mom;
      assert.equal(c.status, 'available');
      assert.equal(c.rules.compatible, false);
      assert.equal(c.metrics.positive.status, 'incomparable');
      assert.equal(c.metrics.positive.reason, 'metric_rules_changed');
      assert.ok(!('absoluteChange' in c.metrics.positive));
      assert.equal(c.metrics.totalReviews.status, 'ok');
    } finally {
      delete METRIC_RULE_CHANGES[2];
    }
  });
  test('32b. same version end-to-end reports compatible', () => {
    const rows = [...days('2026-10-01', '2026-10-07'), ...days('2026-09-01', '2026-09-07')];
    const c = buildComparison({ range: rangeOf('2026-10-01', '2026-10-07', '7d'), rows, snapshotTimezone: 'UTC' }).mom;
    assert.deepEqual([c.rules.compatible, c.rules.currentVersion, c.rules.previousVersion, c.rules.affectedMetrics], [true, 1, 1, []]);
  });
});

describe('whole comparison (API payload)', () => {
  const range = rangeOf('2026-10-01', '2026-10-07', '7d');
  const grow = (startKey, endKey, base) => {
    const out = [];
    let i = 0;
    for (let d = startKey; d <= endKey; d = addDays(d, 1), i++) out.push(snap(d, { total_reviews: base + i, with_text: 800 + i }));
    return out;
  };

  test('34. MoM available (100% coverage in both periods): end-of-period states, not sums', () => {
    const rows = [...grow('2026-10-01', '2026-10-07', 1050), ...grow('2026-09-01', '2026-09-07', 1000)];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC', historyStartsOn: '2026-09-01' });
    assert.equal(c.mom.status, 'available');
    assert.deepEqual(c.mom.coverage, { current: 100, previous: 100 });
    const t = c.mom.metrics.totalReviews;
    assert.deepEqual([t.current, t.previous, t.absoluteChange], [1056, 1006, 50]); // last day of each period
    assert.equal(c.mom.currentPeriod.asOfDate, '2026-10-07');
    assert.equal(c.mom.previousPeriod.asOfDate, '2026-09-07');
    assert.equal(Object.keys(c.mom.metrics).length, 15);
  });
  test('35. YoY available', () => {
    const rows = [...grow('2026-10-01', '2026-10-07', 1050), ...grow('2025-10-01', '2025-10-07', 700)];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC' });
    assert.equal(c.yoy.status, 'available');
    assert.equal(c.yoy.previousPeriod.startDate, '2025-10-01');
    assert.equal(c.yoy.metrics.totalReviews.absoluteChange, 350);
    assert.equal(c.mom.status, 'insufficient_history'); // independent of YoY
    assert.equal(c.status, 'available');
  });
  test('36. MoM insufficient history: no numbers are produced, the reason and the spec message are', () => {
    const c = buildComparison({ range, rows: grow('2026-10-01', '2026-10-07', 1050), snapshotTimezone: 'UTC', historyStartsOn: '2026-10-01' });
    assert.equal(c.mom.status, 'insufficient_history');
    assert.ok(!('metrics' in c.mom));
    assert.equal(c.mom.reason, 'no_snapshots');
    assert.deepEqual(c.mom.blockers, [{ period: 'previous', code: 'no_snapshots' }]);
    assert.equal(c.mom.message, 'MoM comparison will be available once both the current and previous comparison periods have snapshot coverage.');
    assert.equal(c.historyStartsOn, '2026-10-01');
    assert.equal(c.status, 'insufficient_history');
  });
  test('37. YoY insufficient history', () => {
    const rows = [...grow('2026-10-01', '2026-10-07', 1050), ...grow('2026-09-01', '2026-09-07', 1000)];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC' });
    assert.equal(c.yoy.status, 'insufficient_history');
    assert.ok(!('metrics' in c.yoy));
    assert.equal(c.yoy.message, 'YoY comparison requires historical snapshots from the comparison period.');
    assert.equal(c.mom.status, 'available');
  });
  test('38. partial coverage: numbers are shown but flagged, with coverage per period', () => {
    const rows = [...days('2026-10-01', '2026-10-07', {}, { skip: ['2026-10-03'] }), ...days('2026-09-01', '2026-09-07')];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC' }).mom;
    assert.equal(c.status, 'partial');
    assert.deepEqual(c.coverage, { current: 85.71, previous: 100 });
    assert.equal(c.currentPeriod.coverage.missingDays, 1);
    assert.ok(c.metrics.totalReviews);
  });
  test('the very first day of history: current has 1 snapshot, previous none -> insufficient (the real situation today)', () => {
    const c = buildComparison({ range, rows: [snap('2026-10-07')], snapshotTimezone: 'UTC', historyStartsOn: '2026-10-07' });
    assert.equal(c.mom.status, 'insufficient_history');
    assert.equal(c.yoy.status, 'insufficient_history');
    assert.equal(c.status, 'insufficient_history');
    assert.deepEqual(c.mom.blockers.map((b) => `${b.period}:${b.code}`).sort(), ['current:low_coverage', 'previous:no_snapshots']);
  });
  test('availability is automatic: more snapshots flip insufficient -> partial -> available with no code change', () => {
    const status = (rows) => buildComparison({ range, rows, snapshotTimezone: 'UTC' }).mom.status;
    const cur = days('2026-10-01', '2026-10-07');
    assert.equal(status([...cur]), 'insufficient_history');
    assert.equal(status([...cur, ...days('2026-09-05', '2026-09-07')]), 'insufficient_history'); // 3/7 = 42.9% < 50%
    assert.equal(status([...cur, ...days('2026-09-04', '2026-09-07')]), 'partial');             // 4/7 = 57.1%
    assert.equal(status([...cur, ...days('2026-09-01', '2026-09-07')]), 'available');
  });
  test('no hard-coded dates: the same logic works for any "today"', () => {
    const r = resolveRange('7d', new Date('2031-03-31T12:00:00Z'), 'UTC'); // month-end clamp
    const rows = [...days(r.startKey, r.endKey), ...days('2031-02-22', '2031-02-28')];
    assert.equal(buildComparison({ range: r, rows, snapshotTimezone: 'UTC' }).mom.status, 'available');
  });
  test('rows from another timezone never make a comparison "available"', () => {
    const rows = [...days('2026-10-01', '2026-10-07', {}, { tz: 'Asia/Kolkata' }), ...days('2026-09-01', '2026-09-07', {}, { tz: 'Asia/Kolkata' })];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC' }).mom;
    assert.equal(c.status, 'insufficient_history');
    assert.equal(c.currentPeriod.coverage.excludedOtherTimezone, 7);
  });
  test('the payload carries the rules it applied and never NaN/Infinity', () => {
    const rows = [...days('2026-10-01', '2026-10-07'), ...days('2026-09-01', '2026-09-07')];
    const c = buildComparison({ range, rows, snapshotTimezone: 'UTC' });
    assert.deepEqual(c.rules, { minCoveragePercent: 50, endToleranceDays: 3, ruleVersion: 1 });
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(c)));
  });
});
