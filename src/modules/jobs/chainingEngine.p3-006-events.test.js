import { describe, test, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import chainingEngine from './chainingEngine.js';
import auditHistoryService from '../audit_history/service/AuditHistoryService.js';
import verificationFinalizer from '../verification/service/VerificationFinalizer.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import auditProgressService from './service/auditProgressService.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// P3-006: URL Verification realtime progress events, wired into
// chainingEngine.process(). PageVerificationRun is a real Mongoose model
// (live-Mongo, auto-skip) since these hooks read it directly; every other
// collaborator (auditHistoryService, verificationFinalizer,
// taskVerificationService, auditProgressService's global.io) is stubbed —
// same construction-proof pattern as chainingEngine.p3-004-completion.test.js.

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

describe('chainingEngine.process — URL Verification realtime events (P3-006, live Mongo)', () => {
  let originalAllTerminalsResolved;
  let originalFinalizeVerification;
  let originalVerifyImplementedTasks;
  let ioCalls;

  beforeEach(() => {
    ioCalls = [];
    global.io = {
      to(room) {
        return { emit: (event, payload) => ioCalls.push({ room, event, payload }) };
      },
    };

    originalAllTerminalsResolved = auditHistoryService.allTerminalsResolved;
    originalFinalizeVerification = verificationFinalizer.finalizeVerification;
    originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });
  });

  afterEach(async () => {
    auditHistoryService.allTerminalsResolved = originalAllTerminalsResolved;
    verificationFinalizer.finalizeVerification = originalFinalizeVerification;
    taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
    global.io = undefined;
    if (mongoAvailable) {
      await PageVerificationRun.deleteMany({});
    }
  });

  async function makeRun(overrides = {}) {
    return PageVerificationRun.create({
      projectId: new mongoose.Types.ObjectId(),
      jobId: new mongoose.Types.ObjectId(),
      runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: 'https://example.com/a',
      status: 'running',
      startedAt: new Date(),
      ...overrides,
    });
  }

  describe('stage progress (non-terminal job types)', () => {
    test('a PAGE_ANALYSIS completion emits verification:progress with the correct stage/progress', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun();
      const job = makeJob({
        jobType: JOB_TYPES.PAGE_ANALYSIS,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });

      await chainingEngine.process(job, {}, 'req-1');

      const progressEvents = ioCalls.filter((c) => c.event === 'verification:progress');
      assert.equal(progressEvents.length, 1);
      assert.equal(progressEvents[0].payload.currentStage, 'Page Analysis');
      assert.equal(progressEvents[0].payload.progress, 50);
      assert.equal(progressEvents[0].payload.runId, job.run_id.toString());
    });

    test('a PAGE_SCRAPING completion emits verification:progress with stage "Page Scraping"', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun();
      const job = makeJob({
        jobType: JOB_TYPES.PAGE_SCRAPING,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });

      await chainingEngine.process(job, {}, 'req-2');

      const progressEvents = ioCalls.filter((c) => c.event === 'verification:progress');
      assert.equal(progressEvents.length, 1);
      assert.equal(progressEvents[0].payload.currentStage, 'Page Scraping');
    });

    test('no progress event for a run that is already terminal (stale/late job completion)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun({ status: 'completed', completedAt: new Date() });
      const job = makeJob({
        jobType: JOB_TYPES.PAGE_ANALYSIS,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });

      await chainingEngine.process(job, {}, 'req-3');

      assert.equal(ioCalls.filter((c) => c.event === 'verification:progress').length, 0);
    });

    test('Full Audit / legacy verification jobs never emit verification:progress', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const job = makeJob({ jobType: JOB_TYPES.PAGE_ANALYSIS, input_data: {} });
      await chainingEngine.process(job, {}, 'req-4');

      assert.equal(ioCalls.filter((c) => c.event.startsWith('verification:')).length, 0);
    });
  });

  describe('completion event', () => {
    test('verification:completed is emitted once both terminals resolve and the finalized run is completed', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun();
      auditHistoryService.allTerminalsResolved = async () => true;
      verificationFinalizer.finalizeVerification = async () => {
        run.status = 'completed';
        run.completedAt = new Date();
        await run.save();
        return run;
      };

      const job = makeJob({
        jobType: JOB_TYPES.AI_VISIBILITY,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });
      await chainingEngine.process(job, {}, 'req-5');

      const completedEvents = ioCalls.filter((c) => c.event === 'verification:completed');
      assert.equal(completedEvents.length, 1);
      assert.equal(completedEvents[0].payload.status, 'completed');
      assert.equal(completedEvents[0].payload.progress, 100);
    });
  });

  describe('failure event (finalization failure)', () => {
    test('verification:failed is emitted when the finalized run comes back failed', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun();
      auditHistoryService.allTerminalsResolved = async () => true;
      verificationFinalizer.finalizeVerification = async () => {
        run.status = 'failed';
        run.errorMessage = 'simulated finalization failure';
        run.completedAt = new Date();
        await run.save();
        return run;
      };

      const job = makeJob({
        jobType: JOB_TYPES.SEO_SCORING,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });
      await chainingEngine.process(job, {}, 'req-6');

      const failedEvents = ioCalls.filter((c) => c.event === 'verification:failed');
      assert.equal(failedEvents.length, 1);
      assert.equal(failedEvents[0].payload.errorMessage, 'simulated finalization failure');
    });
  });

  describe('duplicate event prevention', () => {
    test('a run already terminal BEFORE finalizeVerification is called emits no completed/failed event', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const run = await makeRun({ status: 'completed', completedAt: new Date() });
      auditHistoryService.allTerminalsResolved = async () => true;
      verificationFinalizer.finalizeVerification = async () => run; // idempotent no-op, as P3-002 guarantees

      const job = makeJob({
        jobType: JOB_TYPES.AI_VISIBILITY,
        project_id: run.projectId,
        run_id: new mongoose.Types.ObjectId(run.runId),
        input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
      });
      await chainingEngine.process(job, {}, 'req-7');

      assert.equal(ioCalls.filter((c) => c.event === 'verification:completed' || c.event === 'verification:failed').length, 0);
    });
  });

  describe('Full Audit isolation', () => {
    test('Full Audit completion never emits any verification:* event', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      auditHistoryService.allTerminalsResolved = async () => true;
      const job = makeJob({ jobType: JOB_TYPES.SEO_SCORING, input_data: {} });

      await chainingEngine.process(job, {}, 'req-8');

      assert.equal(ioCalls.filter((c) => c.event.startsWith('verification:')).length, 0);
    });
  });
});
