import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../model/Job.js';
import { JobService } from './jobService.js';

// F4-018: claimJob() used to be defined TWICE in this class — a dead first
// definition (never actually reachable, since JS class bodies keep only the
// LAST method with a given name) that matched 'pending' + 'retrying', and
// the surviving second definition that matched 'pending' ONLY. Every
// Python-polled job type (PAGE_SCRAPING, HEADLESS_ACCESSIBILITY,
// PAGE_ANALYSIS, SEO_SCORING, AI_VISIBILITY, PROJECT_SEO_AGGREGATION,
// PROJECT_AI_AGGREGATION) shares this one claim path via GET /api/jobs/claim
// -> jobService.claimJob(job_type) (jobRoutes.js:667) — so a job that failed
// once with attempts remaining (status 'retrying') was never reclaimed by
// anything. These tests prove the fix: reclaim 'retrying' once its
// failJob-computed backoff has elapsed, without double-counting attempts or
// duplicating a claim under concurrency.

const jobService = new JobService();
const PROJECT = new mongoose.Types.ObjectId();

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

afterEach(async () => {
  if (mongoAvailable) await Job.deleteMany({ project_id: PROJECT });
});

async function makeJob({ status = 'pending', jobType = 'SEO_SCORING', claimedAt = null, lastAttemptedAt = null, attempts = 0 } = {}) {
  const job = await Job.create({
    project_id: PROJECT, jobType, entityType: 'project', status: 'pending', input_data: {},
  });
  await Job.updateOne(
    { _id: job._id },
    { $set: { status, claimed_at: claimedAt, last_attempted_at: lastAttemptedAt, attempts } }
  );
  return job._id;
}

// claimJob's query is intentionally global/project-agnostic (a real job
// queue has no notion of "which test created this"), and odito_dev is a
// shared, not test-isolated database (same caveat documented in
// jobService.h2-recovery.test.js). Any pre-existing claimable job of a
// given jobType — left over from other test runs or real dev activity —
// would otherwise make "was MY specific job claimed / left alone" tests
// non-deterministic (claimJob's own priority/created_at sort could pick a
// stray job instead of the one this test just made). Draining first makes
// every subsequent assertion about ONE specific job deterministic.
async function drainClaimable(jobType) {
  for (let i = 0; i < 50; i++) {
    const claimed = await jobService.claimJob(jobType);
    if (!claimed) break;
  }
}

describe('F4-018: JobService.claimJob reclaims retrying jobs (live Mongo)', () => {
  beforeEach(async () => {
    if (!mongoAvailable) return;
    await drainClaimable('SEO_SCORING');
    await drainClaimable('AI_VISIBILITY');
    await drainClaimable('PROJECT_SEO_AGGREGATION');
    await drainClaimable('PROJECT_AI_AGGREGATION');
  });

  test('a "retrying" job whose backoff delay has elapsed (last_attempted_at in the past) IS reclaimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeJob({
      status: 'retrying',
      lastAttemptedAt: new Date(Date.now() - 5000), // backoff elapsed 5s ago
      attempts: 1,
    });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.ok(claimed, 'claimJob must return the reclaimed job');
    assert.equal(claimed._id.toString(), jobId.toString());
    assert.equal(claimed.status, 'processing');

    const reloaded = await Job.findById(jobId);
    assert.equal(reloaded.status, 'processing');
    assert.equal(reloaded.claimed_at.toISOString() !== null, true);
  });

  test('a "retrying" job whose backoff delay has NOT yet elapsed is NOT reclaimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeJob({
      status: 'retrying',
      lastAttemptedAt: new Date(Date.now() + 60 * 1000), // scheduled 1 minute from now
      attempts: 1,
    });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.equal(claimed, null, 'a job still within its backoff window must not be claimed early');
  });

  test('attempts is NOT incremented by claimJob itself — only failJob increments it (avoids double-counting against max_attempts)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeJob({
      status: 'retrying',
      lastAttemptedAt: new Date(Date.now() - 5000),
      attempts: 1,
    });

    await jobService.claimJob('SEO_SCORING');

    const reloaded = await Job.findById(jobId);
    assert.equal(reloaded.attempts, 1, 'claiming must not change the attempts count set by the prior failJob call');
  });

  test('a fresh "pending" job (claimed_at null) is claimed immediately — unchanged from before this fix', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeJob({ status: 'pending', claimedAt: null });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.ok(claimed);
    assert.equal(claimed._id.toString(), jobId.toString());
  });

  test('a "pending" job with a fresh (non-stale) claimed_at is left alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeJob({ status: 'pending', claimedAt: new Date() });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.equal(claimed, null);
  });

  test('a "pending" job with a stale claimed_at (defensive edge case) is reclaimed — unchanged from before this fix', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeJob({ status: 'pending', claimedAt: new Date(Date.now() - 6 * 60 * 1000) });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.ok(claimed);
    assert.equal(claimed._id.toString(), jobId.toString());
  });

  test('a "completed" or "failed" job is never claimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeJob({ status: 'completed' });
    await makeJob({ status: 'failed', lastAttemptedAt: new Date(Date.now() - 5000) });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.equal(claimed, null);
  });

  test('only matches the requested jobType', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeJob({ status: 'retrying', jobType: 'AI_VISIBILITY', lastAttemptedAt: new Date(Date.now() - 5000) });

    const claimed = await jobService.claimJob('SEO_SCORING');

    assert.equal(claimed, null, 'a due retrying job of a DIFFERENT jobType must not be claimed');
  });

  test('retry does not duplicate work: two concurrent claimJob calls for the same due retrying job — exactly one wins', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeJob({
      status: 'retrying',
      lastAttemptedAt: new Date(Date.now() - 5000),
      attempts: 1,
    });

    const [a, b] = await Promise.all([
      jobService.claimJob('SEO_SCORING'),
      jobService.claimJob('SEO_SCORING'),
    ]);

    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one of the two concurrent claims must succeed for the single due job');
  });

  test('this specific PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION retry now works end-to-end via the same claim path', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const jobType of ['PROJECT_SEO_AGGREGATION', 'PROJECT_AI_AGGREGATION']) {
      const jobId = await makeJob({ status: 'retrying', jobType, lastAttemptedAt: new Date(Date.now() - 5000), attempts: 1 });
      const claimed = await jobService.claimJob(jobType);
      assert.ok(claimed, `${jobType} must be reclaimable from 'retrying' now that the duplicate claimJob bug is fixed`);
      assert.equal(claimed._id.toString(), jobId.toString());
    }
  });
});
