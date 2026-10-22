import { addDays, addMonths, pct, METRIC_RULES_VERSION } from './businessProfileReviewMetrics.js';

/**
 * Month-over-month / year-over-year review comparison - PURE logic (no DB).
 * The service (businessProfileReviewComparisonService.js) fetches the daily
 * snapshot rows; everything below turns them into the comparison.
 *
 * ── Semantics (the single reference; the UI repeats it) ────────────────────
 *  PERIOD    The window the dashboard is showing (7D/30D/90D/6M/12M, ending
 *            today, local days in the snapshot timezone) is the CURRENT period.
 *            MoM's PREVIOUS period is the same window shifted back one calendar
 *            month (month-end days clamp: Mar 31 -> Feb 28); YoY's is shifted
 *            back one calendar year. Because the current window always ends
 *            today, an in-progress month/year is compared with the SAME
 *            elapsed days of the earlier one (on Oct 7, 7D = Oct 1-7 vs
 *            Sep 1-7 / Oct 1-7 2025), never against a full earlier month.
 *            Windows that happen to be a whole calendar month / year are
 *            labelled as such ("October 2026 vs September 2026"); when the
 *            shifted window has a different length (clamping) it is flagged.
 *  VALUES    Snapshots hold STATE (reviews known at that moment), so each
 *            period is represented by its END-OF-PERIOD snapshot - the last
 *            valid snapshot inside the period. Nothing is summed and no daily
 *            averages are averaged: growth = end total - end total.
 *  COVERAGE  expected days = days in the period; actual = days with a valid
 *            snapshot (stored timezone == the comparison timezone). A missing
 *            day is UNKNOWN, never zero and never back-filled.
 *  STATUS    insufficient_history: a period has no snapshot, coverage below
 *              MIN_COVERAGE_PERCENT, or its last snapshot is more than
 *              END_TOLERANCE_DAYS before the period end (stale state);
 *            partial: both usable but some day is missing in either period;
 *            available: 100% coverage in both.
 *  RULES     A snapshot records metric_rules_version. When the two end
 *            snapshots were produced under different rules, only metrics the
 *            rule history marks as changed (or all, when the change is not
 *            recorded) are reported as not comparable.
 */

export const COMPARISON_RULES = {
  minCoveragePercent: 50,
  endToleranceDays: 3,
};

/**
 * Rule-version history: version -> metrics whose DEFINITION changed in that
 * version ('*' = all). Empty today (only v1 exists). When you change a metric
 * rule, bump METRIC_RULES_VERSION and add an entry here; an unrecorded version
 * jump is treated as "everything changed" (the safe default).
 */
export const METRIC_RULE_CHANGES = {};

// ── metric catalogue ────────────────────────────────────────────────────────
// kind: count | rating | rate.  favorable: which direction is good news
// ('none' = no judgement: more reviews with no text is neither good nor bad).

const m = (key, label, kind, favorable, get) => ({ key, label, kind, favorable, get });

export const COMPARISON_METRICS = [
  m('totalReviews', 'Total Reviews', 'count', 'up', (x) => x.total_reviews),
  m('averageRating', 'Average Rating', 'rating', 'up', (x) => x.average_rating),
  m('withText', 'With Text', 'count', 'up', (x) => x.with_text),
  m('withoutText', 'Without Text', 'count', 'none', (x) => x.without_text),
  m('responded', 'Responded', 'count', 'up', (x) => x.responded),
  m('notResponded', 'Not Responded', 'count', 'down', (x) => x.not_responded),
  m('responseRate', 'Response Rate', 'rate', 'up', (x) => x.response_rate),
  m('positive', 'Positive', 'count', 'up', (x) => x.sentiment?.positive),
  m('neutral', 'Neutral', 'count', 'none', (x) => x.sentiment?.neutral),
  m('negative', 'Negative', 'count', 'down', (x) => x.sentiment?.negative),
  m('fiveStar', '5 stars', 'count', 'up', (x) => x.rating_distribution?.five),
  m('fourStar', '4 stars', 'count', 'up', (x) => x.rating_distribution?.four),
  m('threeStar', '3 stars', 'count', 'none', (x) => x.rating_distribution?.three),
  m('twoStar', '2 stars', 'count', 'down', (x) => x.rating_distribution?.two),
  m('oneStar', '1 star', 'count', 'down', (x) => x.rating_distribution?.one),
];

// ── reusable number helpers ─────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Percentage change = (current - previous) / previous x 100, never NaN/Infinity.
 *  previous 0 and current > 0 -> value null, state 'new'
 *  both 0                      -> 0, 'unchanged'
 *  missing input               -> null, 'unavailable'
 */
export function percentageChange(current, previous) {
  if (!isNum(current) || !isNum(previous)) return { value: null, state: 'unavailable' };
  if (previous === 0) return current === 0 ? { value: 0, state: 'unchanged' } : { value: null, state: 'new' };
  const value = round2(((current - previous) / Math.abs(previous)) * 100);
  return { value, state: value === 0 ? 'unchanged' : 'changed' };
}

/** Difference of two percentages, in percentage POINTS (99.62 - 98.70 = 0.92 pp). */
export function percentagePointChange(current, previous) {
  return isNum(current) && isNum(previous) ? round2(current - previous) : null;
}

// ── rule versions ───────────────────────────────────────────────────────────

/** Metric keys that cannot be compared between two rule versions ('all' = every metric). */
export function incomparableMetricKeys(versionA, versionB) {
  if (versionA === versionB) return new Set();
  if (!Number.isInteger(versionA) || !Number.isInteger(versionB)) return new Set(COMPARISON_METRICS.map((x) => x.key));
  const [low, high] = [Math.min(versionA, versionB), Math.max(versionA, versionB)];
  const out = new Set();
  for (let v = low + 1; v <= high; v++) {
    const change = METRIC_RULE_CHANGES[v];
    if (change === undefined || change === '*') return new Set(COMPARISON_METRICS.map((x) => x.key));
    change.forEach((k) => out.add(k));
  }
  return out;
}

// ── one metric ──────────────────────────────────────────────────────────────

const trendOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

function assess(trend, favorable) {
  if (trend === 'flat') return 'unchanged';
  if (favorable === 'none') return 'neutral';
  return trend === favorable ? 'improved' : 'worsened';
}

export function compareMetric(def, currentMetrics, previousMetrics, incomparable = new Set()) {
  const current = isNum(def.get(currentMetrics)) ? def.get(currentMetrics) : null;
  const previous = isNum(def.get(previousMetrics)) ? def.get(previousMetrics) : null;
  const base = { key: def.key, label: def.label, kind: def.kind, current, previous };

  if (incomparable.has(def.key)) return { ...base, status: 'incomparable', reason: 'metric_rules_changed' };
  if (current === null || previous === null) return { ...base, status: 'unknown' }; // e.g. no reviews -> no average

  if (def.kind === 'rate') {
    const pp = percentagePointChange(current, previous);
    const trend = trendOf(pp);
    return { ...base, status: 'ok', percentagePointChange: pp, trend, assessment: assess(trend, def.favorable) };
  }
  const absoluteChange = round2(current - previous);
  const pc = percentageChange(current, previous);
  const trend = trendOf(absoluteChange);
  return {
    ...base, status: 'ok',
    absoluteChange, percentageChange: pc.value, percentageChangeState: pc.state,
    trend, assessment: assess(trend, def.favorable),
  };
}

// ── periods + coverage ──────────────────────────────────────────────────────

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const inclusiveDays = (startKey, endKey) => daysBetween(startKey, endKey) + 1;
const lastDayOfMonth = (key) => addDays(addMonths(`${key.slice(0, 7)}-01`, 1), -1);

/** 'calendar_month' | 'calendar_year' when the window is exactly one, else 'range'. */
export function periodKind(startKey, endKey) {
  if (startKey.endsWith('-01') && startKey.slice(0, 7) === endKey.slice(0, 7) && endKey === lastDayOfMonth(endKey)) return 'calendar_month';
  if (startKey.endsWith('-01-01') && endKey === `${startKey.slice(0, 4)}-12-31`) return 'calendar_year';
  return 'range';
}

/** Current window + the two shifted windows, from the dashboard range (see header). */
export function comparisonWindows(range) {
  const shift = (months) => ({ startKey: addMonths(range.startKey, -months), endKey: addMonths(range.endKey, -months) });
  return {
    current: { startKey: range.startKey, endKey: range.endKey },
    mom: shift(1),
    yoy: shift(12),
  };
}

/**
 * Coverage + end-of-period snapshot of ONE period.
 * @param {{startKey:string,endKey:string}} window
 * @param {Array} rows   snapshot rows (any period); only valid ones inside the window count
 * @param {string} timezone  the zone the comparison is cut in; rows stored in another zone are excluded
 */
export function analyzePeriod(window, rows, timezone, rules = COMPARISON_RULES) {
  const inWindow = rows.filter((r) => r.snapshot_date >= window.startKey && r.snapshot_date <= window.endKey);
  const valid = inWindow.filter((r) => r.timezone === timezone);
  const dates = [...new Set(valid.map((r) => r.snapshot_date))].sort();
  const expectedDays = inclusiveDays(window.startKey, window.endKey);
  const percent = pct(dates.length, expectedDays);
  const lastDate = dates.length ? dates[dates.length - 1] : null;
  const endGapDays = lastDate ? daysBetween(lastDate, window.endKey) : null;
  const endSnapshot = lastDate ? valid.find((r) => r.snapshot_date === lastDate) : null;

  let quality;
  if (dates.length === 0) quality = 'none';
  else if (percent < rules.minCoveragePercent || endGapDays > rules.endToleranceDays) quality = 'insufficient';
  else quality = dates.length === expectedDays ? 'full' : 'partial';

  return {
    period: {
      startDate: window.startKey,
      endDate: window.endKey,
      lengthDays: expectedDays,
      kind: periodKind(window.startKey, window.endKey),
      asOfDate: lastDate, // the date of the state the numbers describe
      quality,
      coverage: {
        expectedDays,
        snapshotDays: dates.length,
        percent,
        firstSnapshotDate: dates[0] || null,
        lastSnapshotDate: lastDate,
        missingDays: expectedDays - dates.length, // unknown - NOT zero
        hasStartSnapshot: dates[0] === window.startKey,
        hasEndSnapshot: lastDate === window.endKey,
        endGapDays,
        excludedOtherTimezone: inWindow.length - valid.length,
      },
    },
    endSnapshot,
  };
}

// ── whole comparison ────────────────────────────────────────────────────────

const MESSAGES = {
  mom: 'MoM comparison will be available once both the current and previous comparison periods have snapshot coverage.',
  yoy: 'YoY comparison requires historical snapshots from the comparison period.',
};

function blockers(cur, prev, rules) {
  const out = [];
  for (const [which, p] of [['current', cur], ['previous', prev]]) {
    if (p.period.quality === 'none') out.push({ period: which, code: 'no_snapshots' });
    else if (p.period.quality === 'insufficient') {
      if (p.period.coverage.percent < rules.minCoveragePercent) out.push({ period: which, code: 'low_coverage' });
      if (p.period.coverage.endGapDays > rules.endToleranceDays) out.push({ period: which, code: 'stale_end_snapshot' });
    }
  }
  return out;
}

function compareOne(kind, cur, prev, rules) {
  const base = { currentPeriod: cur.period, previousPeriod: prev.period, equalLength: cur.period.lengthDays === prev.period.lengthDays };
  const found = blockers(cur, prev, rules);
  if (found.length) return { status: 'insufficient_history', reason: found[0].code, blockers: found, message: MESSAGES[kind], ...base };

  const vCur = cur.endSnapshot.metric_rules_version;
  const vPrev = prev.endSnapshot.metric_rules_version;
  const incomparable = incomparableMetricKeys(vCur, vPrev);
  const metrics = {};
  for (const def of COMPARISON_METRICS) metrics[def.key] = compareMetric(def, cur.endSnapshot.metrics || {}, prev.endSnapshot.metrics || {}, incomparable);

  const partial = cur.period.quality === 'partial' || prev.period.quality === 'partial';
  return {
    status: partial ? 'partial' : 'available',
    ...base,
    coverage: { current: cur.period.coverage.percent, previous: prev.period.coverage.percent },
    rules: { currentVersion: vCur ?? null, previousVersion: vPrev ?? null, compatible: incomparable.size === 0, affectedMetrics: [...incomparable] },
    metrics,
  };
}

/**
 * @param {object} p
 * @param {object} p.range       resolveRange(rangeKey, now, snapshotTimezone)
 * @param {Array}  p.rows        snapshot rows covering the three windows
 * @param {string} p.snapshotTimezone
 * @param {string|null} p.historyStartsOn  earliest snapshot date ever recorded for the location
 */
export function buildComparison({ range, rows, snapshotTimezone, historyStartsOn = null, rules = COMPARISON_RULES }) {
  const w = comparisonWindows(range);
  const cur = analyzePeriod(w.current, rows, snapshotTimezone, rules);
  const mom = compareOne('mom', cur, analyzePeriod(w.mom, rows, snapshotTimezone, rules), rules);
  const yoy = compareOne('yoy', cur, analyzePeriod(w.yoy, rows, snapshotTimezone, rules), rules);
  const rank = { available: 2, partial: 1, insufficient_history: 0 };
  const status = [mom.status, yoy.status].sort((a, b) => rank[b] - rank[a])[0];

  return {
    status,
    rangeKey: range.key,
    timezone: snapshotTimezone,
    historyStartsOn,
    rules: { ...rules, ruleVersion: METRIC_RULES_VERSION },
    mom,
    yoy,
  };
}

export default { buildComparison, comparisonWindows, analyzePeriod, compareMetric, percentageChange, percentagePointChange };
