import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import { captureReviewSnapshot } from './businessProfileReviewSnapshotService.js';
import { getReviewAnalytics } from './businessProfileReviewAnalyticsService.js';

/**
 * Real MongoDB: the real aggregation, the real unique index and a real
 * concurrent-writer race. Runs in a THROWAWAY database (random name, dropped
 * afterwards) on the configured server - the application's own collections are
 * never touched. Skipped when MongoDB isn't reachable.
 */

const DB_NAME = `odito_snapshot_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let available = false;

const oid = () => new mongoose.Types.ObjectId();
const USER = oid();
const PROJECT_A = oid();
const PROJECT_B = oid();
const NOW = new Date('2026-10-06T20:00:00Z');

let seq = 0;
const review = (project, loc, over = {}) => {
  seq += 1;
  return {
    user_id: USER, project_id: project, business_account_id: 'A1', business_location_id: loc,
    google_review_id: `r${seq}`, google_resource_name: `accounts/A1/locations/${loc}/reviews/r${seq}`,
    reviewer_name: 'X', star_rating: 5, comment: 'great',
    review_create_time: new Date('2026-09-01'), review_update_time: new Date('2026-09-01'),
    last_seen_at: NOW, is_deleted: false, reply: { comment: null, update_time: null }, ...over,
  };
};

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: DB_NAME, serverSelectionTimeoutMS: 2000 });
    available = true;
  } catch {
    return;
  }
  await Promise.all([BusinessProfileReview.init(), BusinessProfileReviewSnapshot.init()]);
  await BusinessProfileReview.insertMany([
    // Project A / L1: 5 live reviews + 1 soft-deleted
    review(PROJECT_A, 'L1', { star_rating: 5, comment: 'Excellent', reply: { comment: 'Thanks!', update_time: NOW } }),
    review(PROJECT_A, 'L1', { star_rating: 4, comment: '  nice  ' }),
    review(PROJECT_A, 'L1', { star_rating: 3, comment: '' }),
    review(PROJECT_A, 'L1', { star_rating: 1, comment: 'bad', reply: { comment: 'Sorry', update_time: NOW } }),
    review(PROJECT_A, 'L1', { star_rating: 5, comment: '   ' }), // whitespace-only = no text
    review(PROJECT_A, 'L1', { star_rating: 2, is_deleted: true }), // not counted, but reported
    // Same project, OTHER location - must not leak in
    review(PROJECT_A, 'L2', { star_rating: 1 }),
    // OTHER project, same location id - must not leak in
    review(PROJECT_B, 'L1', { star_rating: 1 }),
    review(PROJECT_B, 'L1', { star_rating: 1 }),
  ]);
  await mongoose.connection.db.collection('business_profile_metadata').insertOne({
    project_id: PROJECT_A, total_review_count: 6, average_rating: 3.6, reviews_last_synced_at: NOW,
  });
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
const capture = (project = PROJECT_A, loc = 'L1', now = NOW, tz = 'Asia/Kolkata') =>
  captureReviewSnapshot({ projectId: project, locationId: loc, userId: USER, timezone: tz, now });

describe('review snapshot against a real MongoDB', () => {
  run('metrics are exact (text, replies, ratings, sentiment, deleted count) and isolated per project + location', async () => {
    const { snapshot, created } = await capture();
    const m = snapshot.metrics;
    assert.equal(created, true);
    assert.equal(m.total_reviews, 5); // 6 minus the deleted one
    assert.equal(m.average_rating, 3.6); // (5+4+3+1+5)/5
    assert.deepEqual(m.rating_distribution, { one: 1, two: 0, three: 1, four: 1, five: 2 });
    assert.equal(m.with_text, 3); // 'Excellent', 'nice', 'bad'; '' and '   ' are not text
    assert.equal(m.without_text, 2);
    assert.equal(m.responded, 2);
    assert.equal(m.not_responded, 3);
    assert.equal(m.response_rate, 40);
    assert.deepEqual(m.sentiment, { positive: 3, neutral: 1, negative: 1 });
    assert.equal(m.sentiment_stored_labels, 0);
    assert.equal(m.soft_deleted_reviews, 1);
    assert.equal(snapshot.google.reported_review_count, 6);
    assert.equal(snapshot.snapshot_date, '2026-10-07'); // IST is already Oct 7
    assert.equal(snapshot.timezone, 'Asia/Kolkata');
    assert.equal(snapshot.period_start.toISOString(), '2026-10-06T18:30:00.000Z');
  });

  run('the snapshot equals the live analytics numbers (single source of truth)', async () => {
    const { snapshot } = await capture();
    const live = await getReviewAnalytics({ projectId: PROJECT_A, locationId: 'L1', rangeKey: '12m', timezone: 'UTC', now: NOW });
    const m = snapshot.metrics;
    const L = live.overview.lifetime;
    assert.equal(m.total_reviews, L.totalReviews);
    assert.equal(m.average_rating, L.averageRating);
    assert.equal(m.with_text, L.withText);
    assert.equal(m.without_text, L.withoutText);
    assert.equal(m.responded, live.response.lifetime.responded);
    assert.equal(m.response_rate, live.response.lifetime.responseRate);
    assert.equal(m.sentiment.positive, live.sentiment.lifetime.positive);
    assert.equal(m.sentiment.negative, live.sentiment.lifetime.negative);
  });

  run('running it again the same day UPDATES the single row (no duplicate)', async () => {
    await capture();
    const later = new Date(NOW.getTime() + 3600e3);
    const { created } = await capture(PROJECT_A, 'L1', later);
    assert.equal(created, false);
    const key = { project_id: PROJECT_A, business_location_id: 'L1', snapshot_date: '2026-10-07' };
    assert.equal(await BusinessProfileReviewSnapshot.countDocuments(key), 1);
    const row = await BusinessProfileReviewSnapshot.findOne(key).lean();
    assert.equal(row.captured_at.getTime(), later.getTime());
    assert.equal(row.first_captured_at.getTime(), NOW.getTime(), 'first capture time is preserved');
  });

  run('concurrent executions (multiple workers) still leave exactly one row', async () => {
    const day = new Date('2026-10-20T10:00:00Z');
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => capture(PROJECT_A, 'L1', day, 'UTC')));
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message);
    assert.deepEqual(failures, []);
    assert.equal(await BusinessProfileReviewSnapshot.countDocuments({ project_id: PROJECT_A, business_location_id: 'L1', snapshot_date: '2026-10-20' }), 1);
  });

  run('the unique index rejects a duplicate project/location/day', async () => {
    await capture();
    const existing = await BusinessProfileReviewSnapshot.findOne({ project_id: PROJECT_A, business_location_id: 'L1' }).lean();
    const { _id, ...dup } = existing; // eslint-disable-line no-unused-vars
    await assert.rejects(BusinessProfileReviewSnapshot.collection.insertOne(dup), (e) => e.code === 11000);
  });

  run('different location / project / day -> separate rows with their own data', async () => {
    await capture(PROJECT_A, 'L2');
    await capture(PROJECT_B, 'L1');
    await capture(PROJECT_A, 'L1', new Date('2026-10-08T10:00:00Z'), 'UTC');
    const keys = (await BusinessProfileReviewSnapshot.find({}).lean())
      .map((s) => `${s.project_id}:${s.business_location_id}:${s.snapshot_date}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal((await BusinessProfileReviewSnapshot.findOne({ project_id: PROJECT_A, business_location_id: 'L2' }).lean()).metrics.total_reviews, 1);
    assert.equal((await BusinessProfileReviewSnapshot.findOne({ project_id: PROJECT_B, business_location_id: 'L1' }).lean()).metrics.total_reviews, 2);
  });

  run('timezone boundary: 18:29:59Z is Oct 6 in IST, 18:30:00Z is Oct 7', async () => {
    const before = await capture(PROJECT_A, 'L1', new Date('2026-10-06T18:29:59Z'), 'Asia/Kolkata');
    const after = await capture(PROJECT_A, 'L1', new Date('2026-10-06T18:30:00Z'), 'Asia/Kolkata');
    assert.equal(before.snapshot.snapshot_date, '2026-10-06');
    assert.equal(after.snapshot.snapshot_date, '2026-10-07');
  });

  run('zero reviews: a valid snapshot with null average and zero counts', async () => {
    const empty = await capture(oid(), 'LX');
    assert.equal(empty.snapshot.metrics.total_reviews, 0);
    assert.equal(empty.snapshot.metrics.average_rating, null);
    assert.equal(empty.snapshot.metrics.response_rate, 0);
  });
});
