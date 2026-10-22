import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import chainingEngine from './chainingEngine.js';
import { JobService } from './service/jobService.js';
import auditProgressService from './service/auditProgressService.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import Job from './model/Job.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import VerificationBatch from '../verification/model/VerificationBatch.js';
import { BATCH_STATUS } from '../verification/constants/batchStatus.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// F4-016: Project Aggregation Jobs — replaces per-URL project-wide
// aggregation with batch-level aggregation. Covers:
//   - job creation/queue registration (Job model accepts the 3 new types)
//   - orchestration (SEO_AGG -> AI_AGG -> TASK_VERIFICATION chain fires in order)
//   - "5 URLs -> 1 aggregation -> 1 task verification" (exactly-once)
//   - retry (PROJECT_TASK_VERIFICATION's own Node-side retry scheduling)
//   - batch completion (COMPLETED/PARTIAL/FAILED determination)
//   - regression (non-batched SEO_SCORING/AI_VISIBILITY completion creates
//     no PROJECT_* jobs at all — byte-identical to before this phase)
//
// Live Mongo, auto-skip pattern matching every other test file in this
// series (urlVerificationService.test.js, chainingEngine.p4-batch-barrier.test.js).

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

function makeJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION,
    project_id: new mongoose.Types.ObjectId(),
    user_id: new mongoose.Types.ObjectId(),
    run_id: null,
    group_id: null,
    input_data: {},
    result_data: {},
    ...overrides,
  };
}

async function makeAggregatingBatch(projectId, urlStatuses) {
  const batchId = new mongoose.Types.ObjectId().toString();
  const urls = urlStatuses.map((_, i) => `https://example.com/${i}`);
  await VerificationBatch.create({
    batchId, projectId, urls, totalUrls: urls.length,
    status: BATCH_STATUS.AGGREGATING, aggregateStartedAt: new Date(),
  });
  for (let i = 0; i < urlStatuses.length; i++) {
    await PageVerificationRun.create({
      projectId, batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: urls[i], status: urlStatuses[i],
    });
  }
  return batchId;
}

describe('F4-016: job registration — Job model accepts the 3 new job types (live Mongo)', () => {
  afterEach(async () => {
    if (mongoAvailable) await Job.deleteMany({ jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] } });
  });

  for (const jobType of [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION]) {
    test(`${jobType} passes Job model validation and defaults to status='pending'`, async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const doc = await Job.create({
        jobType,
        project_id: new mongoose.Types.ObjectId(),
        input_data: { batchId: 'batch-reg-test' },
      });
      assert.equal(doc.status, 'pending');
      assert.equal(doc.jobType, jobType);
    });
  }
});

describe('F4-016: jobService creation helpers propagate batchId correctly (live Mongo)', () => {
  afterEach(async () => {
    if (mongoAvailable) await Job.deleteMany({ jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] } });
  });

  test('createAndDispatchProjectSeoAggregationJob has no source job and carries batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const job = await jobService.createAndDispatchProjectSeoAggregationJob({ projectId, batchId: 'batch-abc' });

    assert.equal(job.jobType, JOB_TYPES.PROJECT_SEO_AGGREGATION);
    assert.equal(job.input_data.batchId, 'batch-abc');
    assert.equal(job.status, 'pending');
  });

  test('createAndDispatchProjectAiAggregationJob propagates batchId + source_job_id from PROJECT_SEO_AGGREGATION', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const seoAggJob = makeJob({ input_data: { batchId: 'batch-xyz' } });
    const job = await jobService.createAndDispatchProjectAiAggregationJob(seoAggJob);

    assert.equal(job.jobType, JOB_TYPES.PROJECT_AI_AGGREGATION);
    assert.equal(job.input_data.batchId, 'batch-xyz');
    assert.equal(job.input_data.source_job_id, seoAggJob._id.toString());
  });

  test('createAndDispatchProjectTaskVerificationJob propagates batchId + source_job_id from PROJECT_AI_AGGREGATION', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const aiAggJob = makeJob({ jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, input_data: { batchId: 'batch-999' } });
    const job = await jobService.createAndDispatchProjectTaskVerificationJob(aiAggJob);

    assert.equal(job.jobType, JOB_TYPES.PROJECT_TASK_VERIFICATION);
    assert.equal(job.input_data.batchId, 'batch-999');
    assert.equal(job.input_data.source_job_id, aiAggJob._id.toString());
  });
});

describe('F4-016: chainingEngine.process orchestration — SEO_AGG -> AI_AGG -> TASK_VERIFICATION (live Mongo)', () => {
  let originalVerifyImplementedTasks;

  beforeEach(() => {
    originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;
  });

  afterEach(async () => {
    taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
    if (mongoAvailable) {
      await Job.deleteMany({ jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] } });
      await PageVerificationRun.deleteMany({});
      await VerificationBatch.deleteMany({});
    }
  });

  test('PROJECT_SEO_AGGREGATION completion creates exactly one PROJECT_AI_AGGREGATION job carrying the same batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const seoAggJob = makeJob({
      jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION,
      project_id: projectId,
      input_data: { batchId: 'batch-orch-1' },
    });

    await chainingEngine.process(seoAggJob, {}, 'req-orch-1');

    const created = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_AI_AGGREGATION });
    assert.equal(created.length, 1);
    assert.equal(created[0].input_data.batchId, 'batch-orch-1');
    assert.equal(created[0].input_data.source_job_id, seoAggJob._id.toString());
  });

  test('PROJECT_AI_AGGREGATION completion creates PROJECT_TASK_VERIFICATION and runs it in-process (no Python involvement), finalizing the batch as COMPLETED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed', 'completed']);

    let verifyCallCount = 0;
    taskVerificationService.verifyImplementedTasks = async () => {
      verifyCallCount++;
      return { verified: 3, reopened: 0 };
    };

    const aiAggJob = makeJob({
      jobType: JOB_TYPES.PROJECT_AI_AGGREGATION,
      project_id: projectId,
      input_data: { batchId },
    });

    await chainingEngine.process(aiAggJob, {}, 'req-orch-2');

    assert.equal(verifyCallCount, 1, 'TaskVerificationService must run exactly once');

    const taskVerificationJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION });
    assert.equal(taskVerificationJobs.length, 1);
    assert.equal(taskVerificationJobs[0].status, 'completed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.COMPLETED);
    assert.equal(batch.completedUrls, 2);
    assert.equal(batch.failedUrls, 0);
    assert.ok(batch.completedAt instanceof Date);
  });
});

describe('F4-016: aggregation-once — 5 URLs -> 1 SEO aggregate (live Mongo)', () => {
  afterEach(async () => {
    if (mongoAvailable) {
      await Job.deleteMany({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION });
      await PageVerificationRun.deleteMany({});
      await VerificationBatch.deleteMany({});
    }
  });

  test('5 completed PageVerificationRuns, barrier invoked once per page completion -> exactly 1 PROJECT_SEO_AGGREGATION job (not 5)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = new mongoose.Types.ObjectId().toString();
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/page-${i}`);
    await VerificationBatch.create({ batchId, projectId, urls, totalUrls: 5, status: BATCH_STATUS.RUNNING });

    for (const url of urls) {
      await PageVerificationRun.create({
        projectId, batchId, runId: new mongoose.Types.ObjectId().toString(),
        pageUrl: url, status: 'completed',
      });
    }

    // Simulate each of the 5 pages' own completion invoking the barrier
    // (real-world: each PAGE-level url_verification finalization calls this
    // once). Only the LAST one to observe every run as terminal should win
    // the RUNNING -> AGGREGATING transition and enqueue the chain.
    for (let i = 0; i < 5; i++) {
      await chainingEngine._checkVerificationBatchBarrier({ batchId }, `req-agg-once-${i}`);
    }

    const seoAggJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION });
    assert.equal(seoAggJobs.length, 1, 'exactly one PROJECT_SEO_AGGREGATION job must exist for 5 verified URLs, not 5');
  });
});

describe('F4-016/F4-018: PROJECT_TASK_VERIFICATION retry is persisted-only (no in-process setTimeout) (live Mongo)', () => {
  let originalVerifyImplementedTasks;

  beforeEach(() => {
    originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;
  });

  afterEach(async () => {
    taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
    if (mongoAvailable) {
      await Job.deleteMany({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION });
      await PageVerificationRun.deleteMany({});
      await VerificationBatch.deleteMany({});
    }
  });

  test('F4-018: a failed attempt with attempts remaining persists as "retrying" and does NOT auto-retry in-process', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed']);

    let callCount = 0;
    taskVerificationService.verifyImplementedTasks = async () => {
      callCount++;
      throw new Error('transient verification failure');
    };

    const job = await Job.create({
      jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
      project_id: projectId,
      input_data: { batchId },
      max_attempts: 2,
    });

    await chainingEngine._runProjectTaskVerificationJob(job, 'req-retry-persisted');

    // Give any (incorrect, if present) in-process scheduling a real chance
    // to fire before asserting nothing happened on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reloadedJob = await Job.findById(job._id);
    assert.equal(reloadedJob.status, 'retrying', 'must persist as retrying, not auto-retry via an in-memory timer');
    assert.equal(callCount, 1, 'verifyImplementedTasks must be called exactly once until something explicitly reclaims the job');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING, 'batch must not finalize yet — task verification has not reached a terminal state');
  });

  test('fails once then succeeds when explicitly reclaimed a second time (simulating the recovery scheduler) -> completed with attempts=1', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed']);

    let attempt = 0;
    taskVerificationService.verifyImplementedTasks = async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient verification failure');
      return { verified: 1, reopened: 0 };
    };

    const job = await Job.create({
      jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
      project_id: projectId,
      input_data: { batchId },
      max_attempts: 2,
    });

    await chainingEngine._runProjectTaskVerificationJob(job, 'req-retry-first-attempt');

    const retryingJob = await Job.findById(job._id);
    assert.equal(retryingJob.status, 'retrying');

    // Simulates verificationBatchRecoveryService.reclaimDueProjectTaskVerificationJobs
    // picking this job back up once its backoff has elapsed — the actual
    // scheduler's own claim query is covered separately in
    // verificationBatchRecoveryService.test.js.
    await chainingEngine._runProjectTaskVerificationJob(retryingJob, 'req-retry-reclaimed');

    const finalJob = await Job.findById(job._id);
    assert.equal(finalJob.status, 'completed');
    assert.equal(finalJob.attempts, 1, 'failJob increments attempts on the failed attempt; the retried run itself completes directly');
    assert.equal(attempt, 2, 'verifyImplementedTasks must have been called twice — once failing, once succeeding');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.COMPLETED, 'batch must still finalize after the retried success');
  });

  // Phase 3 hardening regression: without setting claimed_at, a Node crash
  // between verifyImplementedTasks running and the job being marked
  // 'completed' left it stuck at 'processing' forever, invisible to every
  // recovery sweep (cleanupStaleLocks needs claimed_at; the orphaned-pending
  // sweep only matches 'pending', which this job already left). Confirmed by
  // code trace, not hypothetical — see chainingEngine.js's
  // _runProjectTaskVerificationJob comment for the full mechanism.
  test('sets claimed_at when starting, so a stuck "processing" job is now visible to jobService.cleanupStaleLocks', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed']);

    // Simulate a crash after verifyImplementedTasks runs but before the job
    // is marked completed — never resolve, so _runProjectTaskVerificationJob
    // never reaches its own 'completed' write.
    taskVerificationService.verifyImplementedTasks = () => new Promise(() => {});

    const job = await Job.create({
      jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
      project_id: projectId,
      input_data: { batchId },
      max_attempts: 2,
    });

    // Fire and forget — deliberately not awaited, since the promise above
    // never resolves. Give it a tick to reach the 'processing' write.
    chainingEngine._runProjectTaskVerificationJob(job, 'req-claimed-at').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stuckJob = await Job.findById(job._id);
    assert.equal(stuckJob.status, 'processing');
    assert.ok(stuckJob.claimed_at instanceof Date, 'claimed_at must be set so cleanupStaleLocks can eventually reclaim this job');

    // Prove the existing sweep now actually matches it once stale.
    const staleMatch = await Job.findOne({
      _id: job._id,
      status: 'processing',
      claimed_at: { $lt: new Date(Date.now() + 1000) },
    });
    assert.ok(staleMatch, 'jobService.cleanupStaleLocks\' exact query shape must match this stuck job');
  });

  test('exhausts retries (max_attempts=1) -> job permanently failed, but batch still finalizes from per-URL counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed', 'failed']);

    taskVerificationService.verifyImplementedTasks = async () => {
      throw new Error('permanent verification failure');
    };

    const job = await Job.create({
      jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
      project_id: projectId,
      input_data: { batchId },
      max_attempts: 1,
    });

    await chainingEngine._runProjectTaskVerificationJob(job, 'req-retry-exhausted');

    const finalJob = await Job.findById(job._id);
    assert.equal(finalJob.status, 'failed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.PARTIAL, 'batch completion is based on PageVerificationRun per-URL counts, not on whether PROJECT_TASK_VERIFICATION itself succeeded');
  });
});

describe('F4-016: batch completion determination — COMPLETED/PARTIAL/FAILED (live Mongo)', () => {
  afterEach(async () => {
    if (mongoAvailable) {
      await PageVerificationRun.deleteMany({});
      await VerificationBatch.deleteMany({});
    }
  });

  test('all URLs completed -> VerificationBatch.status = COMPLETED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed', 'completed', 'completed']);

    const result = await chainingEngine._finalizeVerificationBatch(batchId, 'req-complete');
    assert.equal(result.status, BATCH_STATUS.COMPLETED);

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.COMPLETED);
    assert.equal(batch.completedUrls, 3);
    assert.equal(batch.failedUrls, 0);
  });

  test('mix of completed/failed -> VerificationBatch.status = PARTIAL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed', 'failed', 'completed']);

    await chainingEngine._finalizeVerificationBatch(batchId, 'req-partial');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.PARTIAL);
    assert.equal(batch.completedUrls, 2);
    assert.equal(batch.failedUrls, 1);
  });

  test('all URLs failed -> VerificationBatch.status = FAILED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['failed', 'failed']);

    await chainingEngine._finalizeVerificationBatch(batchId, 'req-failed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.FAILED);
    assert.equal(batch.completedUrls, 0);
    assert.equal(batch.failedUrls, 2);
  });

  test('exactly-once: a second finalize call is a silent no-op (batch no longer AGGREGATING) and emits no duplicate event', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const batchId = await makeAggregatingBatch(projectId, ['completed']);

    const originalEmit = auditProgressService.emitVerificationBatchCompleted;
    let emitCount = 0;
    auditProgressService.emitVerificationBatchCompleted = (...args) => { emitCount++; };

    try {
      const first = await chainingEngine._finalizeVerificationBatch(batchId, 'req-once-a');
      const second = await chainingEngine._finalizeVerificationBatch(batchId, 'req-once-b');

      assert.ok(first, 'first call must win the finalize transition');
      assert.equal(second, null, 'second call must be a no-op — already finalized');
      assert.equal(emitCount, 1, 'verification:batch-completed must be emitted exactly once');
    } finally {
      auditProgressService.emitVerificationBatchCompleted = originalEmit;
    }
  });
});

describe('F4-016: regression — non-batched SEO_SCORING/AI_VISIBILITY completion creates no PROJECT_* jobs (live Mongo)', () => {
  let originalAllTerminalsResolved;

  afterEach(async () => {
    if (mongoAvailable) {
      await Job.deleteMany({ jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] } });
    }
  });

  test('Full Audit SEO_SCORING completion (no batchId) creates zero PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION/PROJECT_TASK_VERIFICATION jobs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId();
    const job = makeJob({
      jobType: JOB_TYPES.SEO_SCORING,
      project_id: projectId,
      input_data: {}, // no mode, no batchId — Full Audit
    });

    await chainingEngine.process(job, {}, 'req-regression-fullaudit');

    const projectJobs = await Job.find({
      project_id: projectId,
      jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] },
    });
    assert.equal(projectJobs.length, 0, 'a non-batched job completion must never create any project-level aggregation job');
  });
});
