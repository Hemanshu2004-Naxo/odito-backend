import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import chainingEngine from './chainingEngine.js';
import auditHistoryService from '../audit_history/service/AuditHistoryService.js';
import verificationFinalizer from '../verification/service/VerificationFinalizer.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import VerificationBatch from '../verification/model/VerificationBatch.js';
import { BATCH_STATUS } from '../verification/constants/batchStatus.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// F4-015: Verification Batch barrier — "has every PageVerificationRun
// belonging to this batch reached a terminal state?" and, if so, exactly-
// once RUNNING -> AGGREGATING. Live Mongo, no auto-skip fallback path makes
// sense here (this is inherently a real-DB concern), matching the
// convention already established in urlVerificationService.test.js and
// chainingEngine.p3-002-task-verification.test.js.

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
    jobType: JOB_TYPES.SEO_SCORING,
    project_id: new mongoose.Types.ObjectId(),
    run_id: new mongoose.Types.ObjectId(),
    group_id: null,
    input_data: {},
    result_data: {},
    ...overrides,
  };
}

async function makeBatch(projectId, urlCount, { status = BATCH_STATUS.RUNNING } = {}) {
  const batchId = new mongoose.Types.ObjectId().toString();
  const urls = Array.from({ length: urlCount }, (_, i) => `https://example.com/${i}`);
  await VerificationBatch.create({ batchId, projectId, urls, totalUrls: urlCount, status });
  const runs = [];
  for (const url of urls) {
    runs.push(await PageVerificationRun.create({
      projectId, batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: url, status: 'pending',
    }));
  }
  return { batchId, runs };
}

describe('chainingEngine._checkVerificationBatchBarrier — unit (live Mongo)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await PageVerificationRun.deleteMany({ projectId });
    await VerificationBatch.deleteMany({ projectId });
  });

  test('incomplete batch: some runs still pending/running -> returns false, batch stays RUNNING', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 3);
    await PageVerificationRun.updateOne({ _id: runs[0]._id }, { $set: { status: 'completed' } });
    await PageVerificationRun.updateOne({ _id: runs[1]._id }, { $set: { status: 'running' } });
    // runs[2] stays 'pending'

    const won = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-incomplete');

    assert.equal(won, false);
    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.RUNNING);
    assert.equal(batch.aggregateStartedAt, null);
  });

  test('complete batch: all runs completed -> returns true, batch transitions to AGGREGATING with aggregateStartedAt set', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 2);
    for (const run of runs) {
      await PageVerificationRun.updateOne({ _id: run._id }, { $set: { status: 'completed' } });
    }

    const won = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-complete');

    assert.equal(won, true);
    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING);
    assert.ok(batch.aggregateStartedAt instanceof Date);
  });

  test('complete batch: mix of completed + failed counts as fully terminal -> returns true and logs the correct counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 3);
    await PageVerificationRun.updateOne({ _id: runs[0]._id }, { $set: { status: 'completed' } });
    await PageVerificationRun.updateOne({ _id: runs[1]._id }, { $set: { status: 'completed' } });
    await PageVerificationRun.updateOne({ _id: runs[2]._id }, { $set: { status: 'failed' } });

    const originalLog = console.log;
    const logs = [];
    console.log = (msg) => logs.push(msg);
    let won;
    try {
      won = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-mixed');
    } finally {
      console.log = originalLog;
    }

    assert.equal(won, true);
    const entered = logs.find((l) => l.includes('[VERIFICATION_BATCH] enteredAggregation'));
    assert.ok(entered, 'expected exactly one structured enteredAggregation log');
    assert.ok(entered.includes(`batchId=${batchId}`));
    assert.ok(entered.includes('completedUrls=2'));
    assert.ok(entered.includes('failedUrls=1'));
    assert.ok(entered.includes('totalUrls=3'));

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING);
  });

  test('ignores pending/running when counting — only completed+failed count as terminal', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 2);
    await PageVerificationRun.updateOne({ _id: runs[0]._id }, { $set: { status: 'completed' } });
    // runs[1] left at 'pending' (the schema default) — must NOT be
    // mistaken for terminal.

    const won = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-ignore-pending');
    assert.equal(won, false);
  });

  test('exactly-once: calling the barrier again after it already won returns false (status no longer RUNNING)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 1);
    await PageVerificationRun.updateOne({ _id: runs[0]._id }, { $set: { status: 'completed' } });

    const first = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-first');
    const second = await chainingEngine._checkVerificationBatchBarrier({ batchId }, 'test-second');

    assert.equal(first, true);
    assert.equal(second, false, 'a second call must be a no-op — the batch is already AGGREGATING');
  });
});

describe('chainingEngine._checkVerificationBatchBarrier — concurrency (live Mongo)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await PageVerificationRun.deleteMany({ projectId });
    await VerificationBatch.deleteMany({ projectId });
  });

  test('two "simultaneous" completions for the same fully-terminal batch: exactly one wins the transition', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 2);
    for (const run of runs) {
      await PageVerificationRun.updateOne({ _id: run._id }, { $set: { status: 'completed' } });
    }

    const [resultA, resultB] = await Promise.all([
      chainingEngine._checkVerificationBatchBarrier({ batchId }, 'race-a'),
      chainingEngine._checkVerificationBatchBarrier({ batchId }, 'race-b'),
    ]);

    const wins = [resultA, resultB].filter(Boolean).length;
    assert.equal(wins, 1, 'exactly one of the two concurrent callers must win the transition');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING);
  });

  test('ten concurrent callers for the same batch: still exactly one winner', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batchId, runs } = await makeBatch(projectId, 1);
    await PageVerificationRun.updateOne({ _id: runs[0]._id }, { $set: { status: 'completed' } });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => chainingEngine._checkVerificationBatchBarrier({ batchId }, `race-${i}`))
    );

    assert.equal(results.filter(Boolean).length, 1);
  });
});

describe('chainingEngine.process — Verification Batch barrier wiring + regression (live Mongo)', () => {
  let originalAllTerminalsResolved;
  let originalFinalizeVerification;
  let originalVerifyImplementedTasks;

  beforeEach(() => {
    originalAllTerminalsResolved = auditHistoryService.allTerminalsResolved;
    originalFinalizeVerification = verificationFinalizer.finalizeVerification;
    originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;
    auditHistoryService.allTerminalsResolved = async () => true;
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });
  });

  afterEach(async () => {
    auditHistoryService.allTerminalsResolved = originalAllTerminalsResolved;
    verificationFinalizer.finalizeVerification = originalFinalizeVerification;
    taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
    if (mongoAvailable) {
      await PageVerificationRun.deleteMany({});
      await VerificationBatch.deleteMany({});
    }
  });

  test('regression: single-URL verification (batchId null) never touches VerificationBatch and behaves exactly as before', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const projectId = new mongoose.Types.ObjectId();
    const runId = new mongoose.Types.ObjectId();
    const run = await PageVerificationRun.create({
      projectId, jobId: new mongoose.Types.ObjectId(), runId: runId.toString(),
      pageUrl: 'https://example.com/single', status: 'running', startedAt: new Date(),
      batchId: null,
    });

    verificationFinalizer.finalizeVerification = async (rid) => {
      return PageVerificationRun.findOneAndUpdate({ runId: rid }, { $set: { status: 'completed' } }, { new: true });
    };

    const job = makeJob({ project_id: projectId, run_id: runId, input_data: { mode: 'url_verification' } });
    await assert.doesNotReject(() => chainingEngine.process(job, {}, 'req-regression'));

    const finalRun = await PageVerificationRun.findById(run._id);
    assert.equal(finalRun.status, 'completed');

    const batchCount = await VerificationBatch.countDocuments({ projectId });
    assert.equal(batchCount, 0, 'no VerificationBatch document should ever be created/touched for a non-batched run');
  });

  test('a batched run reaching completion via the real completion path correctly triggers the barrier when it is the last one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const projectId = new mongoose.Types.ObjectId();
    const batchId = new mongoose.Types.ObjectId().toString();
    await VerificationBatch.create({
      batchId, projectId, urls: ['https://example.com/a', 'https://example.com/b'],
      totalUrls: 2, status: BATCH_STATUS.RUNNING,
    });

    const runIdA = new mongoose.Types.ObjectId();
    const runIdB = new mongoose.Types.ObjectId();
    await PageVerificationRun.create({
      projectId, batchId, jobId: new mongoose.Types.ObjectId(), runId: runIdA.toString(),
      pageUrl: 'https://example.com/a', status: 'completed', startedAt: new Date(), completedAt: new Date(),
    });
    const runB = await PageVerificationRun.create({
      projectId, batchId, jobId: new mongoose.Types.ObjectId(), runId: runIdB.toString(),
      pageUrl: 'https://example.com/b', status: 'running', startedAt: new Date(),
    });

    verificationFinalizer.finalizeVerification = async (rid) => {
      return PageVerificationRun.findOneAndUpdate({ runId: rid }, { $set: { status: 'completed' } }, { new: true });
    };

    const job = makeJob({ project_id: projectId, run_id: runIdB, input_data: { mode: 'url_verification' } });
    await chainingEngine.process(job, {}, 'req-last-url');

    const finalRunB = await PageVerificationRun.findById(runB._id);
    assert.equal(finalRunB.status, 'completed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.AGGREGATING, 'the LAST run finishing must trigger the barrier via the real completion path');
  });

  test('a batched run reaching completion while a sibling is still pending does NOT trigger the barrier', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const projectId = new mongoose.Types.ObjectId();
    const batchId = new mongoose.Types.ObjectId().toString();
    await VerificationBatch.create({
      batchId, projectId, urls: ['https://example.com/a', 'https://example.com/b'],
      totalUrls: 2, status: BATCH_STATUS.RUNNING,
    });

    const runIdA = new mongoose.Types.ObjectId();
    const runIdB = new mongoose.Types.ObjectId();
    const runA = await PageVerificationRun.create({
      projectId, batchId, jobId: new mongoose.Types.ObjectId(), runId: runIdA.toString(),
      pageUrl: 'https://example.com/a', status: 'running', startedAt: new Date(),
    });
    await PageVerificationRun.create({
      projectId, batchId, jobId: new mongoose.Types.ObjectId(), runId: runIdB.toString(),
      pageUrl: 'https://example.com/b', status: 'pending',
    });

    verificationFinalizer.finalizeVerification = async (rid) => {
      return PageVerificationRun.findOneAndUpdate({ runId: rid }, { $set: { status: 'completed' } }, { new: true });
    };

    const job = makeJob({ project_id: projectId, run_id: runIdA, input_data: { mode: 'url_verification' } });
    await chainingEngine.process(job, {}, 'req-not-last');

    const finalRunA = await PageVerificationRun.findById(runA._id);
    assert.equal(finalRunA.status, 'completed');

    const batch = await VerificationBatch.findBatch(batchId);
    assert.equal(batch.status, BATCH_STATUS.RUNNING, 'must stay RUNNING — a sibling run has not finished yet');
  });
});
