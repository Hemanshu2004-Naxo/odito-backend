import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import SeoProject from '../modules/app_user/model/SeoProject.js';
import User from '../modules/user/model/User.js';
import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../modules/app_user/model/BusinessProfileMetadata.js';
import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import { EMPTY_ROW, summarizeRow, buildAnalytics, resolveRange, METRIC_RULES_VERSION } from './businessProfileReviewMetrics.js';
import {
  captureReviewSnapshot, buildSnapshotFields, snapshotWindow, resolveSnapshotTimezone,
} from './businessProfileReviewSnapshotService.js';
import { runOnce } from './businessProfileReviewSnapshotScheduler.js';
import { snapshotBusinessProfileReviewsController } from '../modules/app_user/controller/businessProfileController.js';

/**
 * Historical review snapshots - logic tests with the models mocked: NO database
 * and NO Google call. (The real aggregation + unique index are exercised by
 * businessProfileReviewSnapshot.db.test.js and the real-data validation.)
 */

const NOW = new Date('2026-10-06T20:00:00Z'); // 2026-10-07 01:30 in Asia/Kolkata
const P1 = '6ac4bf78867ae9b647ec8478';
const P2 = '6aa3a38adb695a5c7765ca61';
const row = (over = {}) => ({ ...EMPTY_ROW, ...over });

let ctx;
const chain = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

function install({ rows = {}, metadata = { total_review_count: 1053, average_rating: 4.9, reviews_last_synced_at: new Date('2026-10-06') } } = {}) {
  ctx = {
    aggregateCalls: [], upserts: [], connectionWrites: 0, existingSnapshots: [],
    aggregateImpl: async (pipeline) => {
      const pid = String(pipeline[0].$match.project_id);
      const r = rows[pid] ?? { current: [row()], softDeleted: [] };
      return [r];
    },
    upsertImpl: null,
  };
  mock.method(BusinessProfileReview, 'aggregate', async (pipeline) => { ctx.aggregateCalls.push(pipeline); return ctx.aggregateImpl(pipeline); });
  mock.method(BusinessProfileMetadata, 'findOne', () => chain(metadata));
  mock.method(BusinessProfileReviewSnapshot, 'findOneAndUpdate', (filter, update, options) => {
    ctx.upserts.push({ filter, update, options });
    return { lean: async () => {
      if (ctx.upsertImpl) return ctx.upsertImpl(filter, update, ctx.upserts.length);
      return { ...update.$set, ...filter, first_captured_at: update.$setOnInsert.first_captured_at };
    } };
  });
  mock.method(BusinessProfileReviewSnapshot, 'find', () => chain(ctx.existingSnapshots));
  for (const m of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'save']) {
    if (typeof GoogleConnection[m] === 'function') mock.method(GoogleConnection, m, async () => { ctx.connectionWrites++; });
  }
}
beforeEach(() => install());
afterEach(() => mock.restoreAll());

const mixedRow = row({ total: 10, ratingSum: 41, r5: 6, r4: 2, r3: 1, r2: 0, r1: 1, withText: 7, responded: 8, positive: 8, neutral: 1, negative: 1, storedSentiment: 0 });

describe('snapshot day semantics (timezone)', () => {
  test('IST evening is already the NEXT calendar day; UTC is not', () => {
    assert.equal(snapshotWindow(NOW, 'Asia/Kolkata').snapshotDate, '2026-10-07');
    assert.equal(snapshotWindow(NOW, 'UTC').snapshotDate, '2026-10-06');
  });
  test('period boundaries are local midnights expressed as UTC instants', () => {
    const w = snapshotWindow(NOW, 'Asia/Kolkata');
    assert.equal(w.periodStart.toISOString(), '2026-10-06T18:30:00.000Z');
    assert.equal(w.periodEnd.toISOString(), '2026-10-07T18:30:00.000Z');
    assert.ok(w.periodStart <= NOW && NOW < w.periodEnd);
  });
  test('right on the boundary: 18:29:59Z is still Oct 6 in IST, 18:30:00Z is Oct 7', () => {
    assert.equal(snapshotWindow(new Date('2026-10-06T18:29:59Z'), 'Asia/Kolkata').snapshotDate, '2026-10-06');
    assert.equal(snapshotWindow(new Date('2026-10-06T18:30:00Z'), 'Asia/Kolkata').snapshotDate, '2026-10-07');
  });
  test('DST change days are 25h / 23h long, not a fixed 24h', () => {
    const fall = snapshotWindow(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    assert.equal((fall.periodEnd - fall.periodStart) / 36e5, 25);
    const spring = snapshotWindow(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
    assert.equal((spring.periodEnd - spring.periodStart) / 36e5, 23);
  });
  test('deterministic: same instant + zone -> same window', () => {
    assert.deepEqual(snapshotWindow(NOW, 'Asia/Kolkata'), snapshotWindow(new Date(NOW), 'Asia/Kolkata'));
  });
  test('timezone resolution: owner zone -> env default -> UTC', () => {
    assert.equal(resolveSnapshotTimezone('Asia/Kolkata', 'Europe/Paris'), 'Asia/Kolkata');
    assert.equal(resolveSnapshotTimezone(null, 'Europe/Paris'), 'Europe/Paris');
    assert.equal(resolveSnapshotTimezone('Not/AZone', undefined), 'UTC');
    assert.equal(resolveSnapshotTimezone(undefined, 'also-bad'), 'UTC');
  });
});

describe('snapshot metrics = the live dashboard metrics (single source of truth)', () => {
  test('buildSnapshotFields maps summarizeRow exactly', () => {
    const f = buildSnapshotFields({ rows: { current: mixedRow, softDeleted: 2 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    assert.equal(f.metrics.total_reviews, 10);
    assert.equal(f.metrics.average_rating, 4.1);
    assert.deepEqual(f.metrics.rating_distribution, { one: 1, two: 0, three: 1, four: 2, five: 6 });
    assert.equal(f.metrics.with_text, 7);
    assert.equal(f.metrics.without_text, 3);
    assert.equal(f.metrics.responded, 8);
    assert.equal(f.metrics.not_responded, 2);
    assert.equal(f.metrics.response_rate, 80);
    assert.deepEqual(f.metrics.sentiment, { positive: 8, neutral: 1, negative: 1 });
    assert.equal(f.metrics.soft_deleted_reviews, 2);
    assert.equal(f.metric_rules_version, METRIC_RULES_VERSION);
    assert.equal(f.source, 'gbp_reviews');
  });
  test('parity: summarizeRow agrees with buildAnalytics (lifetime) for varied datasets', () => {
    const datasets = [row(), row({ total: 1, ratingSum: 5, r5: 1, positive: 1 }), mixedRow,
      row({ total: 4, ratingSum: 4, r1: 4, negative: 4, withText: 4 }), row({ total: 3, ratingSum: 15, r5: 3, positive: 3, responded: 3 })];
    for (const r of datasets) {
      const s = summarizeRow(r);
      const a = buildAnalytics({ range: resolveRange('7d', NOW, 'UTC'), lifetime: r, daily: [], recent: {}, google: {}, now: NOW });
      assert.equal(s.totalReviews, a.overview.lifetime.totalReviews);
      assert.equal(s.averageRating, a.overview.lifetime.averageRating);
      assert.equal(s.withText, a.overview.lifetime.withText);
      assert.equal(s.withoutText, a.overview.lifetime.withoutText);
      assert.equal(s.responded, a.response.lifetime.responded);
      assert.equal(s.notResponded, a.response.lifetime.notResponded);
      assert.equal(s.responseRate, a.response.lifetime.responseRate);
      assert.equal(s.sentiment.positive, a.sentiment.lifetime.positive);
      assert.equal(s.sentiment.neutral, a.sentiment.lifetime.neutral);
      assert.equal(s.sentiment.negative, a.sentiment.lifetime.negative);
      assert.deepEqual(Object.values(s.ratingDistribution), [r.r1, r.r2, r.r3, r.r4, r.r5]);
    }
  });
  test('0 reviews: zeros, null average, no NaN', () => {
    const f = buildSnapshotFields({ rows: { current: undefined, softDeleted: 0 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    assert.equal(f.metrics.total_reviews, 0);
    assert.equal(f.metrics.average_rating, null);
    assert.equal(f.metrics.response_rate, 0);
    assert.ok(!JSON.stringify(f).includes('NaN'));
  });
  test('1 review', () => {
    const f = buildSnapshotFields({ rows: { current: row({ total: 1, ratingSum: 4, r4: 1, withText: 1, positive: 1 }), softDeleted: 0 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    assert.equal(f.metrics.average_rating, 4);
    assert.equal(f.metrics.responded, 0);
    assert.equal(f.metrics.not_responded, 1);
  });
  test('all 5-star / none responded / all responded', () => {
    const five = buildSnapshotFields({ rows: { current: row({ total: 5, ratingSum: 25, r5: 5, positive: 5, responded: 5, withText: 5 }), softDeleted: 0 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    assert.equal(five.metrics.average_rating, 5);
    assert.deepEqual(five.metrics.rating_distribution, { one: 0, two: 0, three: 0, four: 0, five: 5 });
    assert.equal(five.metrics.response_rate, 100);
    assert.equal(five.metrics.not_responded, 0);
    const none = buildSnapshotFields({ rows: { current: row({ total: 5, ratingSum: 25, r5: 5, positive: 5 }), softDeleted: 0 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    assert.equal(none.metrics.responded, 0);
    assert.equal(none.metrics.response_rate, 0);
    assert.equal(none.metrics.without_text, 5);
  });
  test("Google's reported count is carried separately (the 1,052 vs 1,053 gap stays visible)", () => {
    const f = buildSnapshotFields({
      rows: { current: row({ total: 1052 }), softDeleted: 0 },
      metadata: { total_review_count: 1053, average_rating: 4.9, reviews_last_synced_at: new Date('2026-10-06') },
      window: snapshotWindow(NOW, 'UTC'), now: NOW,
    });
    assert.equal(f.metrics.total_reviews, 1052);
    assert.equal(f.google.reported_review_count, 1053);
  });
});

describe('captureReviewSnapshot', () => {
  test('ONE aggregation + ONE upsert, keyed by project + location + local day', async () => {
    const { snapshot, created } = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', connectionId: 'c1', accountId: 'A1', timezone: 'Asia/Kolkata', now: NOW });
    assert.equal(ctx.aggregateCalls.length, 1);
    assert.equal(ctx.upserts.length, 1);
    assert.deepEqual(ctx.upserts[0].filter, { project_id: P1, business_location_id: 'L1', snapshot_date: '2026-10-07' });
    assert.equal(ctx.upserts[0].options.upsert, true);
    assert.equal(snapshot.timezone, 'Asia/Kolkata');
    assert.equal(created, true);
  });
  test('the aggregation is a single $facet scoped to project AND location (no per-review work)', async () => {
    await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    const [match, facet] = ctx.aggregateCalls[0];
    assert.equal(String(match.$match.project_id), P1);
    assert.equal(match.$match.business_location_id, 'L1');
    assert.deepEqual(Object.keys(facet.$facet).sort(), ['current', 'softDeleted']);
  });
  test('first capture sets first_captured_at once ($setOnInsert); a re-run reports created=false', async () => {
    const first = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    assert.equal(first.created, true);
    assert.deepEqual(ctx.upserts[0].update.$setOnInsert, { first_captured_at: NOW });
    assert.ok(!('first_captured_at' in ctx.upserts[0].update.$set));
    // second run later the same day: Mongo keeps the ORIGINAL first_captured_at
    ctx.upsertImpl = (filter, update) => ({ ...update.$set, ...filter, first_captured_at: NOW });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const again = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: later });
    assert.equal(again.created, false);
    assert.equal(ctx.upserts[1].update.$set.captured_at.getTime(), later.getTime());
    assert.deepEqual(ctx.upserts[1].filter, ctx.upserts[0].filter, 'same key -> updates the same row');
  });
  test('duplicate execution never builds a second key', async () => {
    await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: new Date(NOW.getTime() + 5000) });
    assert.equal(new Set(ctx.upserts.map((u) => JSON.stringify(u.filter))).size, 1);
  });
  test('a concurrent writer winning the unique index (E11000) is retried as a plain update', async () => {
    ctx.upsertImpl = (filter, update, n) => {
      if (n === 1) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      return { ...update.$set, ...filter, first_captured_at: new Date(0) };
    };
    const res = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    assert.equal(ctx.upserts.length, 2);
    assert.equal(res.created, false);
  });
  test('other write errors are not swallowed', async () => {
    ctx.upsertImpl = () => { throw new Error('disk full'); };
    await assert.rejects(captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW }), /disk full/);
    assert.equal(ctx.upserts.length, 1, 'no blind retry for non-duplicate errors');
  });
  test('failed aggregation: nothing is written, connection untouched', async () => {
    ctx.aggregateImpl = async () => { throw new Error('mongo down'); };
    await assert.rejects(captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW }), /mongo down/);
    assert.equal(ctx.upserts.length, 0);
    assert.equal(ctx.connectionWrites, 0);
  });
  test('retry after a failure succeeds and writes exactly one row', async () => {
    let fail = true;
    ctx.aggregateImpl = async () => { if (fail) throw new Error('boom'); return [{ current: [mixedRow], softDeleted: [] }]; };
    await assert.rejects(captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW }));
    fail = false;
    const res = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    assert.equal(ctx.upserts.length, 1);
    assert.equal(res.snapshot.metrics.total_reviews, 10);
  });
  test('project and location isolation: each (project, location) gets its own key and its own data', async () => {
    install({ rows: { [P1]: { current: [mixedRow], softDeleted: [] }, [P2]: { current: [row({ total: 3, ratingSum: 15, r5: 3, positive: 3 })], softDeleted: [] } } });
    const a = await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    const b = await captureReviewSnapshot({ projectId: P2, locationId: 'L1', userId: 'u2', timezone: 'UTC', now: NOW });
    const c = await captureReviewSnapshot({ projectId: P1, locationId: 'L2', userId: 'u1', timezone: 'UTC', now: NOW });
    assert.equal(a.snapshot.metrics.total_reviews, 10);
    assert.equal(b.snapshot.metrics.total_reviews, 3);
    assert.equal(new Set(ctx.upserts.map((u) => JSON.stringify(u.filter))).size, 3);
    assert.equal(ctx.aggregateCalls[2][0].$match.business_location_id, 'L2');
    assert.ok(c);
  });
  test('never touches GoogleConnection', async () => {
    await captureReviewSnapshot({ projectId: P1, locationId: 'L1', userId: 'u1', timezone: 'UTC', now: NOW });
    assert.equal(ctx.connectionWrites, 0);
  });
  test('the stored document passes the model validation (incl. null average)', async () => {
    const f = buildSnapshotFields({ rows: { current: undefined, softDeleted: 0 }, metadata: null, window: snapshotWindow(NOW, 'UTC'), now: NOW });
    const doc = new BusinessProfileReviewSnapshot({
      user_id: new (await import('mongoose')).default.Types.ObjectId(), project_id: new (await import('mongoose')).default.Types.ObjectId(),
      business_location_id: 'L1', snapshot_date: '2026-10-06', first_captured_at: NOW, ...f,
    });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(new BusinessProfileReviewSnapshot({ snapshot_date: '06-10-2026' }).validateSync().errors.snapshot_date.name, 'ValidatorError');
  });
});

describe('model indexes', () => {
  test('unique (project, location, day) index exists; no redundant extras', () => {
    const idx = BusinessProfileReviewSnapshot.schema.indexes();
    const unique = idx.find(([, o]) => o.unique);
    assert.deepEqual(unique[0], { project_id: 1, business_location_id: 1, snapshot_date: 1 });
    assert.equal(unique[1].name, 'unique_project_location_day');
    assert.equal(idx.length, 1);
  });
});

describe('scheduler', () => {
  const conn = (project, loc = 'L1') => ({ _id: `c-${project}`, project_id: project, business_account_id: 'A1', business_location_id: loc });
  function world({ connections, projects, users, existing = [] }) {
    mock.method(GoogleConnection, 'find', (filter) => { ctx.connectionFilter = filter; return chain(connections); });
    mock.method(SeoProject, 'find', () => chain(projects));
    mock.method(User, 'find', () => chain(users));
    ctx.existingSnapshots = existing;
  }

  test('snapshots each connected location once; connection query has NO status filter (expired still has stored reviews)', async () => {
    world({ connections: [conn(P1), conn(P2)], projects: [{ _id: P1, user_id: 'u1' }, { _id: P2, user_id: 'u2' }], users: [{ _id: 'u1', timezone: 'UTC' }, { _id: 'u2', timezone: 'UTC' }] });
    const s = await runOnce({ now: NOW });
    assert.deepEqual([s.considered, s.captured, s.skipped, s.failed], [2, 2, 0, 0]);
    assert.equal(ctx.upserts.length, 2);
    assert.ok(!('status' in ctx.connectionFilter));
    assert.equal(ctx.connectionFilter.purpose, 'business_profile');
    assert.equal(ctx.connectionWrites, 0);
  });
  test("each owner's own timezone decides the day", async () => {
    world({ connections: [conn(P1), conn(P2)], projects: [{ _id: P1, user_id: 'u1' }, { _id: P2, user_id: 'u2' }], users: [{ _id: 'u1', timezone: 'Asia/Kolkata' }, { _id: 'u2', timezone: null }] });
    await runOnce({ now: NOW });
    const byProject = Object.fromEntries(ctx.upserts.map((u) => [String(u.filter.project_id), u.filter.snapshot_date]));
    assert.equal(byProject[P1], '2026-10-07'); // IST
    assert.equal(byProject[P2], '2026-10-06'); // no zone -> UTC
  });
  test('already snapshotted today -> skipped (a second tick / restart / second worker is a no-op)', async () => {
    world({
      connections: [conn(P1), conn(P2)], projects: [{ _id: P1, user_id: 'u1' }, { _id: P2, user_id: 'u2' }],
      users: [{ _id: 'u1', timezone: 'UTC' }, { _id: 'u2', timezone: 'UTC' }],
      existing: [{ project_id: P1, business_location_id: 'L1', snapshot_date: '2026-10-06' }],
    });
    const s = await runOnce({ now: NOW });
    assert.deepEqual([s.captured, s.skipped], [1, 1]);
    assert.equal(String(ctx.upserts[0].filter.project_id), P2);
  });
  test('a late tick (hours after midnight) still creates the missing day', async () => {
    world({ connections: [conn(P1)], projects: [{ _id: P1, user_id: 'u1' }], users: [{ _id: 'u1', timezone: 'Asia/Kolkata' }] });
    const s = await runOnce({ now: new Date('2026-10-07T09:10:00Z') }); // 14:40 IST Oct 7
    assert.equal(s.captured, 1);
    assert.equal(ctx.upserts[0].filter.snapshot_date, '2026-10-07');
  });
  test('trashed (deleted) projects are skipped', async () => {
    world({ connections: [conn(P1), conn(P2)], projects: [{ _id: P2, user_id: 'u2' }], users: [{ _id: 'u2', timezone: 'UTC' }] });
    const s = await runOnce({ now: NOW });
    assert.equal(s.captured, 1);
    assert.equal(String(ctx.upserts[0].filter.project_id), P2);
  });
  test('one location failing never aborts the others; the next tick retries it; connections never touched', async () => {
    world({ connections: [conn(P1), conn(P2)], projects: [{ _id: P1, user_id: 'u1' }, { _id: P2, user_id: 'u2' }], users: [{ _id: 'u1', timezone: 'UTC' }, { _id: 'u2', timezone: 'UTC' }] });
    ctx.aggregateImpl = async (pipeline) => {
      if (String(pipeline[0].$match.project_id) === P1) throw new Error('boom');
      return [{ current: [mixedRow], softDeleted: [] }];
    };
    const first = await runOnce({ now: NOW });
    assert.deepEqual([first.captured, first.failed], [1, 1]);
    assert.equal(first.failedProjects[0].projectId, P1);
    assert.equal(ctx.connectionWrites, 0);
    // next tick: P2 now exists, P1 recovers
    ctx.existingSnapshots = [{ project_id: P2, business_location_id: 'L1', snapshot_date: '2026-10-06' }];
    ctx.aggregateImpl = async () => [{ current: [mixedRow], softDeleted: [] }];
    const second = await runOnce({ now: NOW });
    assert.deepEqual([second.captured, second.skipped, second.failed], [1, 1, 0]);
    assert.equal(ctx.connectionWrites, 0);
  });
  test('a failure while loading targets is logged and returns an empty summary (no throw)', async () => {
    mock.method(GoogleConnection, 'find', () => { throw new Error('db down'); });
    const s = await runOnce({ now: NOW });
    assert.deepEqual([s.captured, s.failed], [0, 0]);
  });
  test('no connections -> nothing to do', async () => {
    world({ connections: [], projects: [], users: [] });
    const s = await runOnce({ now: NOW });
    assert.equal(s.considered, 0);
    assert.equal(ctx.upserts.length, 0);
  });
});

describe('manual snapshot endpoint', () => {
  const USER = 'u1';
  const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });
  let project, connection, owner;
  beforeEach(() => {
    project = { user_id: USER };
    connection = { _id: 'c1', business_account_id: 'A1', business_location_id: 'L1' };
    owner = { timezone: 'Asia/Kolkata' };
    mock.method(SeoProject, 'findById', async () => project);
    mock.method(GoogleConnection, 'findOne', (filter) => { ctx.connectionFilter = filter; return chain(connection); });
    mock.method(User, 'findById', () => chain(owner));
  });
  const call = async (params = {}, extra = {}) => {
    const res = mockRes();
    await snapshotBusinessProfileReviewsController({ params: { projectId: P1, ...params }, user: { _id: USER }, body: {}, query: {}, ...extra }, res);
    return res;
  };

  test('creates today\'s snapshot (201) from the STORED location and the owner\'s timezone', async () => {
    const res = await call();
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.created, true);
    assert.match(res.body.data.snapshot.snapshot_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(res.body.data.snapshot.business_location_id, 'L1');
    assert.equal(res.body.data.snapshot.timezone, 'Asia/Kolkata');
  });
  test('ignores a client-supplied location / date / timezone', async () => {
    await call({}, { body: { locationId: 'ATTACKER', snapshotDate: '2020-01-01', timezone: 'UTC' }, query: { locationId: 'ATTACKER' } });
    assert.equal(ctx.upserts[0].filter.business_location_id, 'L1');
    assert.notEqual(ctx.upserts[0].filter.snapshot_date, '2020-01-01');
    assert.equal(ctx.upserts[0].update.$set.timezone, 'Asia/Kolkata');
  });
  test('the connection lookup is for THIS user + project + business_profile', async () => {
    await call();
    assert.deepEqual(ctx.connectionFilter, { user_id: USER, project_id: P1, purpose: 'business_profile' });
  });
  test("another user's project -> 403, nothing aggregated or written", async () => {
    project = { user_id: 'someone-else' };
    const res = await call();
    assert.equal(res.statusCode, 403);
    assert.equal(ctx.aggregateCalls.length + ctx.upserts.length, 0);
  });
  test('bad / unknown project -> 404; no connected location -> 400', async () => {
    assert.equal((await call({ projectId: 'nope' })).statusCode, 404);
    project = null;
    assert.equal((await call()).statusCode, 404);
    project = { user_id: USER }; connection = null;
    const res = await call();
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'NOT_CONNECTED');
    assert.equal(ctx.upserts.length, 0);
  });
  test('internal ids are not returned', async () => {
    const res = await call();
    for (const k of ['user_id', 'connection_id', '__v']) assert.ok(!(k in res.body.data.snapshot));
  });
  test('a failed snapshot returns a safe 500 and never touches the connection', async () => {
    ctx.aggregateImpl = async () => { throw new Error('mongo exploded: secret-detail'); };
    const res = await call();
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'SNAPSHOT_FAILED');
    assert.ok(!JSON.stringify(res.body).includes('secret-detail'));
    assert.equal(ctx.connectionWrites, 0);
    assert.equal(ctx.upserts.length, 0);
  });
});
