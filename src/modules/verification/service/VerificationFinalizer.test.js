import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import PageVerificationRun from '../model/PageVerificationRun.js';
import Job from '../../jobs/model/Job.js';
import { VerificationFinalizer } from './VerificationFinalizer.js';

// P3-002: VerificationFinalizer.
//
// Needs a real MongoDB: it reads/writes PageVerificationRun via Mongoose and
// reads seo_page_scores/ai_scores via the raw driver — same live-Mongo
// auto-skip pattern established in Job.test.js / PageVerificationRun.test.js.

const finalizer = new VerificationFinalizer();

const PROJECT = new mongoose.Types.ObjectId();
const PAGE_URL = 'https://example.com/verification-finalizer-test';

function pendingRun(overrides = {}) {
  // M1: runId must be a real ObjectId string — VerificationFinalizer now
  // queries the Job model by run_id (an ObjectId field) to determine
  // AI_VISIBILITY's execution state, matching how runId is always minted in
  // production (urlVerificationService.js: new mongoose.Types.ObjectId()).
  return new PageVerificationRun({
    projectId: PROJECT,
    jobId: new mongoose.Types.ObjectId(),
    runId: new mongoose.Types.ObjectId().toString(),
    pageUrl: PAGE_URL,
    status: 'pending',
    startedAt: new Date(),
    before: {
      pageScore: 50,
      aisoScore: 40,
      aeoScore: 45,
      geoScore: 30,
      criticalIssues: 3,
      warningIssues: 2,
      infoIssues: 1,
    },
    ...overrides,
  });
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
  if (mongoAvailable) {
    await mongoose.connection.close();
  }
});

afterEach(async () => {
  if (mongoAvailable) {
    await PageVerificationRun.deleteMany({ projectId: PROJECT });
    await mongoose.connection.db.collection('seo_page_scores').deleteMany({ projectId: PROJECT });
    await mongoose.connection.db.collection('ai_scores').deleteMany({ project_id: PROJECT });
    await Job.deleteMany({ project_id: PROJECT });
  }
});

async function seedAfterData(t, { pageScore, high, medium, low, aiso, aeo, geo }) {
  await mongoose.connection.db.collection('seo_page_scores').insertOne({
    projectId: PROJECT,
    page_url: PAGE_URL,
    page_score: pageScore,
    high_issues_count: high,
    medium_issues_count: medium,
    low_issues_count: low,
  });
  await mongoose.connection.db.collection('ai_scores').insertOne({
    project_id: PROJECT,
    url: PAGE_URL,
    hubs: { aiso: { score: aiso }, aeo: { score: aeo }, geo: { score: geo } },
  });
}

// M1: VerificationFinalizer now determines AI_VISIBILITY's own execution
// state from the real Job document for this run_id (not from ai_scores'
// values) — every test that expects real AI scores to come through must
// seed a completed AI_VISIBILITY job for that run, matching a real pipeline.
async function seedAiVisibilityJob(runId, status) {
  return Job.create({
    user_id: new mongoose.Types.ObjectId(),
    project_id: PROJECT,
    jobType: 'AI_VISIBILITY',
    entityType: 'project',
    status,
    run_id: runId,
    input_data: { mode: 'url_verification', target_url: PAGE_URL },
  });
}

describe('VerificationFinalizer — completed verification (live Mongo, auto-skip)', () => {
  test('collects the after snapshot, computes delta, marks completed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 1, low: 1, aiso: 70, aeo: 65, geo: 50 });

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.status, 'completed');
    assert.ok(result.completedAt instanceof Date);
    assert.equal(result.errorMessage, null);
  });

  test('before snapshot is read from the persisted document, not re-queried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun({ before: { pageScore: 33, criticalIssues: 9 } }).save();
    // Seed CURRENT (after) data that differs from `before` — proves before
    // isn't silently overwritten by whatever the fresh query would return.
    await seedAfterData(t, { pageScore: 90, high: 0, medium: 0, low: 0, aiso: 90, aeo: 90, geo: 90 });

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.before.pageScore, 33);
    assert.equal(result.before.criticalIssues, 9);
    assert.equal(result.after.pageScore, 90);
    assert.equal(result.delta.pageScoreChange, 57);
  });

  test('after snapshot is read fresh from seo_page_scores and ai_scores', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 77, high: 1, medium: 2, low: 3, aiso: 61, aeo: 62, geo: 63 });
    await seedAiVisibilityJob(run.runId, 'completed');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.after.pageScore, 77);
    assert.equal(result.after.criticalIssues, 1);
    assert.equal(result.after.warningIssues, 2);
    assert.equal(result.after.infoIssues, 3);
    assert.equal(result.after.aisoScore, 61);
    assert.equal(result.after.aeoScore, 62);
    assert.equal(result.after.geoScore, 63);
  });

  test('delta is computed and persisted correctly end to end', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun({
      before: { pageScore: 50, aisoScore: 40, aeoScore: 45, geoScore: 30, criticalIssues: 3, warningIssues: 2, infoIssues: 1 },
    }).save();
    await seedAfterData(t, { pageScore: 80, high: 1, medium: 2, low: 1, aiso: 60, aeo: 55, geo: 40 });
    await seedAiVisibilityJob(run.runId, 'completed');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.delta.pageScoreChange, 30);
    assert.equal(result.delta.aisoScoreChange, 20);
    assert.equal(result.delta.aeoScoreChange, 10);
    assert.equal(result.delta.geoScoreChange, 10);
    // critical: 3->1 fixed 2, unchanged 1; warning: 2->2 unchanged 2; info: 1->1 unchanged 1
    assert.equal(result.delta.issuesFixed, 2);
    assert.equal(result.delta.issuesIntroduced, 0);
    assert.equal(result.delta.issuesUnchanged, 4);
  });

  test('missing after data (no seo_page_scores/ai_scores docs yet) is handled gracefully, not thrown', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    // No seedAfterData call — after-side collections have nothing for this page.

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.status, 'completed');
    assert.equal(result.after.pageScore, null);
    assert.equal(result.after.criticalIssues, 0);
    assert.equal(result.delta.pageScoreChange, null);
    assert.equal(result.delta.issuesFixed, 6); // all before-issues (3+2+1) resolved to 0 after
  });

  test('null before scores are preserved through to a null delta', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun({ before: { pageScore: null, aisoScore: null, criticalIssues: 0 } }).save();
    await seedAfterData(t, { pageScore: 70, high: 0, medium: 0, low: 0, aiso: 60, aeo: null, geo: null });

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.delta.pageScoreChange, null);
    assert.equal(result.delta.aisoScoreChange, null);
  });
});

describe('VerificationFinalizer — failed verification', () => {
  test('explicit failure outcome marks failed without touching after/delta', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 99, high: 0, medium: 0, low: 0, aiso: 99, aeo: 99, geo: 99 });

    const result = await finalizer.finalizeVerification(run.runId, {
      status: 'failed',
      errorMessage: 'worker timeout',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorMessage, 'worker timeout');
    assert.ok(result.completedAt instanceof Date);
    // after/delta were never populated — still at their empty schema defaults.
    assert.equal(result.after.pageScore, null);
    assert.equal(result.delta.pageScoreChange, null);
  });

  test('an internal error during collection is caught and persisted as a failure, not thrown', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();

    // Force an internal error inside the collection step, rather than the
    // externally-signaled failure path, to prove finalizeVerification's own
    // try/catch converts an unexpected exception into a persisted failure.
    const original = finalizer._collectAfterSnapshot;
    finalizer._collectAfterSnapshot = async () => {
      throw new Error('simulated DB failure while collecting after snapshot');
    };
    try {
      await assert.doesNotReject(() => finalizer.finalizeVerification(run.runId));
    } finally {
      finalizer._collectAfterSnapshot = original;
    }

    const persisted = await PageVerificationRun.findOne({ runId: run.runId });
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.errorMessage, 'simulated DB failure while collecting after snapshot');
    assert.equal(persisted.after.pageScore, null);
  });

  test('default errorMessage is used when none is provided with a failed outcome', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    const result = await finalizer.finalizeVerification(run.runId, { status: 'failed' });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorMessage, 'Verification failed');
  });
});

describe('VerificationFinalizer — idempotency and persistence correctness', () => {
  test('finalizing an already-completed run is a safe no-op (idempotent)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 70, aeo: 70, geo: 70 });

    const first = await finalizer.finalizeVerification(run.runId);
    const firstCompletedAt = first.completedAt.getTime();

    // Change the underlying data — if finalization re-ran, this would show up.
    await mongoose.connection.db.collection('seo_page_scores').updateOne(
      { projectId: PROJECT, page_url: PAGE_URL },
      { $set: { page_score: 10 } }
    );

    const second = await finalizer.finalizeVerification(run.runId);

    assert.equal(second.status, 'completed');
    assert.equal(second.after.pageScore, 80); // unchanged from first finalization
    assert.equal(second.completedAt.getTime(), firstCompletedAt);
  });

  test('finalizing an already-failed run is a safe no-op (idempotent)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    const first = await finalizer.finalizeVerification(run.runId, { status: 'failed', errorMessage: 'first failure' });
    const second = await finalizer.finalizeVerification(run.runId, { status: 'failed', errorMessage: 'second failure' });

    assert.equal(second.errorMessage, 'first failure');
  });

  test('persisted document is durably readable back from the database with correct shape', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 65, high: 1, medium: 1, low: 1, aiso: 55, aeo: 56, geo: 57 });
    await finalizer.finalizeVerification(run.runId);

    const reloaded = await PageVerificationRun.findOne({ runId: run.runId });
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.after.pageScore, 65);
    assert.equal(reloaded.delta.pageScoreChange, 15);
  });

  test('finalizing an unknown runId throws', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await assert.rejects(() => finalizer.finalizeVerification('does-not-exist'));
  });
});

describe('VerificationFinalizer — M1: explicit AI Visibility execution state', () => {
  test('AI success: a completed AI_VISIBILITY job persists aiVisibilityStatus=SUCCESS with real scores', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 70, aeo: 65, geo: 60 });
    await seedAiVisibilityJob(run.runId, 'completed');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.aiVisibilityStatus, 'SUCCESS');
    assert.equal(result.after.aisoScore, 70);
    assert.equal(result.after.aeoScore, 65);
    assert.equal(result.after.geoScore, 60);
  });

  test('graceful AI failure: a failed AI_VISIBILITY job persists aiVisibilityStatus=FAILED with AI scores nulled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    // seo_page_scores still succeeds (SEO_SCORING independent of AI_VISIBILITY).
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 999, aeo: 999, geo: 999 });
    await seedAiVisibilityJob(run.runId, 'failed');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.status, 'completed'); // the RUN still completes — graceful tolerance preserved
    assert.equal(result.aiVisibilityStatus, 'FAILED');
    assert.equal(result.after.pageScore, 80); // SEO side unaffected
    assert.equal(result.after.aisoScore, null);
    assert.equal(result.after.aeoScore, null);
    assert.equal(result.after.geoScore, null);
  });

  test('skipped AI: no AI_VISIBILITY job at all persists aiVisibilityStatus=SKIPPED with AI scores nulled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 999, aeo: 999, geo: 999 });
    // No seedAiVisibilityJob call — no AI_VISIBILITY job exists for this run.

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.aiVisibilityStatus, 'SKIPPED');
    assert.equal(result.after.aisoScore, null);
    assert.equal(result.after.aeoScore, null);
    assert.equal(result.after.geoScore, null);
  });

  test('stale ai_scores is never misreported as "no change": a FAILED AI stage nulls the after score even though ai_scores still holds an old value identical to before', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // before.aisoScore matches what's still sitting in ai_scores (leftover
    // from an earlier successful run) — if after wrongly read that stale
    // value, the delta would misreport "no AI change" instead of "unknown".
    const run = await pendingRun({ before: { aisoScore: 55, aeoScore: 60, geoScore: 65 } }).save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 55, aeo: 60, geo: 65 });
    await seedAiVisibilityJob(run.runId, 'failed');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.after.aisoScore, null);
    assert.equal(result.delta.aisoScoreChange, null); // NOT 0 — "unknown", not "no change"
    assert.equal(result.delta.aeoScoreChange, null);
    assert.equal(result.delta.geoScoreChange, null);
  });

  test('a job not yet resolved (defensive fallback) is treated as SKIPPED, not SUCCESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    await seedAfterData(t, { pageScore: 80, high: 0, medium: 0, low: 0, aiso: 70, aeo: 70, geo: 70 });
    await seedAiVisibilityJob(run.runId, 'processing');

    const result = await finalizer.finalizeVerification(run.runId);

    assert.equal(result.aiVisibilityStatus, 'SKIPPED');
    assert.equal(result.after.aisoScore, null);
  });

  test('backward compatibility: an explicit-failure outcome (run never reaches AI-status determination) leaves aiVisibilityStatus unset', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const run = await pendingRun().save();
    const result = await finalizer.finalizeVerification(run.runId, { status: 'failed', errorMessage: 'upstream job failed' });

    assert.equal(result.status, 'failed');
    assert.equal(result.aiVisibilityStatus, null);
  });
});
