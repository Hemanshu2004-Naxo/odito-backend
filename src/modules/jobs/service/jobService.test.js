import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../model/Job.js';
import { JobService } from './jobService.js';

// F4-018: cleanupStaleLocks now routes every stale job through
// this.failJob() (retry-vs-permanent decided by max_attempts, exactly like
// a real-time failure) instead of forcing every match straight to 'failed'
// via a raw Job.updateMany — so these tests run against live Mongo (the old
// pure-mock design, asserting on a captured Job.updateMany call, no longer
// reflects how the method works at all: it now calls Job.findById /
// Job.findByIdAndUpdate internally via failJob, never Job.updateMany).
//
// P0-001 (historical): cleanupStaleLocks() previously queried/updated a
// `job_status` field that does not exist on the Job schema (the real field
// is `status`), so it silently matched zero documents and was never wired
// to anything — dead code. That regression guard is preserved below (the
// stale-lock query must key off `status`).

const jobService = new JobService();
const PROJECT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

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
  if (mongoAvailable) {
    await Job.deleteMany({ project_id: PROJECT });
  }
});

async function makeStaleProcessingJob({ maxAttempts = 3, minutesAgo = 20, jobType = 'SEO_SCORING' } = {}) {
  const job = await Job.create({
    user_id: USER, project_id: PROJECT, jobType, entityType: 'project',
    status: 'pending', max_attempts: maxAttempts, input_data: {},
  });
  await Job.updateOne(
    { _id: job._id },
    { $set: { status: 'processing', claimed_at: new Date(Date.now() - minutesAgo * 60 * 1000) } }
  );
  return job._id;
}

describe('JobService.cleanupStaleLocks (live Mongo)', () => {
  test('edge case: zero stale jobs is a no-op, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await jobService.cleanupStaleLocks();
    assert.equal(typeof result.modifiedCount, 'number');
  });

  test('a stale job with attempts remaining is routed through failJob and ends up "retrying", not forced straight to "failed"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ maxAttempts: 3 });

    const result = await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloaded = await Job.findById(jobId);
    assert.equal(reloaded.status, 'retrying', 'F4-018: retry-vs-permanent is now decided by failJob (max_attempts), not forced to failed');
    assert.equal(reloaded.claimed_at, null);
    assert.equal(reloaded.error.message, 'stale_lock_recovered');
    assert.equal(reloaded.attempts, 1);
    assert.ok(result.modifiedCount >= 1);
  });

  test('a stale job with no attempts remaining (max_attempts=1) is permanently failed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ maxAttempts: 1 });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloaded = await Job.findById(jobId);
    assert.equal(reloaded.status, 'failed');
    assert.equal(reloaded.claimed_at, null);
    assert.equal(reloaded.error.message, 'stale_lock_recovered');
    assert.ok(reloaded.failed_at instanceof Date);
  });

  test('only matches jobs whose claimed_at is older than the timeout — does not touch fresh "processing" jobs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ minutesAgo: 1 }); // fresh, within default 10-min window

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloaded = await Job.findById(jobId);
    assert.equal(reloaded.status, 'processing', 'a freshly-claimed job must not be recovered yet');
  });

  test('respects a custom lockTimeoutMs override', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ minutesAgo: 2 });

    await jobService.cleanupStaleLocks(60 * 1000); // 1 minute — 2-minute-old job IS stale under this

    const reloaded = await Job.findById(jobId);
    assert.notEqual(reloaded.status, 'processing');
  });

  test('is idempotent — a second sweep immediately after the first does not re-touch an already-recovered job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ maxAttempts: 1 });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);
    const afterFirst = await Job.findById(jobId);
    assert.equal(afterFirst.status, 'failed');

    const secondResult = await jobService.cleanupStaleLocks(10 * 60 * 1000);
    const afterSecond = await Job.findById(jobId);
    assert.equal(afterSecond.status, 'failed', 'already-failed job must not be touched again');
    assert.equal(afterSecond.attempts, afterFirst.attempts, 'a second sweep must not increment attempts again');
  });

  test('failure case: a DB error during the initial find propagates to the caller rather than being swallowed here', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const originalFind = Job.find;
    Job.find = () => { throw new Error('Mongo connection lost'); };
    try {
      await assert.rejects(() => jobService.cleanupStaleLocks(), /Mongo connection lost/);
    } finally {
      Job.find = originalFind;
    }
  });
});
