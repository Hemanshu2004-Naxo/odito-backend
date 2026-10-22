import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../../jobs/model/Job.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import VerificationBatch from '../model/VerificationBatch.js';
import { BATCH_STATUS } from '../constants/batchStatus.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import taskVerificationService from '../../tasks/service/TaskVerificationService.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import {
  reclaimDueProjectTaskVerificationJobs,
  detectOrphanedAggregationJobs,
  recoverStalledAggregationBatches,
} from './verificationBatchRecoveryService.js';

// F4-018: Verification Batch recovery. Covers every scenario the F4-017
// audit found could permanently strand a batch in AGGREGATING: an
// interrupted barrier (PROJECT_SEO_AGGREGATION never created), a gap
// between two chain jobs (Node crashed mid-chain), an interrupted task
// verification (terminal but the batch never finalized), and — the
// centerpiece — a PROJECT_TASK_VERIFICATION retry surviving a simulated
// Node restart (no in-memory state involved at all; everything is read
// fresh from Mongo).

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
    await Job.deleteMany({ project_id: { $in: allProjectIds } });
    await PageVerificationRun.deleteMany({});
    await VerificationBatch.deleteMany({});
  }
  allProjectIds.length = 0;
});

const allProjectIds = [];

function newProjectId() {
  const id = new mongoose.Types.ObjectId();
  allProjectIds.push(id);
  return id;
}

async function makeBatch(projectId, urlStatuses, { status = BATCH_STATUS.AGGREGATING, aggregateStartedAt = new Date(Date.now() - 20 * 60 * 1000) } = {}) {
  const batchId = new mongoose.Types.ObjectId().toString();
  const urls = urlStatuses.map((_, i) => `https://example.com/${i}`);
  await VerificationBatch.create({
    batchId, projectId, urls, totalUrls: urls.length, status, aggregateStartedAt,
  });
  for (let i = 0; i < urlStatuses.length; i++) {
    await PageVerificationRun.create({
      projectId, batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: urls[i], status: urlStatuses[i],
    });
  }
  return batchId;
}

async function makeProjectJob({ jobType, projectId, batchId, status = 'pending' }) {
  const job = await Job.create({
    jobType, project_id: projectId, entityType: 'project', status: 'pending',
    input_data: { batchId },
  });
  if (status !== 'pending') {
    await Job.updateOne({ _id: job._id }, { $set: { status } });
  }
  return job;
}

describe('reclaimDueProjectTaskVerificationJobs (live Mongo)', () => {
  let originalVerify;
  before(() => { originalVerify = taskVerificationService.verifyImplementedTasks; });
  afterEach(() => { taskVerificationService.verifyImplementedTasks = originalVerify; });

  test('F4-018 centerpiece: a "retrying" job (simulating a lost setTimeout after a Node restart) is reclaimed and completes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);

    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 1, reopened: 0 });

    // Simulates exactly what a Node restart used to lose: a job persisted
    // as 'retrying' with an elapsed backoff, and NOTHING in process memory
    // remembering it needs another attempt.
    const job = await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId });
    await Job.updateOne({ _id: job._id }, { $set: { status: 'retrying', last_attempted_at: new Date(Date.now() - 5000), attempts: 1 } });

    const result = await reclaimDueProjectTaskVerificationJobs('test-restart-sim');

    assert.ok(result.reclaimedCount >= 1);
    const reloaded = await Job.findById(job._id);
    assert.equal(reloaded.status, 'completed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.COMPLETED);
  });

  test('a "pending" job (Node crashed before its synchronous first run ever happened) is also reclaimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });

    const job = await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId, status: 'pending' });

    await reclaimDueProjectTaskVerificationJobs('test-pending-reclaim');

    const reloaded = await Job.findById(job._id);
    assert.equal(reloaded.status, 'completed');
  });

  test('a "retrying" job whose backoff has NOT yet elapsed is left alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);

    const job = await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId });
    await Job.updateOne({ _id: job._id }, { $set: { status: 'retrying', last_attempted_at: new Date(Date.now() + 60000), attempts: 1 } });

    await reclaimDueProjectTaskVerificationJobs('test-not-due');

    const reloaded = await Job.findById(job._id);
    assert.equal(reloaded.status, 'retrying', 'must not reclaim before the scheduled backoff time');
  });

  test('retry does not duplicate work: reclaiming does not create a second Job document', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });

    const job = await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId });
    await Job.updateOne({ _id: job._id }, { $set: { status: 'retrying', last_attempted_at: new Date(Date.now() - 5000), attempts: 1 } });

    await reclaimDueProjectTaskVerificationJobs('test-no-dup-1');
    await reclaimDueProjectTaskVerificationJobs('test-no-dup-2');

    const allJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION });
    assert.equal(allJobs.length, 1, 'exactly one Job document must exist — no duplicate created by re-running the reclaim sweep');
  });
});

describe('detectOrphanedAggregationJobs (live Mongo)', () => {
  test('a PROJECT_SEO_AGGREGATION job in-flight whose batch is not AGGREGATING is detected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    // No VerificationBatch document created at all for this batchId.
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId: 'orphan-batch-1' });

    const result = await detectOrphanedAggregationJobs();

    assert.ok(result.orphanedCount >= 1);
  });

  test('a job whose batch IS actively AGGREGATING is NOT counted as orphaned', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['running']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId });

    const before = await detectOrphanedAggregationJobs();
    // Create one definitely-orphaned job too, to prove the legitimate one
    // isn't swept up in the same count.
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, projectId, batchId: 'definitely-orphaned' });
    const after = await detectOrphanedAggregationJobs();

    assert.equal(after.orphanedCount, before.orphanedCount + 1, 'only the genuinely orphaned job should increase the count');
  });
});

describe('recoverStalledAggregationBatches — resumes gaps in the chain (live Mongo)', () => {
  let originalVerify;
  before(() => { originalVerify = taskVerificationService.verifyImplementedTasks; });
  afterEach(() => { taskVerificationService.verifyImplementedTasks = originalVerify; });

  test('interrupted barrier: AGGREGATING batch with NO PROJECT_SEO_AGGREGATION job at all -> one is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed', 'completed']);

    const result = await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });

    assert.ok(result.resumedCount >= 1);
    const jobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, 'input_data.batchId': batchId });
    assert.equal(jobs.length, 1);
  });

  test('missing AI aggregation: PROJECT_SEO_AGGREGATION completed but PROJECT_AI_AGGREGATION never created -> gets created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });

    const result = await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });

    assert.ok(result.resumedCount >= 1);
    const aiJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, 'input_data.batchId': batchId });
    assert.equal(aiJobs.length, 1);
  });

  test('missing task verification: PROJECT_AI_AGGREGATION completed but PROJECT_TASK_VERIFICATION never created -> gets created and run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, projectId, batchId, status: 'completed' });
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });

    await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });

    const taskJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, 'input_data.batchId': batchId });
    assert.equal(taskJobs.length, 1);
    assert.equal(taskJobs[0].status, 'completed', 'PROJECT_TASK_VERIFICATION is Node-self-processed — created AND run synchronously');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.COMPLETED);
  });

  test('interrupted task verification: terminal but the batch never finalized -> finalize runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed', 'failed']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId, status: 'completed' });

    const result = await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });

    assert.ok(result.resumedCount >= 1);
    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.PARTIAL);
  });

  test('in-progress: task verification job still retrying -> recovery skips (no action, no error)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, projectId, batchId, status: 'retrying' });

    const result = await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });

    assert.equal(result.resumedCount, 0);
    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING, 'must not be finalized while task verification is still legitimately in progress');
  });

  test('a batch that has not been AGGREGATING long enough (not yet stale) is left completely untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed'], { aggregateStartedAt: new Date() }); // just started

    const result = await recoverStalledAggregationBatches({ staleThresholdMs: 15 * 60 * 1000 });

    assert.equal(result.checked, 0, 'a fresh AGGREGATING batch must not even be considered stale yet');
    const jobs = await Job.find({ project_id: projectId, 'input_data.batchId': batchId });
    assert.equal(jobs.length, 0, 'no job should be created for a batch that is not actually stuck');
  });

  test('idempotency: running recovery repeatedly for the same stalled batch produces the same outcome, no duplicate jobs, no duplicate websocket event', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });

    let emitCount = 0;
    const originalEmit = auditProgressService.emitVerificationBatchCompleted;
    auditProgressService.emitVerificationBatchCompleted = () => { emitCount++; };

    try {
      // Recovery only backfills GAPS/resumes already-terminal chain steps —
      // it is not a substitute for the actual Python worker completing a
      // PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION job. Calling it twice
      // in a row with nothing else happening in between is legitimately a
      // no-op the second time (the job created by pass 1 is still 'pending',
      // exactly as it would be in production while Python works on it) —
      // that no-op-ness IS the idempotency being proven here. Manually
      // completing each Python-side step between calls simulates the worker
      // actually finishing, so the sweep has something new to react to each
      // time — mirroring repeated scheduler ticks over real wall-clock time.
      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });
      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 }); // no-op: SEO_AGG still pending

      const seoAggJob = await Job.findOne({ project_id: projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, 'input_data.batchId': batchId });
      assert.ok(seoAggJob, 'exactly one PROJECT_SEO_AGGREGATION must exist after two identical recovery calls');
      await Job.updateOne({ _id: seoAggJob._id }, { $set: { status: 'completed' } });

      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });
      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 }); // no-op: AI_AGG still pending

      const aiAggJob = await Job.findOne({ project_id: projectId, jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, 'input_data.batchId': batchId });
      assert.ok(aiAggJob, 'exactly one PROJECT_AI_AGGREGATION must exist');
      await Job.updateOne({ _id: aiAggJob._id }, { $set: { status: 'completed' } });

      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });
      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 }); // no-op: batch already finalized

      const batch = await VerificationBatch.findBatch(batchId);
      assert.equal(batch.status, BATCH_STATUS.COMPLETED);

      const seoJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, 'input_data.batchId': batchId });
      const aiJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_AI_AGGREGATION, 'input_data.batchId': batchId });
      const taskJobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION, 'input_data.batchId': batchId });
      assert.equal(seoJobs.length, 1, 'no duplicate PROJECT_SEO_AGGREGATION across repeated recovery calls');
      assert.equal(aiJobs.length, 1, 'no duplicate PROJECT_AI_AGGREGATION across repeated recovery calls');
      assert.equal(taskJobs.length, 1, 'no duplicate PROJECT_TASK_VERIFICATION across repeated recovery calls');

      assert.equal(emitCount, 1, 'verification:batch-completed must be emitted exactly once despite many recovery calls');
    } finally {
      auditProgressService.emitVerificationBatchCompleted = originalEmit;
    }
  });

  test('duplicate jobs detected (defense-in-depth): two PROJECT_SEO_AGGREGATION jobs for the same batch are logged, not silently repaired', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = newProjectId();
    const batchId = await makeBatch(projectId, ['completed']);
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });
    await makeProjectJob({ jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, projectId, batchId, status: 'completed' });

    const originalError = console.error;
    const errors = [];
    console.error = (msg) => errors.push(msg);
    try {
      await recoverStalledAggregationBatches({ staleThresholdMs: 60 * 1000 });
    } finally {
      console.error = originalError;
    }

    const dupLog = errors.find((e) => e.includes('duplicate_jobs_detected'));
    assert.ok(dupLog, 'a duplicate-jobs anomaly must be logged, not silently ignored or auto-merged');
    assert.ok(dupLog.includes(batchId));

    const jobs = await Job.find({ project_id: projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, 'input_data.batchId': batchId });
    assert.equal(jobs.length, 2, 'the duplicate is logged, not deleted or merged — corrupted state is never silently repaired');
  });
});
