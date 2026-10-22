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
import { JOB_TYPES } from './constants/jobTypes.js';

// P3-002 Part 3: taskVerificationService.verifyImplementedTasks must run
// EXACTLY ONCE per verification batch — previously it ran unconditionally at
// the top of the onComplete hook, once per terminal job type (SEO_SCORING AND
// AI_VISIBILITY independently), i.e. twice per batch. It now piggybacks on
// each branch's own single-winner guard (the same one that already prevents
// a duplicate verification:completed/audit:completed emission).

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

describe('chainingEngine.process — Task Verification runs exactly once (P3-002 Part 3)', () => {
  describe('url_verification branch (live Mongo — real PageVerificationRun status gates the winner)', () => {
    let originalAllTerminalsResolved;
    let originalFinalizeVerification;
    let originalVerifyImplementedTasks;
    let verifyCalls;

    beforeEach(async () => {
      if (!mongoAvailable) return;
      verifyCalls = [];
      originalAllTerminalsResolved = auditHistoryService.allTerminalsResolved;
      originalFinalizeVerification = verificationFinalizer.finalizeVerification;
      originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;

      auditHistoryService.allTerminalsResolved = async () => true;
      taskVerificationService.verifyImplementedTasks = async (...args) => {
        verifyCalls.push(args);
        return { verified: 0, reopened: 0 };
      };
      // Real side effect a genuine finalizeVerification call would have —
      // advances the run to a terminal status so the SECOND completing
      // terminal job's own preCheckRun read sees it's already done.
      verificationFinalizer.finalizeVerification = async (runId) => {
        const run = await PageVerificationRun.findOneAndUpdate(
          { runId },
          { $set: { status: 'completed' } },
          { new: true }
        );
        return run;
      };
    });

    afterEach(async () => {
      if (!mongoAvailable) return;
      auditHistoryService.allTerminalsResolved = originalAllTerminalsResolved;
      verificationFinalizer.finalizeVerification = originalFinalizeVerification;
      taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
      await PageVerificationRun.deleteMany({});
    });

    test('two terminal jobs (SEO_SCORING then AI_VISIBILITY) resolving for the same run call verifyImplementedTasks exactly once', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');

      const projectId = new mongoose.Types.ObjectId();
      const runId = new mongoose.Types.ObjectId();
      const run = await PageVerificationRun.create({
        projectId, jobId: new mongoose.Types.ObjectId(), runId: runId.toString(),
        pageUrl: 'https://example.com/a', status: 'running', startedAt: new Date(),
      });

      const seoScoringJob = makeJob({ jobType: JOB_TYPES.SEO_SCORING, project_id: projectId, run_id: runId, input_data: { mode: 'url_verification' } });
      const aiVisibilityJob = makeJob({ jobType: JOB_TYPES.AI_VISIBILITY, project_id: projectId, run_id: runId, input_data: { mode: 'url_verification' } });

      await chainingEngine.process(seoScoringJob, {}, 'req-1a');
      await chainingEngine.process(aiVisibilityJob, {}, 'req-1b');

      assert.equal(verifyCalls.length, 1);

      const finalRun = await PageVerificationRun.findById(run._id);
      assert.equal(finalRun.status, 'completed');
    });

    test('deferred entirely (zero calls) while other required terminals are unresolved', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      auditHistoryService.allTerminalsResolved = async () => false;

      const job = makeJob({ input_data: { mode: 'url_verification' } });
      await chainingEngine.process(job, {}, 'req-2');

      assert.equal(verifyCalls.length, 0);
    });
  });

  describe('Full Audit branch (mocked _finalizeAuditCompletion — same atomic-winner contract)', () => {
    let originalAllTerminalsResolved;
    let originalCaptureIfComplete;
    let originalFinalizeAuditCompletion;
    let originalEmitCompletionEvent;
    let originalVerifyImplementedTasks;
    let verifyCalls;
    let finalizeCallCount;

    beforeEach(() => {
      verifyCalls = [];
      finalizeCallCount = 0;

      originalAllTerminalsResolved = auditHistoryService.allTerminalsResolved;
      originalCaptureIfComplete = auditHistoryService.captureIfComplete;
      originalFinalizeAuditCompletion = chainingEngine._finalizeAuditCompletion;
      originalEmitCompletionEvent = chainingEngine._emitCompletionEvent;
      originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;

      auditHistoryService.allTerminalsResolved = async () => true;
      auditHistoryService.captureIfComplete = async () => ({ _id: 'fake-audit-run' });
      chainingEngine._emitCompletionEvent = async () => {};
      // Mirrors _finalizeAuditCompletion's real atomic contract: true only
      // for the first ("winning") caller, false for every subsequent one —
      // without needing a real SeoProject document.
      chainingEngine._finalizeAuditCompletion = async () => {
        finalizeCallCount += 1;
        return finalizeCallCount === 1;
      };
      taskVerificationService.verifyImplementedTasks = async (...args) => {
        verifyCalls.push(args);
        return { verified: 0, reopened: 0 };
      };
    });

    afterEach(() => {
      auditHistoryService.allTerminalsResolved = originalAllTerminalsResolved;
      auditHistoryService.captureIfComplete = originalCaptureIfComplete;
      chainingEngine._finalizeAuditCompletion = originalFinalizeAuditCompletion;
      chainingEngine._emitCompletionEvent = originalEmitCompletionEvent;
      taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
    });

    test('two terminal jobs (SEO_SCORING then AI_VISIBILITY) resolving for the same full-audit run call verifyImplementedTasks exactly once', async () => {
      const projectId = new mongoose.Types.ObjectId();
      const runId = new mongoose.Types.ObjectId();

      const seoScoringJob = makeJob({ jobType: JOB_TYPES.SEO_SCORING, project_id: projectId, run_id: runId, input_data: {} });
      const aiVisibilityJob = makeJob({ jobType: JOB_TYPES.AI_VISIBILITY, project_id: projectId, run_id: runId, input_data: {} });

      await chainingEngine.process(seoScoringJob, {}, 'req-3a');
      await chainingEngine.process(aiVisibilityJob, {}, 'req-3b');

      assert.equal(verifyCalls.length, 1);
      assert.equal(finalizeCallCount, 2); // both callers reach the atomic guard; only the first wins
    });

    test('deferred entirely (zero calls) while other required terminals are unresolved', async () => {
      auditHistoryService.allTerminalsResolved = async () => false;

      const job = makeJob({ input_data: {} });
      await chainingEngine.process(job, {}, 'req-4');

      assert.equal(verifyCalls.length, 0);
    });
  });
});
