import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import chainingEngine from './chainingEngine.js';
import Job from './model/Job.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import JobGroup from './model/JobGroup.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// P1-002: widened mode recognition ('verification' + 'url_verification',
// both skip CRAWL_GRAPH) at chainingEngine.js's PAGE_SCRAPING `next`-filter
// branch (~line 287).
//
// P1-003 (below, second describe block): widened mode recognition inside
// checkDependencyGate() itself (~line 876) — the fix for the FES's
// top-flagged silent-permanent-hang risk.
//
// process() is exercised end-to-end (not just the isolated boolean) so
// "no new jobs created / no worker dispatch / no dispatcher changes" are
// proven by construction: _createAndDispatchJob and checkDependencyGate are
// replaced with recording stubs, so nothing here ever touches a real DB,
// job, or worker.

function makeJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    jobType: JOB_TYPES.PAGE_SCRAPING,
    project_id: new mongoose.Types.ObjectId(),
    run_id: new mongoose.Types.ObjectId(),
    group_id: null, // no JobGroup — skips the chunked-completion branch entirely
    input_data: {},
    result_data: {},
    ...overrides,
  };
}

describe('chainingEngine.process — PAGE_SCRAPING mode-based CRAWL_GRAPH exclusion (P1-002)', () => {
  let originalCreateAndDispatch;
  let originalCheckGate;
  let originalFindRun;
  let dispatchCalls;
  let gateCalls;

  beforeEach(() => {
    dispatchCalls = [];
    gateCalls = [];
    originalCreateAndDispatch = chainingEngine._createAndDispatchJob;
    originalCheckGate = chainingEngine.checkDependencyGate;
    // The url_verification branches look the verification run up before anything else. These tests connect to no database, so an
    // un-stubbed lookup is not a fast failure: Mongoose BUFFERS the query for its full 10 s timeout, and the engine then swallows the error
    // as "non-fatal" - five tests that passed after 10 s each (50 s of the backend run). "No run exists" is the answer the tests mean.
    originalFindRun = PageVerificationRun.findOne;
    PageVerificationRun.findOne = () => ({ select: async () => null });

    // Recording stubs — no real job is ever created, no real dispatch ever
    // happens, no real DB is touched by either.
    chainingEngine._createAndDispatchJob = async (nextJobType) => {
      dispatchCalls.push(nextJobType);
    };
    chainingEngine.checkDependencyGate = async (completedJob, requestId) => {
      gateCalls.push({ completedJob, requestId });
    };
  });

  afterEach(() => {
    chainingEngine._createAndDispatchJob = originalCreateAndDispatch;
    chainingEngine.checkDependencyGate = originalCheckGate;
    PageVerificationRun.findOne = originalFindRun;
  });

  // ── Mode recognition ──

  test('Full Audit (no mode field) unchanged: CRAWL_GRAPH and AI_VISIBILITY both fan out', async () => {
    await chainingEngine.process(makeJob({ input_data: {} }), {}, 'req-1');
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });

  test('legacy "verification" mode unchanged: CRAWL_GRAPH excluded, AI_VISIBILITY still fans out', async () => {
    await chainingEngine.process(makeJob({ input_data: { mode: 'verification' } }), {}, 'req-2');
    assert.deepEqual(dispatchCalls, [JOB_TYPES.AI_VISIBILITY]);
  });

  test('"url_verification" is now recognized: CRAWL_GRAPH excluded, AI_VISIBILITY still fans out', async () => {
    await chainingEngine.process(
      makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing' } }),
      {}, 'req-3'
    );
    assert.deepEqual(dispatchCalls, [JOB_TYPES.AI_VISIBILITY]);
  });

  test('an unknown/unrecognized mode value is handled correctly — falls through to Full Audit behavior', async () => {
    await chainingEngine.process(makeJob({ input_data: { mode: 'some_future_mode' } }), {}, 'req-4');
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });

  // ── Branch selection ──

  test('url_verification never enters the Full Audit (CRAWL_GRAPH-included) path', async () => {
    await chainingEngine.process(
      makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }),
      {}, 'req-5'
    );
    assert.ok(!dispatchCalls.includes(JOB_TYPES.CRAWL_GRAPH));
  });

  test('verification behavior is byte-identical whether legacy or url_verification mode is used', async () => {
    await chainingEngine.process(makeJob({ input_data: { mode: 'verification' } }), {}, 'req-6a');
    const legacyCalls = [...dispatchCalls];
    dispatchCalls = [];
    await chainingEngine.process(
      makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }),
      {}, 'req-6b'
    );
    assert.deepEqual(dispatchCalls, legacyCalls);
  });

  test('Full Audit behavior is unaffected regardless of how many other modes exist', async () => {
    await chainingEngine.process(makeJob({ input_data: undefined }), {}, 'req-7');
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });

  // ── Regression: dependency gate / dispatch untouched by this task ──

  test('checkDependencyGate is still invoked exactly once for PAGE_SCRAPING, identically regardless of mode', async () => {
    for (const mode of [undefined, 'verification', 'url_verification', 'unknown_mode']) {
      gateCalls = [];
      const input_data = mode === undefined ? {} : mode === 'url_verification'
        ? { mode, target_url: 'https://example.com/a' }
        : { mode };
      await chainingEngine.process(makeJob({ input_data }), {}, `req-gate-${mode}`);
      assert.equal(gateCalls.length, 1, `expected exactly one gate check for mode=${mode}`);
      assert.equal(gateCalls[0].requestId, `req-gate-${mode}`);
    }
  });

  test('no job is ever actually created or dispatched by these tests (stubs only record, never call through)', async () => {
    // Sanity check on the test harness itself: confirms the recording stubs
    // are truly in place, not accidentally falling through to the real
    // implementation (which would attempt real DB/dispatch calls and throw
    // in this no-DB-connection test run).
    await assert.doesNotReject(() =>
      chainingEngine.process(makeJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }), {}, 'req-8')
    );
  });

  // ── Failure cases ──

  test('null input_data does not throw and is treated as Full Audit', async () => {
    await assert.doesNotReject(() => chainingEngine.process(makeJob({ input_data: null }), {}, 'req-9'));
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });

  test('malformed input_data (a string, not an object) does not throw and is treated as Full Audit', async () => {
    await assert.doesNotReject(() => chainingEngine.process(makeJob({ input_data: 'not-an-object' }), {}, 'req-10'));
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });

  test('missing mode key (input_data present but no .mode) does not throw and is treated as Full Audit', async () => {
    await assert.doesNotReject(() => chainingEngine.process(makeJob({ input_data: { canonical_urls: ['https://example.com/'] } }), {}, 'req-11'));
    assert.deepEqual(dispatchCalls.sort(), [JOB_TYPES.AI_VISIBILITY, JOB_TYPES.CRAWL_GRAPH].sort());
  });
});

describe('chainingEngine.checkDependencyGate — mode-based gate branch selection (P1-003)', () => {
  // The REAL checkDependencyGate is exercised here (not stubbed) — only its
  // three DB dependencies (Job.findOne, JobGroup.findOne) and the terminal
  // job-creation call (_createAndDispatchJob) are replaced with recording
  // stubs, so this proves the actual widened branching logic, not a
  // reimplementation of it.

  let originalJobFindOne;
  let originalJobGroupFindOne;
  let originalCreateAndDispatch;
  let dispatchCalls;
  let jobGroupFindOneCalls;

  const PROJECT_ID = new mongoose.Types.ObjectId();
  const RUN_ID = new mongoose.Types.ObjectId();

  // docsByJobType maps a jobType to the document Job.findOne should return
  // for a query filtering on that jobType — covers every call site in
  // checkDependencyGate (existingAnalysis, pageScrapingJob, headlessA11y,
  // perfDesktop, and the final completedPageScraping re-fetch, which all
  // filter on exactly one jobType each).
  let docsByJobType;

  beforeEach(() => {
    dispatchCalls = [];
    jobGroupFindOneCalls = [];
    docsByJobType = {};

    originalJobFindOne = Job.findOne;
    originalJobGroupFindOne = JobGroup.findOne;
    originalCreateAndDispatch = chainingEngine._createAndDispatchJob;

    Job.findOne = async (filter) => docsByJobType[filter.jobType] ?? null;
    JobGroup.findOne = async (filter) => {
      jobGroupFindOneCalls.push(filter);
      return docsByJobType.__headlessGroup ?? null;
    };
    chainingEngine._createAndDispatchJob = async (nextJobType) => {
      dispatchCalls.push(nextJobType);
    };
  });

  afterEach(() => {
    Job.findOne = originalJobFindOne;
    JobGroup.findOne = originalJobGroupFindOne;
    chainingEngine._createAndDispatchJob = originalCreateAndDispatch;
  });

  function completedJobFor(jobType) {
    return { _id: new mongoose.Types.ObjectId(), project_id: PROJECT_ID, run_id: RUN_ID, jobType };
  }

  // ── url_verification takes the lightweight (verification) branch ──

  test('url_verification: gate opens on PAGE_SCRAPING completed + HEADLESS resolved, without ever consulting PERFORMANCE_DESKTOP', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null; // no existing analysis
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = {
      status: 'completed',
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = { status: 'completed' };
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = null; // must never be reached

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.HEADLESS_ACCESSIBILITY), 'req-gate-1');

    assert.deepEqual(dispatchCalls, [JOB_TYPES.PAGE_ANALYSIS]);
    assert.equal(jobGroupFindOneCalls.length, 0, 'the full-audit-only HEADLESS JobGroup check must not run for url_verification');
  });

  test('url_verification: HEADLESS_ACCESSIBILITY resolved via "failed" status still opens the gate (graceful degradation preserved)', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = {
      status: 'completed',
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = { status: 'failed' };

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-2');

    assert.deepEqual(dispatchCalls, [JOB_TYPES.PAGE_ANALYSIS]);
  });

  test('url_verification: gate stays closed while PAGE_SCRAPING is not yet completed', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = {
      status: 'processing',
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = { status: 'completed' };

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.HEADLESS_ACCESSIBILITY), 'req-gate-3');

    assert.deepEqual(dispatchCalls, []);
  });

  test('url_verification: gate stays closed while HEADLESS_ACCESSIBILITY is unresolved', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = {
      status: 'completed',
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = null; // not completed/failed yet

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-4');

    assert.deepEqual(dispatchCalls, []);
  });

  // ── Regression: legacy verification and Full Audit branches unchanged ──

  test('regression: legacy "verification" mode gate behavior unchanged', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = { status: 'completed', input_data: { mode: 'verification' } };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = { status: 'completed' };

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.HEADLESS_ACCESSIBILITY), 'req-gate-5');

    assert.deepEqual(dispatchCalls, [JOB_TYPES.PAGE_ANALYSIS]);
    assert.equal(jobGroupFindOneCalls.length, 0);
  });

  test('regression: Full Audit gate behavior unchanged — opens once PERFORMANCE_DESKTOP completed and HEADLESS group resolved', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = { status: 'completed', input_data: {} }; // no mode at all
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = { status: 'completed' };
    docsByJobType.__headlessGroup = { status: 'completed' };

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PERFORMANCE_DESKTOP), 'req-gate-6');

    assert.deepEqual(dispatchCalls, [JOB_TYPES.PAGE_ANALYSIS]);
    assert.equal(jobGroupFindOneCalls.length, 1, 'Full Audit must still consult the HEADLESS JobGroup');
  });

  test('regression: Full Audit gate stays closed when PERFORMANCE_DESKTOP does not exist yet', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = { status: 'completed', input_data: {} };
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = null;

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-7');

    assert.deepEqual(dispatchCalls, []);
  });

  test('existingAnalysis guard is unaffected by mode: gate no-ops immediately if PAGE_ANALYSIS already exists', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = { _id: new mongoose.Types.ObjectId(), status: 'pending' };
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = {
      status: 'completed',
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    };
    docsByJobType[JOB_TYPES.HEADLESS_ACCESSIBILITY] = { status: 'completed' };

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.HEADLESS_ACCESSIBILITY), 'req-gate-8');

    assert.deepEqual(dispatchCalls, []);
  });

  // ── Failure / edge cases ──

  test('an unrecognized mode value on the PAGE_SCRAPING job falls into the Full Audit branch, unchanged', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = { status: 'completed', input_data: { mode: 'some_future_mode' } };
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = null;

    await chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-9');

    // Full-audit branch reached (not verification) — and since
    // PERFORMANCE_DESKTOP doesn't exist, the gate correctly stays closed.
    assert.deepEqual(dispatchCalls, []);
  });

  test('pageScrapingJob not found at all (null) does not throw and falls into the Full Audit branch', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = null;
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = null;

    await assert.doesNotReject(() =>
      chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.HEADLESS_ACCESSIBILITY), 'req-gate-10')
    );
    assert.deepEqual(dispatchCalls, []);
  });

  test('pageScrapingJob.input_data is null (malformed) does not throw and falls into the Full Audit branch', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    docsByJobType[JOB_TYPES.PAGE_SCRAPING] = { status: 'completed', input_data: null };
    docsByJobType[JOB_TYPES.PERFORMANCE_DESKTOP] = null;

    await assert.doesNotReject(() =>
      chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-11')
    );
    assert.deepEqual(dispatchCalls, []);
  });

  test('a thrown error inside the gate is caught and never propagates (matches the existing try/catch contract)', async () => {
    docsByJobType[JOB_TYPES.PAGE_ANALYSIS] = null;
    Job.findOne = async (filter) => {
      if (filter.jobType === JOB_TYPES.PAGE_SCRAPING) throw new Error('simulated DB failure');
      return null;
    };

    await assert.doesNotReject(() =>
      chainingEngine.checkDependencyGate(completedJobFor(JOB_TYPES.PAGE_SCRAPING), 'req-gate-12')
    );
    assert.deepEqual(dispatchCalls, []);
  });
});
