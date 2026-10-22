import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

import SeoProject from '../modules/app_user/model/SeoProject.js';
import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../modules/app_user/model/BusinessProfileMetadata.js';
import { syncBusinessProfileReviewsController } from '../modules/app_user/controller/businessProfileController.js';
import { fetchAllReviews } from './businessProfileReviewService.js';

/**
 * Review sync completeness. Google is mocked: NO network, NO database.
 * Guards the "stored count vs Google's totalReviewCount" behaviour: de-duplication,
 * the recovery pass, honest incompleteness, and never hiding reviews on a partial fetch.
 */

const conn = () => ({
  _id: 'c1', status: 'active', business_account_id: 'A1', business_location_id: 'L1',
  refresh_token: 'r', access_token: 'tok', token_expires_at: new Date(Date.now() + 3600e3),
});
const g = (id, over = {}) => ({
  name: `accounts/A1/locations/L1/reviews/${id}`, starRating: 'FIVE', comment: 'ok',
  createTime: '2026-09-01T00:00:00Z', updateTime: '2026-09-02T00:00:00Z', reviewer: { displayName: 'Rev' }, ...over,
});
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);

/** Serve `pages` (array of {reviews, total}) in order, per pass. `passes` lets the 2nd pass differ. */
function stubGoogle(passes) {
  const calls = { pages: 0, pass: 0 };
  mock.method(axios, 'create', () => ({
    get: async (url, { params } = {}) => {
      if (!/\/reviews$/.test(url)) return { data: {} };
      calls.pages++;
      if (!params?.pageToken) calls.pass++;
      const pass = passes[Math.min(calls.pass, passes.length) - 1];
      const index = params?.pageToken ? Number(params.pageToken) : 0;
      if (typeof pass === 'function') return pass(index, calls);
      const page = pass.pages[index];
      return { data: { reviews: page.map((id) => g(id)), totalReviewCount: pass.total, averageRating: 4.9, nextPageToken: index + 1 < pass.pages.length ? String(index + 1) : undefined } };
    },
  }));
  return calls;
}

// GBP_DEBUG (set in a dev .env) makes the shared client call Google's tokeninfo with the token - never in tests.
beforeEach(() => { process.env.GBP_DEBUG = 'false'; });
afterEach(() => mock.restoreAll());

describe('fetchAllReviews completeness', () => {
  test('all pages are read; every review stored once; complete when the count matches Google', async () => {
    const calls = stubGoogle([{ total: 5, pages: [['r1', 'r2'], ['r3', 'r4'], ['r5']] }]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.deepEqual(r.reviews.map((x) => x.google_review_id), ['r1', 'r2', 'r3', 'r4', 'r5']);
    assert.deepEqual([r.complete, r.missingCount, r.retried, r.truncated], [true, 0, false, false]);
    assert.equal(r.totalReviewCount, 5);
    assert.equal(calls.pages, 3);
  });

  test('a review that shifts onto two pages is stored once (no inflated count)', async () => {
    stubGoogle([{ total: 4, pages: [['r1', 'r2', 'r3'], ['r3', 'r4']] }]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.equal(r.reviews.length, 4);
    assert.equal(new Set(r.reviews.map((x) => x.google_review_id)).size, 4);
    assert.equal(r.complete, true);
    // ...and the counts that make that visible in the reconciliation log
    assert.deepEqual([r.rawFetched, r.uniqueFetched, r.duplicatesWithinPass], [5, 4, 1]);
  });

  test('a caller-supplied client is used as is (read-only diagnostics never touch the token manager)', async () => {
    const seen = [];
    const client = { get: async (url) => { seen.push(url); return { data: { reviews: [g('r1')], totalReviewCount: 1 } }; } };
    const axiosCreate = mock.method(axios, 'create', () => { throw new Error('must not build a client'); });
    const r = await fetchAllReviews({ _id: 'c1' }, 'A1', 'L1', { client });
    assert.equal(r.reviews.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(axiosCreate.mock.callCount(), 0);
  });

  test('a review that slipped between pages is recovered by the second pass', async () => {
    const calls = stubGoogle([
      { total: 5, pages: [['r1', 'r2'], ['r3', 'r4']] },            // r5 missed (shifted past the page boundary)
      { total: 5, pages: [['r1', 'r2'], ['r3', 'r4'], ['r5']] },    // fresh pass sees it
    ]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.equal(r.reviews.length, 5);
    assert.deepEqual([r.complete, r.retried, r.missingCount], [true, true, 0]);
    assert.equal(calls.pass, 2);
  });

  test('a persistent shortfall is reported as incomplete (never hidden), after exactly one retry', async () => {
    const calls = stubGoogle([
      { total: 5, pages: [['r1', 'r2'], ['r3', 'r4']] },
      { total: 5, pages: [['r1', 'r2'], ['r3', 'r4']] },
    ]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.equal(r.reviews.length, 4);
    assert.deepEqual([r.complete, r.missingCount, r.retried], [false, 1, true]);
    assert.equal(calls.pass, 2); // one retry, not a loop
  });

  test('Google total lower than what came back (e.g. a lag) is still complete', async () => {
    stubGoogle([{ total: 3, pages: [['r1', 'r2'], ['r3', 'r4']] }]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.equal(r.reviews.length, 4);
    assert.equal(r.complete, true);
  });

  test('hitting the page ceiling is incomplete and is NOT retried', async () => {
    const calls = stubGoogle([(index) => ({ data: { reviews: [g(`r${index}`)], totalReviewCount: 99999, nextPageToken: String(index + 1) } })]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.deepEqual([r.truncated, r.complete, r.retried], [true, false, false]);
    assert.equal(calls.pages, 200);
  });

  test('no totalReviewCount from Google: nothing to compare against, so the fetch counts as complete', async () => {
    stubGoogle([(index) => ({ data: { reviews: [g('r1')] } })]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.deepEqual([r.reviews.length, r.complete, r.missingCount], [1, true, 0]);
  });

  test('a failing page throws - no partial result that could be mistaken for a full sync', async () => {
    stubGoogle([(index) => {
      if (index === 1) throw Object.assign(new Error('boom'), { response: { status: 400, data: {} } });
      return { data: { reviews: [g('r1')], totalReviewCount: 2, nextPageToken: '1' } };
    }]);
    await assert.rejects(fetchAllReviews(conn(), 'A1', 'L1'), /boom/);
  });

  test('createTime missing -> the review keeps its updateTime, not "now"', async () => {
    stubGoogle([(index) => ({ data: { reviews: [g('r1', { createTime: undefined, updateTime: '2025-01-02T03:04:05Z' })], totalReviewCount: 1 } })]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.equal(r.reviews[0].review_create_time.toISOString(), '2025-01-02T03:04:05.000Z');
  });

  test('a review without an id is skipped, never stored under "undefined"', async () => {
    stubGoogle([(index) => ({ data: { reviews: [g('r1'), { starRating: 'FIVE' }], totalReviewCount: 2 } })]);
    const r = await fetchAllReviews(conn(), 'A1', 'L1');
    assert.deepEqual(r.reviews.map((x) => x.google_review_id), ['r1']);
    assert.equal(r.skippedWithoutId, 1);
  });
});

describe('sync endpoint: deletions only after a complete fetch', () => {
  const PROJECT = '6ac4bf78867ae9b647ec8478';
  const USER = 'u1';
  let upserts; let stale;

  const arrange = (passes) => {
    mock.method(SeoProject, 'findById', async () => ({ user_id: USER }));
    mock.method(GoogleConnection, 'findActiveConnection', async () => conn());
    mock.method(BusinessProfileMetadata, 'upsertForProject', async () => ({}));
    mock.method(BusinessProfileMetadata, 'findOne', async () => null);
    upserts = [];
    stale = [];
    mock.method(BusinessProfileReview, 'bulkUpsertReviews', async (r) => { upserts.push(r); return { attempted: r.length, upserted: r.length, modified: 0, matched: 0 }; });
    mock.method(BusinessProfileReview, 'markStaleAsDeleted', async (...a) => { stale.push(a); return 0; });
    // reconciliation counts: 3 live + 1 hidden in the location, 0 elsewhere (answered by filter)
    mock.method(BusinessProfileReview, 'countDocuments', async (f) => {
      if (f.last_seen_at) return 0;
      if (f.is_deleted === true) return 1;
      if (f.business_location_id?.$ne) return 0;
      return 3;
    });
    const calls = stubGoogle(passes);
    // Everything that is not the reviews list answers like a feature Google does not allow here.
    const create = axios.create;
    mock.method(axios, 'create', (...a) => {
      const client = create(...a);
      return {
        get: async (url, cfg) => {
          if (/\/reviews$/.test(url) && !/reviews\/.+/.test(url)) return client.get(url, cfg);
          if (/localPosts|media/.test(url)) throw Object.assign(new Error('forbidden'), { response: { status: 403, data: { error: { message: 'no' } } } });
          return { data: { title: 'Biz', storefrontAddress: {} } };
        },
        post: async () => ({ data: {} }),
      };
    });
    return calls;
  };
  const call = async () => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
    await syncBusinessProfileReviewsController({ params: { projectId: PROJECT }, user: { _id: USER } }, res);
    return res;
  };

  test('complete fetch -> upserts everything and applies deletions', async () => {
    arrange([{ total: 3, pages: [['r1', 'r2', 'r3']] }]);
    const res = await call();
    assert.equal(res.body.data.reviewsComplete, true);
    assert.equal(res.body.data.reviewCount, 3);
    assert.equal(upserts[0].length, 3);
    assert.equal(stale.length, 1);
  });

  test('every sync reports where each review went (counts only)', async () => {
    arrange([{ total: 3, pages: [['r1', 'r2'], ['r2', 'r3']] }]);
    const res = await call();
    const rec = res.body.data.reviewsReconciliation;
    assert.equal(rec.googleReportedTotal, 3);
    assert.equal(rec.fetchedRecords, 4);
    assert.equal(rec.fetchedUniqueIds, 3);
    assert.equal(rec.duplicatesWithinPass, 1);
    assert.equal(rec.skippedWithoutId, 0);
    assert.equal(rec.writeAttempted, 3);
    assert.equal(rec.storedLive, 3);
    assert.equal(rec.storedSoftDeleted, 1);
    assert.equal(rec.differenceVsGoogle, 0);
    assert.ok(!JSON.stringify(res.body).includes('tok')); // no token anywhere in the response
  });

  test('incomplete fetch -> reviews are upserted but NOTHING is marked deleted', async () => {
    arrange([{ total: 5, pages: [['r1', 'r2', 'r3']] }, { total: 5, pages: [['r1', 'r2', 'r3']] }]);
    const res = await call();
    assert.equal(res.body.data.reviewsComplete, false);
    assert.equal(res.body.data.reviewsMissing, 2);
    assert.equal(upserts[0].length, 3);
    assert.equal(stale.length, 0);
  });

  test('two overlapping syncs of one project share a single run', async () => {
    const calls = arrange([{ total: 2, pages: [['r1', 'r2']] }]);
    const [a, b] = await Promise.all([call(), call()]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(calls.pass, 1); // Google was read once, not twice
    assert.equal(upserts.length, 1);
    assert.equal(stale.length, 1);
  });
});
