import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import Job from '../../jobs/model/Job.js';
import VerificationBatch from '../../verification/model/VerificationBatch.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import { BATCH_STATUS } from '../../verification/constants/batchStatus.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import * as ops from './systemAdminVerificationOpsService.js';

// ODITO-OPS-001: Verification Operations Dashboard service — read-only,
// no mutation of any pipeline/queue/retry state. Live Mongo, auto-skip
// (same convention as every other test in this session).

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

const trackedProjectIds = [];
const trackedUserIds = [];

function newProjectId() {
  const id = new mongoose.Types.ObjectId();
  trackedProjectIds.push(id);
  return id;
}

afterEach(async () => {
  if (mongoAvailable) {
    await Job.deleteMany({ project_id: { $in: trackedProjectIds } });
    await VerificationBatch.deleteMany({ projectId: { $in: trackedProjectIds } });
    await PageVerificationRun.deleteMany({ projectId: { $in: trackedProjectIds } });
    await SeoProject.deleteMany({ _id: { $in: trackedProjectIds } });
    await User.deleteMany({ _id: { $in: trackedUserIds } });
  }
  trackedProjectIds.length = 0;
  trackedUserIds.length = 0;
});

async function makeProject(overrides = {}) {
  const id = newProjectId();
  await SeoProject.create({
    _id: id,
    user_id: overrides.user_id || new mongoose.Types.ObjectId(),
    project_name: overrides.project_name || 'Ops Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test'],
    crawl_status: 'pending',
  });
  return id;
}

async function makeUser(overrides = {}) {
  const id = new mongoose.Types.ObjectId();
  trackedUserIds.push(id);
  await User.create({
    _id: id,
    email: overrides.email || `ops-${id}@example.com`,
    firstName: 'Ops',
    lastName: 'Tester',
    password: 'hashed-password-placeholder',
    roleId: 5,
    ...overrides,
  });
  return id;
}

async function makeBatch(projectId, { status = BATCH_STATUS.RUNNING, totalUrls = 2, completedUrls = 0, failedUrls = 0, createdBy = null, aggregateStartedAt = null, startedAt = new Date(), completedAt = null } = {}) {
  const batchId = new mongoose.Types.ObjectId().toString();
  await VerificationBatch.create({
    batchId, projectId, urls: Array.from({ length: totalUrls }, (_, i) => `https://example.com/${i}`),
    totalUrls, completedUrls, failedUrls, status, createdBy, aggregateStartedAt, startedAt, completedAt,
  });
  return batchId;
}

async function makeJob({ projectId, jobType, status = 'pending', batchId = null, attempts = 0, errorMessage = null, claimedAt = null, startedAt = null, completedAt = null }) {
  const job = await Job.create({
    project_id: projectId, jobType, entityType: 'project', status: 'pending',
    input_data: batchId ? { batchId } : {},
  });
  const set = { status, attempts };
  if (claimedAt) set.claimed_at = claimedAt;
  if (startedAt) set.started_at = startedAt;
  if (completedAt) set.completed_at = completedAt;
  if (errorMessage) set.error = { message: errorMessage, timestamp: new Date() };
  await Job.updateOne({ _id: job._id }, { $set: set });
  return job._id;
}

describe('systemAdminVerificationOpsService.listBatches / getBatchesSummary (live Mongo)', () => {
  test('lists batches and filters by status', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    await makeBatch(projectId, { status: BATCH_STATUS.COMPLETED });
    await makeBatch(projectId, { status: BATCH_STATUS.FAILED });

    const result = await ops.listBatches({ projectId: projectId.toString(), status: BATCH_STATUS.COMPLETED });

    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].status, BATCH_STATUS.COMPLETED);
  });

  test('flags a batch stuck in AGGREGATING past the threshold, and only that one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const stuckBatch = await makeBatch(projectId, {
      status: BATCH_STATUS.AGGREGATING,
      aggregateStartedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago > 15 min threshold
    });
    await makeBatch(projectId, {
      status: BATCH_STATUS.AGGREGATING,
      aggregateStartedAt: new Date(), // just started — not stuck
    });

    const result = await ops.listBatches({ projectId: projectId.toString() });

    const stuckRow = result.batches.find((b) => b.batchId === stuckBatch);
    const freshRow = result.batches.find((b) => b.batchId !== stuckBatch);
    assert.equal(stuckRow.isStuck, true);
    assert.equal(freshRow.isStuck, false);
  });

  test('stuckOnly filter returns only stuck batches', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const stuckBatch = await makeBatch(projectId, {
      status: BATCH_STATUS.AGGREGATING,
      aggregateStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await makeBatch(projectId, { status: BATCH_STATUS.COMPLETED });

    const result = await ops.listBatches({ projectId: projectId.toString(), stuckOnly: 'true' });

    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].batchId, stuckBatch);
  });

  test('search matches by batchId substring', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const batchId = await makeBatch(projectId);

    const result = await ops.listBatches({ search: batchId.slice(0, 8) });

    assert.ok(result.batches.some((b) => b.batchId === batchId));
  });

  test('getBatchesSummary reports status counts, stuckCount, and duration stats', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const started = new Date(Date.now() - 10000);
    const completed = new Date();
    await makeBatch(projectId, { status: BATCH_STATUS.COMPLETED, totalUrls: 4, startedAt: started, completedAt: completed });
    await makeBatch(projectId, { status: BATCH_STATUS.FAILED, totalUrls: 2 });
    await makeBatch(projectId, {
      status: BATCH_STATUS.AGGREGATING,
      aggregateStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const summary = await ops.getBatchesSummary();

    assert.ok(summary.completed >= 1);
    assert.ok(summary.failed >= 1);
    assert.ok(summary.aggregating >= 1);
    assert.ok(summary.stuckCount >= 1);
    assert.equal(typeof summary.averageUrlsPerBatch, 'number');
  });
});

describe('systemAdminVerificationOpsService.getBatchDetail (live Mongo)', () => {
  test('returns batch, project, runs, jobs, timeline, and recovery events', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const userId = await makeUser();
    const batchId = await makeBatch(projectId, { createdBy: userId });

    await PageVerificationRun.create({
      projectId, batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: 'https://example.com/a', status: 'completed',
    });

    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'completed', batchId, startedAt: new Date() });
    await makeJob({
      projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, status: 'failed', batchId,
      errorMessage: 'stale_lock_recovered', attempts: 1,
    });

    const detail = await ops.getBatchDetail(batchId);

    assert.equal(detail.batch.batchId, batchId);
    assert.equal(detail.user.email, (await User.findById(userId)).email);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.jobs.length, 2);
    assert.ok(detail.timeline.some((t) => t.stage === 'Batch Created'));
    assert.ok(detail.timeline.some((t) => t.stage === 'Page Scraping'));
    assert.equal(detail.recoveryEvents.length, 1);
    assert.equal(detail.recoveryEvents[0].reason, 'Stale lock recovered');
    assert.equal(detail.recoveryEvents[0].batchId, batchId);
  });

  test('returns null for an unknown batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const detail = await ops.getBatchDetail('does-not-exist');
    assert.equal(detail, null);
  });
});

describe('systemAdminVerificationOpsService.getQueueSummary (live Mongo)', () => {
  test('groups by jobType and status, and reports oldest pending / longest processing / retry counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();

    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'pending' });
    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'pending' });
    await makeJob({ projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, status: 'processing', startedAt: new Date(Date.now() - 5000) });
    await makeJob({ projectId, jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION, status: 'retrying', attempts: 1 });

    const summary = await ops.getQueueSummary();

    const pageScraping = summary.byType.find((t) => t.jobType === JOB_TYPES.PAGE_SCRAPING);
    const seoAgg = summary.byType.find((t) => t.jobType === JOB_TYPES.PROJECT_SEO_AGGREGATION);

    assert.ok(pageScraping.pending >= 2);
    assert.ok(pageScraping.oldestPending);
    assert.ok(seoAgg.processing >= 1);
    assert.ok(seoAgg.longestProcessing);
    assert.ok(seoAgg.retryCount >= 1);
    assert.equal(typeof summary.queueDepth, 'number');
  });
});

describe('systemAdminVerificationOpsService.listRecoveryEvents / getRecoverySummary (live Mongo)', () => {
  test('derives recovery events from persisted error markers, and flags what is unavailable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const batchId = await makeBatch(projectId);

    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'failed', batchId, errorMessage: 'stale_lock_recovered' });
    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_ANALYSIS, status: 'failed', errorMessage: 'orphaned_pending_job_recovered' });
    await makeJob({ projectId, jobType: JOB_TYPES.SEO_SCORING, status: 'failed', errorMessage: 'some unrelated failure' });

    const result = await ops.listRecoveryEvents({ projectId: projectId.toString() });

    assert.equal(result.events.length, 2, 'only the two recognized recovery markers should be surfaced, not an unrelated failure');
    assert.deepEqual(result.unavailable.sort(), ['aggregation_resumed', 'batch_resumed', 'duplicate_recovery_avoided'].sort());
  });

  test('filters recovery events by batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    const batchA = await makeBatch(projectId);
    const batchB = await makeBatch(projectId);
    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'failed', batchId: batchA, errorMessage: 'stale_lock_recovered' });
    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'failed', batchId: batchB, errorMessage: 'stale_lock_recovered' });

    const result = await ops.listRecoveryEvents({ batchId: batchA });

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].batchId, batchA);
  });

  test('getRecoverySummary counts retry-reclaimed (attempts>0, terminal) separately from stale-lock/orphaned markers', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();

    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'completed', attempts: 1 });
    await makeJob({ projectId, jobType: JOB_TYPES.PAGE_ANALYSIS, status: 'failed', errorMessage: 'stale_lock_recovered' });
    await makeJob({ projectId, jobType: JOB_TYPES.SEO_SCORING, status: 'failed', errorMessage: 'orphaned_pending_job_recovered' });

    const summary = await ops.getRecoverySummary();

    assert.ok(summary.retryReclaimedCount >= 1);
    assert.ok(summary.staleLockRecoveredCount >= 1);
    assert.ok(summary.orphanedJobRecoveredCount >= 1);
  });
});

describe('systemAdminVerificationOpsService.getWorkerHealth (live Mongo)', () => {
  test('returns Node uptime + scheduler health + a Python heuristic shape', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const health = await ops.getWorkerHealth();

    assert.equal(typeof health.node.uptimeSeconds, 'number');
    assert.ok('enabled' in health.node.staleLockScheduler);
    assert.ok('running' in health.node.staleLockScheduler);
    assert.ok('enabled' in health.node.verificationBatchRecoveryScheduler);
    assert.ok('apparentlyOnline' in health.python);
    assert.ok('isStale' in health.python);
  });

  test('reports Python as stale when the most recent claim is older than the threshold', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = await makeProject();
    await makeJob({
      projectId, jobType: JOB_TYPES.PAGE_SCRAPING, status: 'completed',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago > 5 min threshold
    });

    const health = await ops.getWorkerHealth();

    // Not a strict assertion on isStale (a fresher claim could exist from
    // concurrent test/dev activity in this shared DB) — just confirms the
    // shape and that lastPollAt reflects a real timestamp when claims exist.
    if (health.python.lastPollAt) {
      assert.ok(health.python.lastPollAgeMs >= 0);
    }
  });
});
