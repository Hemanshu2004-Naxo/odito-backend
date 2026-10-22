import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import GoogleConnection from '../model/GoogleConnection.js';
import BusinessProfileReview from '../model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../model/BusinessProfileMetadata.js';
import { getBusinessProfileReviewAnalyticsController } from './businessProfileController.js';
import { clearTextInsightsCache } from '../../../services/businessProfileReviewTextInsightsService.js';
import User from '../../user/model/User.js';
import BusinessProfileReviewSnapshot from '../model/BusinessProfileReviewSnapshot.js';

/**
 * Review analytics endpoint: validation + authorization chain. Models are
 * mocked - no database, nothing sent to Google.
 */

const USER = 'u1';
const PROJECT = '6ac4bf78867ae9b647ec8478';
const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
});

let project, connection, metadata, aggregateArgs, connectionFilter, textFilter, textDocs, snapshotRows, snapshotFilters, ownerTimezone, userLookups;

beforeEach(() => {
  project = { user_id: USER };
  connection = { business_location_id: 'L1' };
  metadata = { reviews_capability: { status: 'available' }, average_rating: 4.9, total_review_count: 1053, reviews_last_synced_at: new Date('2026-10-06') };
  aggregateArgs = null;
  connectionFilter = null;
  textFilter = null;
  clearTextInsightsCache();
  snapshotRows = [];
  snapshotFilters = [];
  ownerTimezone = null;
  userLookups = 0;
  // Historical snapshots + the owner's timezone (mocked: no database).
  mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => { userLookups += 1; return { timezone: ownerTimezone }; } }) }));
  mock.method(BusinessProfileReviewSnapshot, 'find', (filter) => {
    snapshotFilters.push(filter);
    const inAnyWindow = (r) => filter.$or.some((w) => r.snapshot_date >= w.snapshot_date.$gte && r.snapshot_date <= w.snapshot_date.$lte);
    return { select: () => ({ sort: () => ({ lean: async () => snapshotRows.filter(inAnyWindow) }) }) };
  });
  mock.method(BusinessProfileReviewSnapshot, 'findOne', (filter) => {
    snapshotFilters.push({ earliestLookup: filter });
    const first = [...snapshotRows].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))[0];
    return { sort: () => ({ select: () => ({ lean: async () => (first ? { snapshot_date: first.snapshot_date } : null) }) }) };
  });
  textDocs = [
    { comment: 'Great doctor and helpful staff', star_rating: 5, review_create_time: new Date() },
    { comment: 'Staff was kind, doctor explained well', star_rating: 5, review_create_time: new Date() },
    { comment: 'Long waiting time', star_rating: 1, review_create_time: new Date() },
  ];
  // Keyword / theme text is streamed from the review store (mocked: no database).
  mock.method(BusinessProfileReview, 'find', (filter) => {
    textFilter = filter;
    return { lean: () => ({ cursor: () => (async function* () { for (const d of textDocs) yield d; })() }) };
  });

  mock.method(SeoProject, 'findById', async () => project);
  mock.method(GoogleConnection, 'findOne', (filter) => {
    connectionFilter = filter;
    return { select: () => ({ lean: async () => connection }) };
  });
  mock.method(BusinessProfileMetadata, 'findOne', () => ({ then: (res) => res(metadata), lean: async () => metadata }));
  mock.method(BusinessProfileReview, 'aggregate', async (pipeline) => {
    aggregateArgs = pipeline;
    return [{ lifetime: [{ total: 2, ratingSum: 9, r5: 1, r4: 1, withText: 2, responded: 1, positive: 2 }], daily: [], recent: undefined }];
  });
});
afterEach(() => mock.restoreAll());

const call = async (query = {}, params = {}) => {
  const res = mockRes();
  await getBusinessProfileReviewAnalyticsController({ params: { projectId: PROJECT, ...params }, query, user: { _id: USER } }, res);
  return res;
};

describe('review analytics endpoint', () => {
  test('defaults to 90d and returns one consolidated payload', async () => {
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.available, true);
    assert.equal(res.body.data.range.key, '90d');
    assert.equal(res.body.data.overview.lifetime.totalReviews, 2);
    assert.equal(res.body.data.overview.google.totalReviewCount, 1053);
  });
  test('rejects an unknown range', async () => {
    const res = await call({ range: '5y' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_RANGE');
    assert.equal(aggregateArgs, null);
  });
  test('invalid timezone falls back to UTC', async () => {
    const res = await call({ range: '7d', tz: 'Not/AZone' });
    assert.equal(res.body.data.range.timezone, 'UTC');
  });
  test('valid timezone is honoured', async () => {
    const res = await call({ range: '7d', tz: 'Asia/Kolkata' });
    assert.equal(res.body.data.range.timezone, 'Asia/Kolkata');
  });
  test("another user's project -> 403, nothing aggregated", async () => {
    project = { user_id: 'someone-else' };
    const res = await call();
    assert.equal(res.statusCode, 403);
    assert.equal(aggregateArgs, null);
  });
  test('malformed / unknown project -> 404', async () => {
    assert.equal((await call({}, { projectId: 'nope' })).statusCode, 404);
    project = null;
    assert.equal((await call()).statusCode, 404);
  });
  test('the connection is looked up for THIS user + project + business_profile', async () => {
    await call();
    assert.deepEqual(connectionFilter, { user_id: USER, project_id: PROJECT, purpose: 'business_profile' });
  });
  test('no connected location -> 400', async () => {
    connection = null;
    const res = await call();
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'NOT_CONNECTED');
    assert.equal(aggregateArgs, null);
  });
  test('the aggregation is scoped to the project AND the stored location, ignoring any client-supplied location', async () => {
    await call({ range: '30d', locationId: 'ATTACKER', projectId: 'other' });
    const match = aggregateArgs[0].$match;
    assert.equal(String(match.project_id), PROJECT);
    assert.equal(match.business_location_id, 'L1');
    assert.equal(match.is_deleted, false);
  });
  test('reviews capability unavailable -> available:false with reason, no aggregation', async () => {
    metadata = { reviews_capability: { status: 'restricted', reason: 'Not allowlisted' } };
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.available, false);
    assert.equal(res.body.data.reason, 'Not allowlisted');
    assert.equal(aggregateArgs, null);
  });
  test('an empty dataset yields a valid, NaN-free payload', async () => {
    BusinessProfileReview.aggregate.mock.restore();
    mock.method(BusinessProfileReview, 'aggregate', async () => [{ lifetime: [], daily: [], recent: [] }]);
    const res = await call({ range: '7d' });
    assert.equal(res.body.data.overview.lifetime.totalReviews, 0);
    assert.equal(res.body.data.overview.lifetime.averageRating, null);
    assert.ok(!JSON.stringify(res.body).includes('NaN'));
  });

  test('response gains keywords + themes next to the existing modules (shape)', async () => {
    const res = await call({ range: '30d' });
    const d = res.body.data;
    for (const k of ['overview', 'ratings', 'trends', 'glance', 'response', 'distribution', 'sentiment']) assert.ok(k in d, k);
    assert.deepEqual(Object.keys(d.keywords).sort(), ['basis', 'phrases', 'status', 'words']);
    assert.deepEqual(Object.keys(d.themes).sort(), ['baseline', 'items', 'reviewsAnalysed', 'status']);
    const staff = d.keywords.words.find((w) => w.term === 'staff');
    assert.deepEqual(Object.keys(staff).sort(), ['mentions', 'negative', 'neutral', 'percentage', 'positive', 'reviewCount', 'score', 'term']);
    assert.ok(d.themes.items.every((t) => t.id && t.name && typeof t.reviewCount === 'number' && typeof t.negativePercent === 'number'));
  });
  test('the text query is scoped to the project and the STORED location, ignoring client-supplied ones', async () => {
    await call({ range: '30d', locationId: 'ATTACKER', projectId: 'other' });
    assert.equal(textFilter.project_id, PROJECT);
    assert.equal(textFilter.business_location_id, 'L1');
    assert.equal(textFilter.is_deleted, false);
  });
  test("another user's project never reaches the text store", async () => {
    project = { user_id: 'someone-else' };
    const res = await call();
    assert.equal(res.statusCode, 403);
    assert.equal(textFilter, null);
  });
  test('the range drives the text window as well (same window as the other modules)', async () => {
    await call({ range: '7d' });
    const { $gte, $lte } = textFilter.review_create_time;
    assert.ok(($lte - $gte) / 864e5 <= 7.01 && ($lte - $gte) / 864e5 >= 5.9);
  });
  test('a text-analytics failure still returns 200 with the numeric modules and keywords/themes = null', async () => {
    BusinessProfileReview.find.mock.restore();
    mock.method(BusinessProfileReview, 'find', () => { throw new Error('text store down'); });
    const res = await call({ range: '30d' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.keywords, null);
    assert.equal(res.body.data.themes, null);
    assert.equal(res.body.data.overview.lifetime.totalReviews, 2);
  });

  // ── MoM / YoY comparison (API) ────────────────────────────────────────────
  const snapRow = (date, tz = 'UTC', over = {}) => ({
    snapshot_date: date, timezone: tz, metric_rules_version: 1,
    metrics: {
      total_reviews: 1000, average_rating: 4.8, with_text: 800, without_text: 200, responded: 990, not_responded: 10, response_rate: 99,
      sentiment: { positive: 950, neutral: 20, negative: 30 }, rating_distribution: { one: 10, two: 5, three: 10, four: 40, five: 935 }, ...over,
    },
  });
  const dayList = (from, to, tz = 'UTC', over = {}) => {
    const out = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(snapRow(d.toISOString().slice(0, 10), tz, over));
    return out;
  };
  const todayKey = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  test('comparison is part of the consolidated response with the documented shape', async () => {
    const res = await call({ range: '7d' });
    const c = res.body.data.comparison;
    assert.deepEqual(Object.keys(c).sort(), ['historyStartsOn', 'mom', 'rangeKey', 'rules', 'status', 'timezone', 'yoy']);
    assert.equal(c.rangeKey, '7d');
    assert.equal(c.mom.currentPeriod.lengthDays, 7);
    assert.ok(['mom', 'yoy'].every((k) => ['available', 'partial', 'insufficient_history'].includes(c[k].status)));
  });
  test('with no snapshot history MoM and YoY are insufficient_history - no fabricated numbers', async () => {
    const c = (await call({ range: '30d' })).body.data.comparison;
    assert.equal(c.status, 'insufficient_history');
    assert.equal(c.historyStartsOn, null);
    for (const k of ['mom', 'yoy']) {
      assert.equal(c[k].status, 'insufficient_history');
      assert.ok(!('metrics' in c[k]));
    }
  });
  test('only today exists (the real situation): both stay insufficient and report when history began', async () => {
    snapshotRows = [snapRow(todayKey('UTC'))];
    const c = (await call({ range: '7d' })).body.data.comparison;
    assert.equal(c.mom.status, 'insufficient_history');
    assert.equal(c.yoy.status, 'insufficient_history');
    assert.equal(c.historyStartsOn, todayKey('UTC'));
  });
  test('MoM becomes available when snapshots cover both periods (automatic, no code change)', async () => {
    const today = todayKey('UTC');
    const mom = (await call({ range: '7d' })).body.data.comparison.mom;
    snapshotRows = [...dayList(mom.currentPeriod.startDate, today), ...dayList(mom.previousPeriod.startDate, mom.previousPeriod.endDate)];
    const c = (await call({ range: '7d' })).body.data.comparison;
    assert.equal(c.mom.status, 'available');
    assert.equal(c.mom.metrics.totalReviews.absoluteChange, 0);
    assert.equal(c.yoy.status, 'insufficient_history');
  });
  test('the snapshot query is scoped to the project and the STORED location (client location ignored), one date-ranged query', async () => {
    await call({ range: '30d', locationId: 'ATTACKER', projectId: 'other' });
    const q = snapshotFilters.find((f) => f.$or);
    assert.equal(q.project_id, PROJECT);
    assert.equal(q.business_location_id, 'L1');
    assert.equal(q.$or.length, 3); // current, month-ago and year-ago windows in ONE query
    assert.equal(snapshotFilters.find((f) => f.earliestLookup).earliestLookup.business_location_id, 'L1');
  });
  test('no raw review scan for the comparison: one snapshot range query + one earliest lookup', async () => {
    await call({ range: '90d' });
    assert.equal(snapshotFilters.filter((f) => f.$or).length, 1);
    assert.equal(snapshotFilters.filter((f) => f.earliestLookup).length, 1);
  });
  test("another user's project: 403, no owner lookup, no snapshot query", async () => {
    project = { user_id: 'someone-else' };
    const res = await call({ range: '30d' });
    assert.equal(res.statusCode, 403);
    assert.equal(snapshotFilters.length, 0);
    assert.equal(userLookups, 0);
  });
  test("the comparison timezone is the owner's snapshot timezone, not the viewer's tz parameter", async () => {
    ownerTimezone = 'Asia/Kolkata';
    const c = (await call({ range: '7d', tz: 'America/New_York' })).body.data.comparison;
    assert.equal(c.timezone, 'Asia/Kolkata');
    assert.equal(c.mom.currentPeriod.endDate, todayKey('Asia/Kolkata'));
    ownerTimezone = null;
    assert.equal((await call({ range: '7d', tz: 'America/New_York' })).body.data.comparison.timezone, 'UTC'); // owner zone -> env default -> UTC
  });
  test('snapshots written in another timezone are not used', async () => {
    ownerTimezone = 'Asia/Kolkata';
    snapshotRows = dayList('2020-01-01', todayKey('UTC'), 'UTC'); // all stored in UTC
    const c = (await call({ range: '7d' })).body.data.comparison;
    assert.equal(c.mom.status, 'insufficient_history');
    assert.ok(c.mom.currentPeriod.coverage.excludedOtherTimezone > 0);
  });
  test('a comparison failure still returns 200 with every other module (comparison = null)', async () => {
    BusinessProfileReviewSnapshot.find.mock.restore();
    mock.method(BusinessProfileReviewSnapshot, 'find', () => { throw new Error('snapshot store down'); });
    const res = await call({ range: '30d' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.comparison, null);
    assert.equal(res.body.data.overview.lifetime.totalReviews, 2);
    assert.ok(res.body.data.keywords);
  });
});
