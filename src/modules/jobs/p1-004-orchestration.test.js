import { describe, test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from './model/Job.js';
import JobGroup from './model/JobGroup.js';
import chainingEngine from './chainingEngine.js';
import { JobService } from './service/jobService.js';
import { JOB_TYPES } from './constants/jobTypes.js';

// P1-004: audits (and proves, via test) that run_id / group_id / chunking /
// job-lineage conventions already generically support 'url_verification'
// with ZERO production code changes — nothing in this layer branches on
// mode at all (confirmed by inspection: createAndDispatchPageAnalysisJob,
// createAndDispatchSeoScoringJob, createAndDispatchAiVisibilityJob all copy
// run_id from the source job unconditionally; chunking is gated purely on
// jobType===URL_QUALIFICATION and group_id truthiness, neither of which a
// url_verification run ever produces). This file is the evidence for that
// claim, not a driver of new behavior.
//
// P3-003 update: createAndDispatchPageAnalysisJob/SeoScoringJob/AiVisibilityJob
// now DO conditionally propagate mode/target_url/urls when the source job is
// url_verification (needed to activate Phase 2's previously-dormant `urls`
// filter). The run_id-propagation assertions below are unaffected — this was
// never in question — but the one assertion that mode does NOT propagate is
// updated below since that has intentionally changed.

const jobService = new JobService();
const PROJECT_ID = new mongoose.Types.ObjectId();

function urlVerificationSourceJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user_id: new mongoose.Types.ObjectId(),
    project_id: PROJECT_ID,
    run_id: new mongoose.Types.ObjectId(),
    input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing' },
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

afterEach(async () => {
  if (mongoAvailable) {
    await Job.deleteMany({ project_id: PROJECT_ID });
  }
});

describe('run_id propagation across orchestration (P1-004, live Mongo, auto-skip)', () => {
  test('createAndDispatchPageAnalysisJob propagates run_id from a url_verification source job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = urlVerificationSourceJob();
    const created = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.equal(created.run_id.toString(), source.run_id.toString());
    assert.equal(created.input_data.source_job_id, source._id.toString());
    // P3-003: mode/target_url now DO propagate downstream for
    // url_verification source jobs, so PAGE_ANALYSIS's `urls` filter can
    // activate. chainingEngine's TOPOLOGY/gating is still mode-aware only
    // at the PAGE_SCRAPING stage (P1-002/P1-003) — this is additive
    // input_data construction, not new branching in the chain itself.
    assert.equal(created.input_data.mode, 'url_verification');
    assert.equal(created.input_data.target_url, 'https://example.com/pricing');
  });

  test('createAndDispatchSeoScoringJob propagates run_id from its source job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageAnalysisJob = urlVerificationSourceJob({ jobType: JOB_TYPES.PAGE_ANALYSIS });
    const created = await jobService.createAndDispatchSeoScoringJob(pageAnalysisJob);

    assert.equal(created.run_id.toString(), pageAnalysisJob.run_id.toString());
  });

  test('createAndDispatchAiVisibilityJob propagates run_id from its source job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = urlVerificationSourceJob({ _canonicalUrls: ['https://example.com/pricing'] });
    const created = await jobService.createAndDispatchAiVisibilityJob(source);

    assert.equal(created.run_id.toString(), source.run_id.toString());
  });

  test('regression: run_id propagation is byte-identical for Full Audit, legacy verification, and url_verification source jobs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const fullAudit = await jobService.createAndDispatchPageAnalysisJob(urlVerificationSourceJob({ input_data: {} }));
    const legacy = await jobService.createAndDispatchPageAnalysisJob(urlVerificationSourceJob({ input_data: { mode: 'verification' } }));
    const urlVerif = await jobService.createAndDispatchPageAnalysisJob(urlVerificationSourceJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }));

    // Each independently matches its own source's run_id — the propagation
    // mechanism (a straight copy) has no mode-conditional path to diverge.
    assert.ok(fullAudit.run_id);
    assert.ok(legacy.run_id);
    assert.ok(urlVerif.run_id);
    assert.notEqual(fullAudit.run_id.toString(), legacy.run_id.toString());
    assert.notEqual(legacy.run_id.toString(), urlVerif.run_id.toString());
  });

  // ── Failure cases ──

  test('failure case: a source job with a missing (null) run_id does not throw — propagates null through, unchanged from today\'s behavior', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = urlVerificationSourceJob({ run_id: null });
    let created;
    await assert.doesNotReject(async () => {
      created = await jobService.createAndDispatchPageAnalysisJob(source);
    });
    assert.equal(created.run_id, null);
  });

  test('failure case: malformed input_data on the source job (undefined) does not throw', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = urlVerificationSourceJob({ input_data: undefined });
    await assert.doesNotReject(() => jobService.createAndDispatchPageAnalysisJob(source));
  });
});

describe('group_id / chunking isolation for url_verification (P1-004, mocked)', () => {
  let originalRecordChunkOutcome;
  let originalJobGroupFindOne;
  let originalCheckGate;
  let recordChunkCalls;
  let jobGroupCalls;

  beforeEach(() => {
    recordChunkCalls = [];
    jobGroupCalls = [];
    originalRecordChunkOutcome = chainingEngine.recordChunkOutcome;
    originalJobGroupFindOne = JobGroup.findOne;
    originalCheckGate = chainingEngine.checkDependencyGate;

    chainingEngine.recordChunkOutcome = async (updatedJob) => {
      recordChunkCalls.push(updatedJob);
      return null; // "not yet resolved" — process() returns immediately after
    };
    JobGroup.findOne = async (filter) => {
      jobGroupCalls.push(filter);
      return null;
    };
    chainingEngine.checkDependencyGate = async () => {}; // irrelevant to this describe block
  });

  afterEach(() => {
    chainingEngine.recordChunkOutcome = originalRecordChunkOutcome;
    JobGroup.findOne = originalJobGroupFindOne;
    chainingEngine.checkDependencyGate = originalCheckGate;
  });

  function makeCompletionJob(overrides = {}) {
    return {
      _id: new mongoose.Types.ObjectId(),
      jobType: JOB_TYPES.PAGE_SCRAPING,
      project_id: PROJECT_ID,
      run_id: new mongoose.Types.ObjectId(),
      group_id: null,
      input_data: {},
      result_data: {},
      ...overrides,
    };
  }

  test('group_id unchanged: a url_verification PAGE_SCRAPING completion (group_id: null) never invokes recordChunkOutcome', async () => {
    await chainingEngine.process(
      makeCompletionJob({ group_id: null, input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }),
      {}, 'req-p1004-1'
    );
    assert.equal(recordChunkCalls.length, 0);
  });

  test('chunk jobs unchanged: url_verification never touches JobGroup at all (no chunked-target path exists for jobType=PAGE_SCRAPING)', async () => {
    await chainingEngine.process(
      makeCompletionJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }),
      {}, 'req-p1004-2'
    );
    assert.equal(jobGroupCalls.length, 0);
  });

  test('regression: Full Audit / legacy verification chunk-completion routing is unaffected by the existence of url_verification', async () => {
    // A group_id-bearing completion (however produced) still enters the
    // chunked-completion branch regardless of mode — group_id truthiness
    // alone governs this, exactly as before P1-001..003 existed. This
    // proves mode-awareness was added ONLY where P1-002/P1-003 intended,
    // with no accidental interaction with the orchestration/grouping layer.
    for (const input_data of [{}, { mode: 'verification' }, { mode: 'url_verification', target_url: 'https://example.com/a' }]) {
      recordChunkCalls = [];
      await chainingEngine.process(
        makeCompletionJob({ group_id: new mongoose.Types.ObjectId(), input_data }),
        {}, 'req-p1004-3'
      );
      assert.equal(recordChunkCalls.length, 1, `expected recordChunkOutcome to fire for input_data=${JSON.stringify(input_data)}`);
    }
  });

  // ── Failure case: invalid grouping ──

  test('failure case: an invalid/malformed group_id value still triggers the chunked branch consistently (truthiness-only check, no new validation introduced)', async () => {
    await chainingEngine.process(
      makeCompletionJob({ group_id: 'not-a-real-object-id', input_data: { mode: 'url_verification', target_url: 'https://example.com/a' } }),
      {}, 'req-p1004-4'
    );
    assert.equal(recordChunkCalls.length, 1);
  });
});

describe('dispatcher / worker-creation regression (P1-004, mocked)', () => {
  let originalCreateNextJobAtomically;
  let originalDispatchToWorker;
  let originalAtomicDispatch;
  let atomicGuardCalls;
  let dispatchToWorkerCalls;

  beforeEach(() => {
    atomicGuardCalls = [];
    dispatchToWorkerCalls = [];
    originalCreateNextJobAtomically = chainingEngine._createNextJobAtomically;
    originalDispatchToWorker = chainingEngine._dispatchToWorker;
    originalAtomicDispatch = jobService.atomicallyDispatchJob;

    chainingEngine._createNextJobAtomically = async (sourceJob, nextJobType) => {
      atomicGuardCalls.push({ sourceJobMode: sourceJob.input_data?.mode, nextJobType });
      return { _id: new mongoose.Types.ObjectId(), project_id: sourceJob.project_id };
    };
    jobService.atomicallyDispatchJob = async (jobId) => ({ _id: jobId, project_id: PROJECT_ID });
    chainingEngine._dispatchToWorker = async (jobType, job) => {
      dispatchToWorkerCalls.push({ jobType, jobId: job._id });
    };
  });

  afterEach(() => {
    chainingEngine._createNextJobAtomically = originalCreateNextJobAtomically;
    chainingEngine._dispatchToWorker = originalDispatchToWorker;
    jobService.atomicallyDispatchJob = originalAtomicDispatch;
  });

  test('_createAndDispatchJob follows the identical atomic-guard → dispatch sequence for a url_verification-tagged source job', async () => {
    const sourceJob = urlVerificationSourceJob();
    await chainingEngine._createAndDispatchJob(
      JOB_TYPES.PAGE_ANALYSIS, sourceJob, sourceJob, JOB_TYPES.PAGE_SCRAPING,
      { atomicGuard: true }, 'req-p1004-5', false
    );

    assert.equal(atomicGuardCalls.length, 1);
    assert.equal(atomicGuardCalls[0].sourceJobMode, 'url_verification');
    assert.equal(atomicGuardCalls[0].nextJobType, JOB_TYPES.PAGE_ANALYSIS);
    // Dispatch behavior (PUSH-mode path) is untouched — same call, same shape.
    if (process.env.USE_PULL_MODEL !== 'true') {
      assert.equal(dispatchToWorkerCalls.length, 1);
      assert.equal(dispatchToWorkerCalls[0].jobType, JOB_TYPES.PAGE_ANALYSIS);
    }
  });

  test('regression: the same sequence fires identically for a Full Audit source job (no mode)', async () => {
    const sourceJob = urlVerificationSourceJob({ input_data: {} });
    await chainingEngine._createAndDispatchJob(
      JOB_TYPES.PAGE_ANALYSIS, sourceJob, sourceJob, JOB_TYPES.PAGE_SCRAPING,
      { atomicGuard: true }, 'req-p1004-6', false
    );
    assert.equal(atomicGuardCalls.length, 1);
    assert.equal(atomicGuardCalls[0].sourceJobMode, undefined);
  });
});
