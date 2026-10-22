import { describe, test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../model/Job.js';
import { JobService } from './jobService.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';

// H2: recovery for orphaned/stuck URL Verification runs. cleanupStaleLocks'
// own bulk update behavior is covered (DB-free, stubbed) in jobService.test.js;
// these tests cover the NEW behavior specifically — routing a recovered
// url_verification-mode job through VerificationFinalizer + verification:failed
// — against a real PageVerificationRun/VerificationFinalizer, live Mongo.
//
// odito_dev is a shared dev database, not test-isolated — assertions below
// check the SPECIFIC job/run this test created by _id, never the sweep's
// global modifiedCount (which can include unrelated stale jobs already
// sitting in the collection from other activity).

const jobService = new JobService();

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

const PROJECT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

let ioCalls;
beforeEach(() => {
  ioCalls = [];
  global.io = {
    to(room) {
      return { emit: (event, payload) => ioCalls.push({ room, event, payload }) };
    },
  };
});

afterEach(async () => {
  global.io = undefined;
  if (mongoAvailable) {
    await Job.deleteMany({ project_id: PROJECT });
    await PageVerificationRun.deleteMany({ projectId: PROJECT });
  }
});

async function makeRun(runId) {
  return PageVerificationRun.create({
    projectId: PROJECT,
    jobId: new mongoose.Types.ObjectId(),
    runId: runId.toString(),
    pageUrl: 'https://example.com/a',
    status: 'running',
    startedAt: new Date(),
  });
}

// Job.js's own pre('save') hook forcibly corrects status:'processing' back
// to 'pending' for any NEW document while USE_PULL_MODEL=true (a real,
// deliberate safeguard — jobs must never be created already "processing").
// To simulate a job a worker had already claimed and then abandoned, create
// it as 'pending' first, then force the stale 'processing' state via a raw
// updateOne (bypasses document middleware, matching how a real worker claim
// — via a raw findOneAndUpdate elsewhere in this codebase — would leave it).
// F4-018: cleanupStaleLocks now routes the recovered job through failJob,
// which decides retry-vs-permanent from max_attempts (exactly like a real
// failure) instead of forcing it straight to 'failed'. These tests are
// about the DOWNSTREAM routing (URL verification finalization, project
// reset, event emission) that only fires once a job is PERMANENTLY failed
// — max_attempts:1 makes the single recovery attempt exhaust immediately,
// preserving each test's original intent. The retry-preserving case (max_attempts
// remaining) is covered separately below.
async function makeStaleProcessingJob({ jobType, runId, mode, minutesAgo = 20, maxAttempts = 1 }) {
  const input_data = mode === 'url_verification'
    ? { mode, target_url: 'https://example.com/a' }
    : (mode ? { mode, canonical_urls: ['https://example.com/a'] } : {});
  const job = await Job.create({
    user_id: USER, project_id: PROJECT, jobType, entityType: 'project',
    status: 'pending', run_id: runId, input_data, max_attempts: maxAttempts,
  });
  await Job.updateOne(
    { _id: job._id },
    { $set: { status: 'processing', claimed_at: new Date(Date.now() - minutesAgo * 60 * 1000) } }
  );
  return job._id;
}

describe('cleanupStaleLocks — H2 url_verification routing (live Mongo)', () => {
  test('a stale PROCESSING url_verification job finalizes its run as failed and emits verification:failed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);
    await makeStaleProcessingJob({ jobType: 'PAGE_ANALYSIS', runId, mode: 'url_verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'failed');
    assert.match(reloadedRun.errorMessage, /stale lock/i);

    const failedEvents = ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString());
    assert.equal(failedEvents.length, 1);
  });

  test('the job itself is still reset to failed exactly as before (Full Audit behavior unchanged)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);
    const jobId = await makeStaleProcessingJob({ jobType: 'PAGE_ANALYSIS', runId, mode: 'url_verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedJob = await Job.findById(jobId);
    assert.equal(reloadedJob.status, 'failed');
    assert.equal(reloadedJob.error.message, 'stale_lock_recovered');
    assert.equal(reloadedJob.claimed_at, null);
  });

  test('a stale Full Audit (no mode) job is still bulk-recovered, with no VerificationFinalizer/event side effects', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ jobType: 'SEO_SCORING', runId: new mongoose.Types.ObjectId() });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedJob = await Job.findById(jobId);
    assert.equal(reloadedJob.status, 'failed');
    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed').length, 0);
  });

  test('a stale legacy verification (mode:"verification") job is bulk-recovered but does not touch VerificationFinalizer', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const jobId = await makeStaleProcessingJob({ jobType: 'PAGE_SCRAPING', runId: new mongoose.Types.ObjectId(), mode: 'verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedJob = await Job.findById(jobId);
    assert.equal(reloadedJob.status, 'failed');
    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed').length, 0);
  });

  test('a stale AI_VISIBILITY url_verification job is bulk-recovered but does NOT fail the run (graceful tolerance preserved)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);
    await makeStaleProcessingJob({ jobType: 'AI_VISIBILITY', runId, mode: 'url_verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'running'); // untouched — not prematurely failed
    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString()).length, 0);
  });

  test('repeated sweep is safe: a second run right after the first does not re-emit for the same run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);
    await makeStaleProcessingJob({ jobType: 'PAGE_ANALYSIS', runId, mode: 'url_verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);
    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const matchingEmits = ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString());
    assert.equal(matchingEmits.length, 1, 'no additional verification:failed emitted for this run on the second sweep');
  });

  test('no duplicate completion: a run already completed by the normal chainingEngine path is left untouched by a later sweep', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    const run = await makeRun(runId);
    run.status = 'completed';
    run.completedAt = new Date();
    await run.save();

    await makeStaleProcessingJob({ jobType: 'PAGE_ANALYSIS', runId, mode: 'url_verification' });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'completed'); // VerificationFinalizer's own idempotency held
    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString()).length, 0);
  });
});

describe('recoverOrphanedUrlVerificationJobs — pending jobs never claimed (live Mongo)', () => {
  test('a url_verification job stuck in pending past the timeout finalizes its run as failed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);

    await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'pending', run_id: runId, max_attempts: 1,
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'failed');
    assert.match(reloadedRun.errorMessage, /never claimed/i);

    const failedEvents = ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString());
    assert.equal(failedEvents.length, 1);
  });

  test('the job itself transitions to failed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);

    const job = await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'pending', run_id: runId, max_attempts: 1,
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const reloadedJob = await Job.findById(job._id);
    assert.equal(reloadedJob.status, 'failed');
    assert.equal(reloadedJob.error.message, 'orphaned_pending_job_recovered');
  });

  test('a fresh pending url_verification job (within the timeout) is left alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);

    const job = await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'pending', run_id: runId,
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const reloadedJob = await Job.findById(job._id);
    assert.equal(reloadedJob.status, 'pending');
    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'running');
  });

  test('a stuck Full Audit pending job (no mode) is left alone — out of scope for this task', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const job = await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'LINK_DISCOVERY', entityType: 'project',
      status: 'pending', run_id: new mongoose.Types.ObjectId(),
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: {},
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const reloadedJob = await Job.findById(job._id);
    assert.equal(reloadedJob.status, 'pending');
  });

  test('a stuck legacy verification pending job (mode:"verification") is left alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const job = await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'pending', run_id: new mongoose.Types.ObjectId(),
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: { mode: 'verification', canonical_urls: ['https://example.com/a'] },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const reloadedJob = await Job.findById(job._id);
    assert.equal(reloadedJob.status, 'pending');
  });

  test('repeated sweep is safe: a second call for the same run does not re-emit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);

    await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'pending', run_id: runId, max_attempts: 1,
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);
    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    const matchingEmits = ioCalls.filter((c) => c.event === 'verification:failed' && c.payload.runId === runId.toString());
    assert.equal(matchingEmits.length, 1);
  });

  test('edge case: a project with no orphaned jobs is unaffected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);
    assert.equal(typeof result.modifiedCount, 'number');
  });
});

describe('F4-018: cleanupStaleLocks retry-preserving path (live Mongo)', () => {
  test('a stale url_verification job with attempts remaining persists as "retrying" and does NOT yet finalize the run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const runId = new mongoose.Types.ObjectId();
    await makeRun(runId);
    // Default max_attempts (3) — one stale-lock recovery leaves attempts remaining.
    const jobId = await makeStaleProcessingJob({ jobType: 'PAGE_ANALYSIS', runId, mode: 'url_verification', maxAttempts: 3 });

    await jobService.cleanupStaleLocks(10 * 60 * 1000);

    const reloadedJob = await Job.findById(jobId);
    assert.equal(reloadedJob.status, 'retrying', 'F4-018: attempts remaining -> retrying, not forced to failed');

    const reloadedRun = await PageVerificationRun.findOne({ runId: runId.toString() });
    assert.equal(reloadedRun.status, 'running', 'the run must not be finalized while the job can still retry');
    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed').length, 0);
  });
});

describe('F4-018: recoverOrphanedUrlVerificationJobs widened scope — PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION/PROJECT_TASK_VERIFICATION (live Mongo)', () => {
  for (const jobType of ['PROJECT_SEO_AGGREGATION', 'PROJECT_AI_AGGREGATION', 'PROJECT_TASK_VERIFICATION']) {
    test(`a ${jobType} job stuck in pending past the timeout is now recovered (previously out of scope)`, async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const job = await Job.create({
        user_id: USER, project_id: PROJECT, jobType, entityType: 'project',
        status: 'pending', run_id: new mongoose.Types.ObjectId(), max_attempts: 1,
        created_at: new Date(Date.now() - 20 * 60 * 1000),
        input_data: { batchId: `batch-${jobType}` },
      });

      const result = await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

      const reloadedJob = await Job.findById(job._id);
      assert.equal(reloadedJob.status, 'failed');
      assert.equal(reloadedJob.error.message, 'orphaned_pending_job_recovered');
      assert.ok(result.modifiedCount >= 1);
    });
  }

  test('a batch-scoped PROJECT_SEO_AGGREGATION recovered this way still has no verification:failed side effect (not url_verification mode)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.create({
      user_id: USER, project_id: PROJECT, jobType: 'PROJECT_SEO_AGGREGATION', entityType: 'project',
      status: 'pending', run_id: new mongoose.Types.ObjectId(), max_attempts: 1,
      created_at: new Date(Date.now() - 20 * 60 * 1000),
      input_data: { batchId: 'batch-no-run' },
    });

    await jobService.recoverOrphanedUrlVerificationJobs(10 * 60 * 1000);

    assert.equal(ioCalls.filter((c) => c.event === 'verification:failed').length, 0);
  });
});
