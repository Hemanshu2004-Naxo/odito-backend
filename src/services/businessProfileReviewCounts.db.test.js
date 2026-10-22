import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import { getReviewAnalytics } from './businessProfileReviewAnalyticsService.js';

/**
 * Count reconciliation against a REAL MongoDB (throwaway database, dropped
 * afterwards): every range, exact start/end boundaries in two timezones,
 * lifetime vs period, and agreement between the Insights numbers and the
 * list / summary numbers that describe the same reviews. Skipped when MongoDB
 * isn't reachable.
 */

const DB_NAME = `odito_counts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let available = false;

const oid = () => new mongoose.Types.ObjectId();
const USER = oid();
const P = oid(); // the project under test
const OTHER_P = oid();
const UNRATED_P = oid();
const NOW = new Date('2026-10-10T08:00:00Z');

let seq = 0;
const review = (project, loc, iso, over = {}) => {
  seq += 1;
  const at = new Date(iso);
  return {
    user_id: USER, project_id: project, business_account_id: 'A1', business_location_id: loc,
    google_review_id: `r${seq}`, google_resource_name: `accounts/A1/locations/${loc}/reviews/r${seq}`,
    reviewer_name: 'X', star_rating: 5, comment: 'great',
    review_create_time: at, review_update_time: at,
    last_seen_at: NOW, is_deleted: false, reply: { comment: null, update_time: null }, ...over,
  };
};
const replied = { comment: 'Thanks', update_time: NOW };

// Window starts for NOW = 2026-10-10 in UTC (computed by hand from the documented rule):
//   7d  -> 2026-10-04T00:00Z      30d -> 2026-09-11T00:00Z      90d -> 2026-07-13T00:00Z
//   6m  -> 2026-04-11T00:00Z      12m -> 2025-10-11T00:00Z
const FIXTURE = [
  review(P, 'L1', '2026-10-10T07:59:00Z', { star_rating: 5, reply: replied }),               // a  in everything
  review(P, 'L1', '2026-10-04T00:00:00.000Z', { star_rating: 4, comment: '' }),               // b  EXACT 7d start (UTC)
  review(P, 'L1', '2026-10-03T23:59:59.999Z', { star_rating: 3 }),                            // c  1ms before 7d (UTC) / inside 7d in IST
  review(P, 'L1', '2026-10-03T18:29:59.999Z', { star_rating: 1 }),                            // n  before 7d in BOTH zones
  review(P, 'L1', '2026-09-11T00:00:00.000Z', { star_rating: 5 }),                            // d  EXACT 30d start
  review(P, 'L1', '2026-09-10T23:59:59.999Z', { star_rating: 2 }),                            // e  1ms before 30d, inside 90d
  review(P, 'L1', '2026-05-01T12:00:00Z', { star_rating: 5, comment: '   ' }),                // m  inside 6m, outside 90d
  review(P, 'L1', '2025-10-11T00:00:00.000Z', { star_rating: 5 }),                            // f  EXACT 12m start
  review(P, 'L1', '2025-10-10T23:59:59.999Z', { star_rating: 1 }),                            // g  1ms before 12m
  review(P, 'L1', '2020-01-01T00:00:00Z', { star_rating: 5 }),                                // h  lifetime only
  // Must never be counted anywhere:
  review(P, 'L1', '2026-10-09T10:00:00Z', { star_rating: 1, is_deleted: true }),              // deleted
  review(P, 'L2', '2026-10-09T10:00:00Z', { star_rating: 1 }),                                // other location
  review(OTHER_P, 'L1', '2026-10-09T10:00:00Z', { star_rating: 1 }),                          // other project
];
// Lifetime (live, L1): a b c n d e m f g h = 10

const analytics = (rangeKey, timezone = 'UTC', project = P, loc = 'L1') =>
  getReviewAnalytics({ projectId: project, locationId: loc, rangeKey, timezone, now: NOW });

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: DB_NAME, serverSelectionTimeoutMS: 2000 });
    available = true;
  } catch {
    return;
  }
  await BusinessProfileReview.init();
  await BusinessProfileReview.insertMany(FIXTURE);
  // A review without a usable rating: stored, counted, but never averaged. Inserted raw (bypasses schema validation).
  await mongoose.connection.db.collection('business_profile_reviews').insertMany([
    review(UNRATED_P, 'L1', '2026-10-09T10:00:00Z', { star_rating: 5 }),
    review(UNRATED_P, 'L1', '2026-10-08T10:00:00Z', { star_rating: 3 }),
    review(UNRATED_P, 'L1', '2026-10-07T10:00:00Z', { star_rating: null }),
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

describe('period counts at exact boundaries (UTC)', () => {
  const EXPECTED = { '7d': 2, '30d': 5, '90d': 6, '6m': 7, '12m': 8 };
  for (const [range, count] of Object.entries(EXPECTED)) {
    run(`${range}: ${count} reviews - start instant included, 1ms earlier excluded, lifetime unaffected`, async () => {
      const a = await analytics(range);
      assert.equal(a.overview.period.totalReviews, count);
      assert.equal(a.overview.lifetime.totalReviews, 10); // lifetime never moves with the range
      assert.equal(a.glance.periodReviews, count);
      assert.equal(a.glance.lifetimeReviews, 10);
    });
  }

  run('every card, chart and breakdown of one range describes the SAME reviews', async () => {
    for (const range of ['7d', '30d', '90d', '6m', '12m']) {
      const a = await analytics(range);
      const n = a.overview.period.totalReviews;
      assert.equal(a.ratings.period.reduce((s, r) => s + r.count, 0), n, `${range} rating buckets`);
      assert.equal(a.ratings.series.reduce((s, b) => s + b.one + b.two + b.three + b.four + b.five, 0), n, `${range} rating chart`);
      assert.equal(a.trends.reduce((s, b) => s + b.reviewCount, 0), n, `${range} trend`);
      assert.equal(a.overview.period.withText + a.overview.period.withoutText, n, `${range} text split`);
      assert.equal(a.distribution.totals.withText + a.distribution.totals.withoutText, n, `${range} distribution`);
      assert.equal(a.response.period.responded + a.response.period.notResponded, n, `${range} response split`);
      assert.equal(a.sentiment.period.total, n, `${range} sentiment`);
      assert.equal(a.overview.lifetime.withText + a.overview.lifetime.withoutText, 10);
    }
  });

  run('7d figures in detail (hand-computed)', async () => {
    const a = await analytics('7d');
    assert.equal(a.overview.period.totalReviews, 2);
    assert.equal(a.overview.period.withText, 1); // a has text, b has none
    assert.equal(a.overview.period.withoutText, 1);
    assert.equal(a.overview.period.averageRating, 4.5);
    assert.deepEqual(a.response.period, { total: 2, responded: 1, notResponded: 1, responseRate: 50 });
    assert.deepEqual(a.ratings.period.map((r) => [r.stars, r.count]), [[5, 1], [4, 1], [3, 0], [2, 0], [1, 0]]);
    assert.equal(a.ratings.unrated.period, 0);
  });

  run('lifetime figures in detail (hand-computed, exact; excludes deleted, other location, other project)', async () => {
    const a = await analytics('7d');
    // a5 b4 c3 n1 d5 e2 m5 f5 g1 h5 -> sum 36 over 10
    assert.equal(a.overview.lifetime.averageRating, 3.6);
    assert.equal(a.overview.lifetime.withText, 8); // a c n d e f g h have text; b ('') and m ('   ') do not
    assert.equal(a.overview.lifetime.withoutText, 2);
    assert.deepEqual(a.ratings.lifetime.map((r) => r.count), [5, 1, 1, 1, 2]);
  });
});

describe('local-day boundaries follow the viewer timezone', () => {
  run('Asia/Kolkata 7d starts at IST midnight: the review 1ms before UTC midnight IS inside, 1ms before IST midnight is NOT', async () => {
    const utc = await analytics('7d', 'UTC');
    const ist = await analytics('7d', 'Asia/Kolkata');
    assert.equal(utc.overview.period.totalReviews, 2);   // a, b
    assert.equal(ist.overview.period.totalReviews, 3);   // a, b, c (c = Oct 4 05:29 IST); n = Oct 3 23:59:59.999 IST stays out
    assert.equal(ist.range.start, '2026-10-03T18:30:00.000Z');
    assert.equal(ist.overview.lifetime.totalReviews, utc.overview.lifetime.totalReviews);
  });
});

describe('Insights and the list/summary describe the same reviews', () => {
  run('stored total, replied and rating distribution equal the Insights lifetime figures', async () => {
    const a = await analytics('12m');
    const stats = await BusinessProfileReview.getStats(P, 'L1');
    assert.equal(stats.count, a.overview.lifetime.totalReviews);
    assert.equal(stats.repliedCount, a.response.lifetime.responded);
    assert.deepEqual([5, 4, 3, 2, 1].map((s) => stats.distribution[s]), a.ratings.lifetime.map((r) => r.count));
    assert.equal(stats.unrated, 0);
  });

  run('the list total equals the stored total; replied / rating filters partition it', async () => {
    const all = await BusinessProfileReview.getPaginated(P, { locationId: 'L1', limit: 100 });
    assert.equal(all.pagination.total, 10);
    const yes = await BusinessProfileReview.getPaginated(P, { locationId: 'L1', replied: true });
    const no = await BusinessProfileReview.getPaginated(P, { locationId: 'L1', replied: false });
    assert.equal(yes.pagination.total, 1);
    assert.equal(yes.pagination.total + no.pagination.total, all.pagination.total);
    let byRating = 0;
    for (const rating of [1, 2, 3, 4, 5]) byRating += (await BusinessProfileReview.getPaginated(P, { locationId: 'L1', rating })).pagination.total;
    assert.equal(byRating, all.pagination.total);
  });

  run('without a location the list keeps its previous project-wide behaviour (other location included)', async () => {
    const wide = await BusinessProfileReview.getPaginated(P, { limit: 100 });
    assert.equal(wide.pagination.total, 11); // + the L2 review
    const scoped = await BusinessProfileReview.getPaginated(P, { locationId: 'L1' });
    assert.equal(scoped.pagination.total, 10);
  });
});

describe('reviews without a usable star rating', () => {
  run('counted in the total, never in the buckets or the average; reported as unrated', async () => {
    const a = await analytics('30d', 'UTC', UNRATED_P);
    assert.equal(a.overview.lifetime.totalReviews, 3);
    assert.equal(a.overview.lifetime.averageRating, 4); // (5+3)/2 rated, NOT 8/3
    assert.equal(a.ratings.unrated.lifetime, 1);
    assert.equal(a.ratings.lifetime.find((r) => r.stars === 5).percent, 50); // share of RATED reviews
    assert.equal(a.ratings.lifetime.reduce((s, r) => s + r.percent, 0), 100);
    const stats = await BusinessProfileReview.getStats(UNRATED_P, 'L1');
    assert.equal(stats.count, 3);
    assert.equal(stats.unrated, 1);
    assert.equal(stats.avgRating, 4);
  });
});

describe('uniqueness and idempotent sync', () => {
  run('a duplicate review id in the same project is rejected by the unique index', async () => {
    const dup = review(P, 'L1', '2026-10-01T00:00:00Z');
    dup.google_review_id = FIXTURE[0].google_review_id;
    await assert.rejects(BusinessProfileReview.collection.insertOne(dup), (e) => e.code === 11000);
  });

  run('bulkUpsertReviews twice (a re-sync) changes nothing about the counts', async () => {
    const before = (await BusinessProfileReview.getStats(P, 'L1')).count;
    const again = FIXTURE.slice(0, 3).map((r) => ({
      google_review_id: r.google_review_id, google_resource_name: r.google_resource_name, reviewer_name: 'X', reviewer_photo_url: null,
      reviewer_is_anonymous: false, star_rating: r.star_rating, comment: r.comment, review_create_time: r.review_create_time,
      review_update_time: r.review_update_time, reply: r.reply,
    }));
    const t = new Date();
    await BusinessProfileReview.bulkUpsertReviews(again, USER, P, 'A1', 'L1', t);
    await BusinessProfileReview.bulkUpsertReviews(again, USER, P, 'A1', 'L1', t);
    assert.equal((await BusinessProfileReview.getStats(P, 'L1')).count, before);
  });
});
