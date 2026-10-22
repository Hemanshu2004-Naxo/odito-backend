import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import chainingEngine from './chainingEngine.js';
import auditHistoryService from '../audit_history/service/AuditHistoryService.js';
import verificationFinalizer from '../verification/service/VerificationFinalizer.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// P3-004: URL Verification completion lifecycle split.
//
// process() is exercised end-to-end with every collaborator replaced by a
// recording/controllable stub — auditHistoryService.allTerminalsResolved,
// auditHistoryService.captureIfComplete, chainingEngine._finalizeAuditCompletion,
// chainingEngine._emitCompletionEvent, and verificationFinalizer.finalizeVerification
// — so this proves BY CONSTRUCTION that a url_verification-mode completion
// never reaches AuditHistoryService/crawl_status, and a Full Audit/legacy
// verification completion never reaches VerificationFinalizer. No real DB,
// job, or worker is touched.

function makeJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    jobType: JOB_TYPES.SEO_SCORING, // a real onComplete:'emitCompleted' terminal type
    project_id: new mongoose.Types.ObjectId(),
    run_id: new mongoose.Types.ObjectId(),
    group_id: null,
    input_data: {},
    result_data: {},
    ...overrides,
  };
}

describe('chainingEngine.process — URL Verification completion lifecycle split (P3-004)', () => {
  let originalAllTerminalsResolved;
  let originalCaptureIfComplete;
  let originalFinalizeAuditCompletion;
  let originalEmitCompletionEvent;
  let originalFinalizeVerification;
  let originalVerifyImplementedTasks;
  let originalPageVerificationRunFindOne;

  let allTerminalsResolvedCalls;
  let captureIfCompleteCalls;
  let finalizeAuditCompletionCalls;
  let emitCompletionEventCalls;
  let finalizeVerificationCalls;

  let allResolvedReturnValue;
  let finalizeVerificationShouldThrow;

  beforeEach(() => {
    allTerminalsResolvedCalls = [];
    captureIfCompleteCalls = [];
    finalizeAuditCompletionCalls = [];
    emitCompletionEventCalls = [];
    finalizeVerificationCalls = [];
    allResolvedReturnValue = true;
    finalizeVerificationShouldThrow = false;

    originalAllTerminalsResolved = auditHistoryService.allTerminalsResolved;
    originalCaptureIfComplete = auditHistoryService.captureIfComplete;
    originalFinalizeAuditCompletion = chainingEngine._finalizeAuditCompletion;
    originalEmitCompletionEvent = chainingEngine._emitCompletionEvent;
    originalFinalizeVerification = verificationFinalizer.finalizeVerification;
    originalVerifyImplementedTasks = taskVerificationService.verifyImplementedTasks;
    originalPageVerificationRunFindOne = PageVerificationRun.findOne;

    // Unrelated to this task's branching, but a real onComplete terminal
    // (SEO_SCORING/AI_VISIBILITY) always triggers this call first — stub it
    // so these tests never touch a real DB.
    taskVerificationService.verifyImplementedTasks = async () => ({ verified: 0, reopened: 0 });

    // P3-006 added a real PageVerificationRun.findOne() lookup (progress
    // emission + duplicate-completion guard) inside chainingEngine.js's
    // url_verification branch — stub it so this file's "no real DB touched"
    // design still holds. Returns non-terminal by default so the existing
    // finalizeVerification-call-count assertions below are unaffected.
    PageVerificationRun.findOne = () => ({
      select: async () => ({ _id: 'fake-run-id', status: 'running', pageUrl: 'https://example.com/a' }),
    });

    auditHistoryService.allTerminalsResolved = async (...args) => {
      allTerminalsResolvedCalls.push(args);
      return allResolvedReturnValue;
    };
    auditHistoryService.captureIfComplete = async (...args) => {
      captureIfCompleteCalls.push(args);
      return { _id: 'fake-audit-run' };
    };
    chainingEngine._finalizeAuditCompletion = async (...args) => {
      finalizeAuditCompletionCalls.push(args);
      return true;
    };
    chainingEngine._emitCompletionEvent = async (...args) => {
      emitCompletionEventCalls.push(args);
    };
    verificationFinalizer.finalizeVerification = async (...args) => {
      finalizeVerificationCalls.push(args);
      if (finalizeVerificationShouldThrow) {
        throw new Error('simulated VerificationFinalizer failure');
      }
      return { _id: 'fake-run-id', status: 'completed', pageUrl: 'https://example.com/a' };
    };
  });

  afterEach(() => {
    auditHistoryService.allTerminalsResolved = originalAllTerminalsResolved;
    auditHistoryService.captureIfComplete = originalCaptureIfComplete;
    chainingEngine._finalizeAuditCompletion = originalFinalizeAuditCompletion;
    chainingEngine._emitCompletionEvent = originalEmitCompletionEvent;
    verificationFinalizer.finalizeVerification = originalFinalizeVerification;
    PageVerificationRun.findOne = originalPageVerificationRunFindOne;
    taskVerificationService.verifyImplementedTasks = originalVerifyImplementedTasks;
  });

  describe('URL Verification isolation', () => {
    test('VerificationFinalizer is invoked with the run_id when all terminals resolved', async () => {
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-1');

      assert.equal(finalizeVerificationCalls.length, 1);
      assert.equal(finalizeVerificationCalls[0][0], job.run_id.toString());
    });

    test('audit_runs is NOT written for url_verification (captureIfComplete never called)', async () => {
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-2');

      assert.equal(captureIfCompleteCalls.length, 0);
    });

    test('crawl_status is NOT touched for url_verification (_finalizeAuditCompletion never called)', async () => {
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-3');

      assert.equal(finalizeAuditCompletionCalls.length, 0);
    });

    test('no audit:completed websocket event is emitted for url_verification', async () => {
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-4');

      assert.equal(emitCompletionEventCalls.length, 0);
    });

    test('reuses the exact same allTerminalsResolved(projectId, run_id, requestId) call shape as Full Audit', async () => {
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-5');

      assert.equal(allTerminalsResolvedCalls.length, 1);
      assert.equal(allTerminalsResolvedCalls[0][0], job.project_id);
      assert.equal(allTerminalsResolvedCalls[0][1], job.run_id);
    });

    test('deferred when other required terminals are unresolved (no finalization at all)', async () => {
      allResolvedReturnValue = false;
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      await chainingEngine.process(job, {}, 'req-6');

      assert.equal(finalizeVerificationCalls.length, 0);
      assert.equal(captureIfCompleteCalls.length, 0);
      assert.equal(finalizeAuditCompletionCalls.length, 0);
    });
  });

  describe('VerificationFinalizer failure handling', () => {
    test('a VerificationFinalizer failure is caught non-fatally — process() does not throw', async () => {
      finalizeVerificationShouldThrow = true;
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });

      await assert.doesNotReject(() => chainingEngine.process(job, {}, 'req-7'));
      assert.equal(finalizeVerificationCalls.length, 1);
    });

    test('a VerificationFinalizer failure does not fall through to the Full Audit path', async () => {
      finalizeVerificationShouldThrow = true;
      const job = makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });

      await chainingEngine.process(job, {}, 'req-8');

      assert.equal(captureIfCompleteCalls.length, 0);
      assert.equal(finalizeAuditCompletionCalls.length, 0);
    });
  });

  describe('repeated completion (idempotency at the orchestration layer)', () => {
    test('two terminal jobs resolving for the same url_verification run each invoke finalizeVerification without chainingEngine itself crashing or double-branching', async () => {
      const runId = new mongoose.Types.ObjectId();
      const projectId = new mongoose.Types.ObjectId();

      const seoScoringJob = makeJob({ jobType: JOB_TYPES.SEO_SCORING, project_id: projectId, run_id: runId, input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });
      const aiVisibilityJob = makeJob({ jobType: JOB_TYPES.AI_VISIBILITY, project_id: projectId, run_id: runId, input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } });

      await chainingEngine.process(seoScoringJob, {}, 'req-9a');
      await chainingEngine.process(aiVisibilityJob, {}, 'req-9b');

      // Both calls reach VerificationFinalizer — actual duplicate-write
      // protection is VerificationFinalizer's own idempotency (P3-002,
      // tested there), not chainingEngine's responsibility.
      assert.equal(finalizeVerificationCalls.length, 2);
      assert.equal(captureIfCompleteCalls.length, 0);
      assert.equal(finalizeAuditCompletionCalls.length, 0);
    });
  });

  describe('Full Audit / legacy verification — unchanged (backward compatibility)', () => {
    test('Full Audit (no mode) still invokes _finalizeAuditCompletion, _emitCompletionEvent, and captureIfComplete', async () => {
      const job = makeJob({ input_data: {} });
      await chainingEngine.process(job, {}, 'req-10');

      assert.equal(finalizeAuditCompletionCalls.length, 1);
      assert.equal(emitCompletionEventCalls.length, 1);
      assert.equal(captureIfCompleteCalls.length, 1);
      assert.equal(finalizeVerificationCalls.length, 0);
    });

    test('legacy mode:"verification" (project-wide Quick Recheck) still invokes the Full Audit path, not VerificationFinalizer', async () => {
      const job = makeJob({ input_data: { mode: 'verification', canonical_urls: ['https://example.com/a'] } });
      await chainingEngine.process(job, {}, 'req-11');

      assert.equal(finalizeAuditCompletionCalls.length, 1);
      assert.equal(captureIfCompleteCalls.length, 1);
      assert.equal(finalizeVerificationCalls.length, 0);
    });

    test('Full Audit deferral (terminals unresolved) behaves exactly as before', async () => {
      allResolvedReturnValue = false;
      const job = makeJob({ input_data: {} });
      await chainingEngine.process(job, {}, 'req-12');

      // _finalizeAuditCompletion is gated by the outer allResolved check and
      // correctly skipped. captureIfComplete is called unconditionally in
      // the unchanged code — it performs its own internal allTerminalsResolved
      // check before deciding whether to write anything (see its docstring);
      // this stub doesn't replicate that internal skip, it just records the
      // call, which is exactly what the real, unmodified code does too.
      assert.equal(finalizeAuditCompletionCalls.length, 0);
      assert.equal(captureIfCompleteCalls.length, 1);
      assert.equal(finalizeVerificationCalls.length, 0);
    });

    test('a captureIfComplete failure for Full Audit is still caught non-fatally, unaffected by the new branch', async () => {
      auditHistoryService.captureIfComplete = async () => {
        throw new Error('simulated audit history failure');
      };
      const job = makeJob({ input_data: {} });

      await assert.doesNotReject(() => chainingEngine.process(job, {}, 'req-13'));
    });
  });
});
