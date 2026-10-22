import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import { getReviewComparison } from './businessProfileReviewComparisonService.js';
import { addDays, pct } from './businessProfileReviewMetrics.js';

/**
 * MoM / YoY against a REAL MongoDB: the real model, the real unique index and the
 * real range query. Runs in a THROWAWAY database (random name, dropped afterwards)
 * - the application's own collections are never touched. The seeded rows are test
 * fixtures that exist only inside that temporary database. Skipped when MongoDB
 * is unreachable.
 */

const DB_NAME = `odito_comparison_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date('2026-10-07T06:00:00Z');
const HISTORY_START = '2024-06-01';
const oid = () => new mongoose.Types.ObjectId();
const USER = oid();
const A = oid();
const B = oid();
let available = false;

const index = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${HISTORY_START}T00:00:00Z`)) / 86400000);
/** deterministic state for a given day, so expectations are computed independently of the service */
const stateFor = (date, offset = 0) => {
  const i = index(date);
  const total = 900 + i + offset;
  const responded = total - 5;
  return {
    total_reviews: total,
    average_rating: Math.round((4.5 + i / 2000) * 100) / 100,
    rating_distribution: { one: 10, two: 5, three: 10, four: 40 + Math.floor(i / 10), five: total - 65 - Math.floor(i / 10) },
    with_text: Math.floor(total * 0.85),
    without_text: total - Math.floor(total * 0.85),
    responded, not_responded: 5, response_rate: pct(responded, total),
    sentiment: { positive: total - 30, neutral: 10, negative: 20 },
  };
};
const row = (project, loc, date, offset = 0, tz = 'UTC') => ({
  user_id: USER, project_id: project, business_location_id: loc, snapshot_date: date, timezone: tz,
  period_start: new Date(`${date}T00:00:00Z`), period_end: new Date(`${date}T23:59:59Z`),
  captured_at: new Date(`${date}T01:00:00Z`), first_captured_at: new Date(`${date}T01:00:00Z`),
  metrics: stateFor(date, offset), metric_rules_version: 1, source: 'gbp_reviews',
});
const allDays = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: DB_NAME, serverSelectionTimeoutMS: 2000 });
    available = true;
  } catch {
    return;
  }
  await BusinessProfileReviewSnapshot.init();
  const dates = allDays(HISTORY_START, '2026-10-07');
  await BusinessProfileReviewSnapshot.insertMany([
    ...dates.map((d) => row(A, 'L1', d)),
    ...dates.map((d) => row(A, 'L2', d, 5000)),                    // other location, same project
    ...dates.map((d) => row(B, 'L1', d, 9000)),                    // other project, same location id
    row(oid(), 'L1', '2026-10-07'),                                // a brand-new project: only today's snapshot
  ]);
});

after(async () => {
  if (available) {
    await mongoose.connection.dropDatabase(); // only the throwaway DB created above
    await mongoose.disconnect();
  }
});

const run = (name, fn) => test(name, async (t) => {
  if (!available) return t.skip('MongoDB not reachable');
  await fn(t);
});
const compare = (rangeKey, over = {}) => getReviewComparison({ projectId: A, locationId: 'L1', rangeKey, snapshotTimezone: 'UTC', now: NOW, ...over });

describe('MoM / YoY against a real MongoDB', () => {
  run('all five ranges: MoM and YoY are available and EXACTLY the end-of-period states (independent formula)', async () => {
    const ends = { mom: '2026-09-07', yoy: '2025-10-07' };
    for (const key of ['7d', '30d', '90d', '6m', '12m']) {
      const c = await compare(key);
      for (const kind of ['mom', 'yoy']) {
        const part = c[kind];
        assert.equal(part.status, 'available', `${key} ${kind}`);
        const cur = stateFor('2026-10-07');
        const prev = stateFor(ends[kind]);
        const t = part.metrics.totalReviews;
        assert.deepEqual([t.current, t.previous, t.absoluteChange], [cur.total_reviews, prev.total_reviews, cur.total_reviews - prev.total_reviews]);
        const r = part.metrics.averageRating;
        assert.deepEqual([r.current, r.previous], [cur.average_rating, prev.average_rating]);
        assert.equal(part.metrics.responseRate.percentagePointChange, Math.round((cur.response_rate - prev.response_rate) * 100) / 100);
        assert.equal(part.metrics.fiveStar.current, cur.rating_distribution.five);
        assert.equal(part.metrics.positive.previous, prev.sentiment.positive);
        assert.equal(part.currentPeriod.coverage.percent, 100);
        assert.equal(part.previousPeriod.asOfDate, ends[kind]);
      }
    }
  });

  run('totals are state differences, never sums of daily totals', async () => {
    const c = await compare('30d');
    // 30 daily rows each ~1,700 would sum to ~50,000; the answer must be ONE state minus ONE state
    assert.ok(c.mom.metrics.totalReviews.current < 5000);
    assert.equal(c.mom.metrics.totalReviews.absoluteChange, index('2026-10-07') - index('2026-09-07'));
  });

  run('the range query is served by the real index (no collection scan) and returns only the three windows', async () => {
    const w = { cur: ['2026-10-01', '2026-10-07'], mom: ['2026-09-01', '2026-09-07'], yoy: ['2025-10-01', '2025-10-07'] };
    const between = ([a, b]) => ({ snapshot_date: { $gte: a, $lte: b } });
    const plan = await BusinessProfileReviewSnapshot
      .find({ project_id: A, business_location_id: 'L1', $or: [between(w.cur), between(w.mom), between(w.yoy)] })
      .select('snapshot_date timezone metric_rules_version metrics').sort({ snapshot_date: 1 })
      .explain('executionStats');
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    assert.ok(text.includes('unique_project_location_day'), 'uses the existing unique index');
    assert.ok(!text.includes('COLLSCAN'));
    assert.equal(plan.executionStats.nReturned, 21);
    assert.ok(plan.executionStats.totalDocsExamined <= 21 + 3, `examined ${plan.executionStats.totalDocsExamined}`);
  });

  run('a missing middle day in the current period -> partial with exact coverage; the missing day is not treated as zero', async () => {
    await BusinessProfileReviewSnapshot.deleteOne({ project_id: A, business_location_id: 'L1', snapshot_date: '2026-10-04' });
    const c = await compare('7d');
    assert.equal(c.mom.status, 'partial');
    assert.equal(c.mom.coverage.current, 85.71);
    assert.equal(c.mom.currentPeriod.coverage.missingDays, 1);
    assert.equal(c.mom.metrics.totalReviews.current, stateFor('2026-10-07').total_reviews); // end state unaffected
    await BusinessProfileReviewSnapshot.create(row(A, 'L1', '2026-10-04')); // restore the fixture
  });

  run('no snapshots in the previous month -> MoM insufficient (YoY unaffected); numbers return automatically once they exist', async () => {
    const removed = await BusinessProfileReviewSnapshot.find({ project_id: A, business_location_id: 'L1', snapshot_date: { $gte: '2026-09-01', $lte: '2026-09-30' } }).lean();
    await BusinessProfileReviewSnapshot.deleteMany({ project_id: A, business_location_id: 'L1', snapshot_date: { $gte: '2026-09-01', $lte: '2026-09-30' } });
    const missing = await compare('7d');
    assert.equal(missing.mom.status, 'insufficient_history');
    assert.ok(!('metrics' in missing.mom));
    assert.equal(missing.yoy.status, 'available');
    assert.equal(missing.status, 'available');
    await BusinessProfileReviewSnapshot.insertMany(removed.map(({ _id, ...r }) => r)); // snapshots "accumulate"
    assert.equal((await compare('7d')).mom.status, 'available');
  });

  run('a brand-new project with only today\'s snapshot (the real situation today): insufficient, history start reported', async () => {
    const only = await BusinessProfileReviewSnapshot.findOne({ snapshot_date: '2026-10-07', project_id: { $nin: [A, B] } }).lean();
    const c = await getReviewComparison({ projectId: only.project_id, locationId: 'L1', rangeKey: '7d', snapshotTimezone: 'UTC', now: NOW });
    assert.equal(c.status, 'insufficient_history');
    assert.equal(c.historyStartsOn, '2026-10-07');
    assert.equal(c.mom.currentPeriod.coverage.snapshotDays, 1);
    assert.equal(c.mom.previousPeriod.coverage.snapshotDays, 0);
  });

  run('project and location isolation: each (project, location) sees only its own history', async () => {
    const a1 = await compare('7d');
    const a2 = await compare('7d', { locationId: 'L2' });
    const b1 = await compare('7d', { projectId: B });
    assert.equal(a1.mom.metrics.totalReviews.current, stateFor('2026-10-07').total_reviews);
    assert.equal(a2.mom.metrics.totalReviews.current, stateFor('2026-10-07', 5000).total_reviews);
    assert.equal(b1.mom.metrics.totalReviews.current, stateFor('2026-10-07', 9000).total_reviews);
    const none = await compare('7d', { locationId: 'NOPE' });
    assert.equal(none.status, 'insufficient_history');
    assert.equal(none.historyStartsOn, null);
  });

  run('timezone: comparing in a zone the snapshots were not written in finds no usable snapshots', async () => {
    const c = await compare('7d', { snapshotTimezone: 'Asia/Kolkata' });
    assert.equal(c.mom.status, 'insufficient_history');
    assert.equal(c.mom.currentPeriod.coverage.snapshotDays, 0);
    assert.ok(c.mom.currentPeriod.coverage.excludedOtherTimezone > 0);
  });

  run('historyStartsOn is the earliest snapshot date ever recorded', async () => {
    assert.equal((await compare('7d')).historyStartsOn, HISTORY_START);
  });
});
