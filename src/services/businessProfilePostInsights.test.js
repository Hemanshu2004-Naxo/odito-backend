import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

import SeoProject from '../modules/app_user/model/SeoProject.js';
import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import BusinessProfilePost from '../modules/app_user/model/BusinessProfilePost.js';
import { syncBusinessProfilePostsController } from '../modules/app_user/controller/businessProfilePostController.js';
import { buildInsightsRequest, fetchLocalPostInsightsReport, fetchAllPosts } from './businessProfilePostService.js';

/**
 * Post views / clicks (reportInsights). Google is mocked: NO network, NO database.
 * Regression coverage for: wrong request body (basicMetric), failures swallowed
 * as "0 views", and upserts wiping stored metrics to 0.
 */

const SECRET = 'ya29.SECRET_ACCESS_TOKEN';
const conn = () => ({
  _id: 'c1', status: 'active', business_account_id: 'A1', business_location_id: 'L1',
  refresh_token: 'r', access_token: SECRET, token_expires_at: new Date(Date.now() + 3600e3),
});
const name = (i) => `accounts/A1/locations/L1/localPosts/p${i}`;
const names = (n) => Array.from({ length: n }, (_, i) => name(i));
const metricFor = (i, views, ctas) => ({
  localPostName: name(i),
  metricValues: [
    { metric: 'LOCAL_POST_VIEWS_SEARCH', totalValue: { metricOption: 'AGGREGATED_TOTAL', value: String(views) } },
    { metric: 'LOCAL_POST_ACTIONS_CALL_TO_ACTION', totalValue: { metricOption: 'AGGREGATED_TOTAL', value: String(ctas) } },
  ],
});
const googleError = (status, message) => Object.assign(new Error('Request failed'), { response: { status, data: { error: { status: 'INVALID_ARGUMENT', message } } } });

let posted;
beforeEach(() => { posted = []; });
afterEach(() => mock.restoreAll());

describe('reportInsights request (documented shape)', () => {
  const NOW = new Date('2026-10-10T08:00:00Z');
  test('uses basicRequest.metricRequests + timeRange - and never the invalid "basicMetric" field', () => {
    const body = buildInsightsRequest(['a', 'b'], NOW);
    assert.deepEqual(body.localPostNames, ['a', 'b']);
    assert.deepEqual(body.basicRequest.metricRequests, [{ metric: 'ALL', options: ['AGGREGATED_TOTAL'] }]);
    assert.ok(!('basicMetric' in body));
  });
  test('the time range ends now and stays inside Google\'s 18-month limit', () => {
    const { startTime, endTime } = buildInsightsRequest(['a'], NOW).basicRequest.timeRange;
    assert.equal(endTime, NOW.toISOString());
    const days = (Date.parse(endTime) - Date.parse(startTime)) / 86400000;
    assert.ok(days > 365 && days <= 548, `${days} days`);
  });
});

describe('fetchLocalPostInsightsReport', () => {
  const stubClient = (impl) => mock.method(axios, 'create', () => ({ post: async (url, body) => { posted.push({ url, body }); return impl(body, posted.length); } }));

  test('reads Google\'s response: string values become numbers, keyed by post id', async () => {
    stubClient(() => ({ data: { localPostMetrics: [metricFor(0, 17, 3), metricFor(1, 0, 0)] } }));
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', names(2));
    assert.equal(r.insights.p0.views_search, 17);
    assert.equal(r.insights.p0.actions_call_to_action, 3);
    assert.deepEqual([r.insights.p1.views_search, r.insights.p1.actions_call_to_action], [0, 0]); // a REAL zero
    assert.deepEqual([r.requested, r.received, r.failedBatches], [2, 2, 0]);
    assert.equal(posted[0].url, 'accounts/A1/locations/L1/localPosts:reportInsights');
    assert.ok(posted[0].body.basicRequest);
  });
  test('large lists are split into batches within Google\'s per-call limit', async () => {
    stubClient(() => ({ data: { localPostMetrics: [] } }));
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', names(120));
    assert.equal(posted.length, 3);
    assert.ok(posted.every((p) => p.body.localPostNames.length <= 50));
    assert.equal(r.totalBatches, 3);
  });
  test('a rejected request is REPORTED as a failure, not silently turned into zeros', async () => {
    stubClient(() => { throw googleError(400, 'Invalid JSON payload received. Unknown name "basicMetric"'); });
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', names(5));
    assert.deepEqual(r.insights, {});
    assert.deepEqual([r.failedBatches, r.totalBatches, r.received], [1, 1, 0]);
  });
  test('one failing batch does not lose the other batches', async () => {
    stubClient((_b, n) => { if (n === 2) throw googleError(400, 'rejected batch'); return { data: { localPostMetrics: [metricFor(0, 5, 1)] } }; });
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', names(120));
    assert.equal(r.failedBatches, 1);
    assert.equal(r.insights.p0.views_search, 5);
  });
  test('posts Google did not report on are absent (unknown), not zero', async () => {
    stubClient(() => ({ data: { localPostMetrics: [metricFor(0, 9, 2)] } }));
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', names(3));
    assert.deepEqual(Object.keys(r.insights), ['p0']);
  });
  test('an authentication problem never throws and never exposes a token', async () => {
    const bad = { ...conn(), refresh_token: null };
    const r = await fetchLocalPostInsightsReport(bad, 'A1', 'L1', names(3));
    assert.deepEqual([r.failedBatches, r.received], [1, 0]);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });
  test('no posts -> no request', async () => {
    stubClient(() => ({ data: {} }));
    const r = await fetchLocalPostInsightsReport(conn(), 'A1', 'L1', []);
    assert.equal(posted.length, 0);
    assert.equal(r.requested, 0);
  });
});

describe('fetchAllPosts + sync endpoint', () => {
  const listClient = (insightsImpl) => ({
    get: async () => ({ data: { localPosts: [
      { name: name(0), summary: 'One', state: 'LIVE', createTime: '2026-10-07T00:00:00Z' },
      { name: name(1), summary: 'Two', state: 'LIVE', createTime: '2026-10-08T00:00:00Z' },
    ] } }),
    post: async (u, b) => insightsImpl(b),
  });

  test('when insights succeed the posts carry real views and clicks', async () => {
    mock.method(axios, 'create', () => listClient(() => ({ data: { localPostMetrics: [metricFor(0, 12, 4), metricFor(1, 0, 0)] } })));
    const { posts, insights } = await fetchAllPosts(conn(), 'A1', 'L1');
    assert.deepEqual([posts[0].views_search, posts[0].actions_call_to_action], [12, 4]);
    assert.equal(posts[0].metrics_last_synced_at instanceof Date, true);
    assert.deepEqual([insights.received, insights.failedBatches], [2, 0]);
  });
  test('when insights FAIL the posts carry NO metric fields at all (so nothing is zeroed or stamped)', async () => {
    mock.method(axios, 'create', () => listClient(() => { throw googleError(400, 'bad request'); }));
    const { posts, insights } = await fetchAllPosts(conn(), 'A1', 'L1');
    for (const p of posts) {
      assert.ok(!('views_search' in p) && !('actions_call_to_action' in p) && !('metrics_last_synced_at' in p));
    }
    assert.equal(insights.failedBatches, 1);
  });

  const USER = 'u1';
  const PROJECT = '6ac4bf78867ae9b647ec8478';
  const call = async () => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
    await syncBusinessProfilePostsController({ params: { projectId: PROJECT }, user: { _id: USER } }, res);
    return res;
  };
  const arrange = (insightsImpl) => {
    mock.method(SeoProject, 'findById', async () => ({ user_id: USER }));
    mock.method(GoogleConnection, 'findActiveConnection', async () => conn());
    mock.method(axios, 'create', () => listClient(insightsImpl));
    const upserts = [];
    mock.method(BusinessProfilePost, 'bulkUpsertPosts', async (p) => { upserts.push(p); return { upserted: 0, modified: p.length }; });
    mock.method(BusinessProfilePost, 'markStaleAsDeleted', async () => 0);
    return upserts;
  };

  test('sync endpoint: healthy -> metricsSynced true', async () => {
    arrange(() => ({ data: { localPostMetrics: [metricFor(0, 3, 1), metricFor(1, 8, 2)] } }));
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.metricsSynced, true);
    assert.equal(res.body.data.insights.received, 2);
  });
  test('sync endpoint: Google rejects insights -> sync still succeeds, says metricsSynced:false, and sends NO zeros to the database', async () => {
    const upserts = arrange(() => { throw googleError(400, 'Unknown name "basicMetric"'); });
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.metricsSynced, false);
    assert.equal(res.body.data.insights.failedBatches, 1);
    for (const p of upserts[0]) assert.ok(!('views_search' in p));
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
  });
});

describe('BusinessProfilePost.bulkUpsertPosts keeps real metrics', () => {
  const run = async (posts) => {
    let ops;
    mock.method(BusinessProfilePost, 'bulkWrite', async (o) => { ops = o; return { upsertedCount: 0, modifiedCount: o.length }; });
    await BusinessProfilePost.bulkUpsertPosts(posts, 'u1', PROJECT_ID, 'A1', 'L1', new Date('2026-10-10T08:00:00Z'));
    return ops[0].updateOne.update;
  };
  const PROJECT_ID = '6ac4bf78867ae9b647ec8478';
  const base = { google_post_id: 'p0', google_resource_name: name(0), summary: 'x' };

  test('a post WITHOUT metrics (failed fetch, or an edit) does not touch stored views/clicks/synced-at', async () => {
    const u = await run([base]);
    for (const k of ['views_search', 'actions_call_to_action', 'metrics_last_synced_at']) assert.ok(!(k in u.$set), `${k} must not be overwritten`);
    assert.deepEqual(u.$setOnInsert, { views_search: 0, actions_call_to_action: 0, metrics_last_synced_at: null }); // new posts start unmeasured
  });
  test('a post WITH metrics stores them and stamps when they were measured', async () => {
    const u = await run([{ ...base, views_search: 12, actions_call_to_action: 4, metrics_last_synced_at: new Date('2026-10-10T08:00:00Z') }]);
    assert.deepEqual([u.$set.views_search, u.$set.actions_call_to_action], [12, 4]);
    assert.equal(u.$set.metrics_last_synced_at.toISOString(), '2026-10-10T08:00:00.000Z');
    assert.ok(!('$setOnInsert' in u));
  });
  test('a measured zero is stored as a zero (not skipped)', async () => {
    const u = await run([{ ...base, views_search: 0, actions_call_to_action: 0 }]);
    assert.deepEqual([u.$set.views_search, u.$set.actions_call_to_action], [0, 0]);
    assert.ok(u.$set.metrics_last_synced_at);
  });
  test('the summary reports how many posts have ever been measured', async () => {
    let pipeline;
    mock.method(BusinessProfilePost, 'aggregate', async (p) => { pipeline = p; return [{ totalPosts: 3, livePosts: 3, totalViews: 5, totalActions: 1, postsWithMetrics: 2 }]; });
    const s = await BusinessProfilePost.getMetricsSummary(PROJECT_ID);
    assert.equal(s.postsWithMetrics, 2);
    assert.ok(JSON.stringify(pipeline).includes('metrics_last_synced_at'));
  });
});
