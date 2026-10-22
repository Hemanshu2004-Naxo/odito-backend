import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Task from './model/Task.js';
import taskHistoryService from './service/TaskHistoryService.js';
import taskVerificationService from './service/TaskVerificationService.js';
import Recommendation from '../recommendations/model/Recommendation.js';

/**
 * Phase 3 — true end-to-end Optimization Center lifecycle test.
 *
 * Live Mongo, auto-skip if unreachable (same pattern as every other test in
 * this module). No mocking of internal logic: real Task model (including
 * the optimisticConcurrency fix), real TaskHistoryService.buildFixAttempt,
 * real Recommendation documents, real TaskVerificationService.
 * verifyImplementedTasks. The only thing not real is the external website
 * itself — its state is simulated by writing directly to seo_page_issues /
 * seo_page_data, exactly as the Python page-analysis pipeline would after a
 * real recrawl. This is the "controlled test database" boundary the task
 * asked for: mock only what genuinely can't be deterministic (an actual
 * HTTP crawl), keep everything internal to Odito real.
 *
 * Proves the full chain:
 *   issue detected -> task created -> BEFORE captured -> fix applied
 *   -> fixHistory attempt #1 -> real recrawl simulated -> verification
 *   -> AFTER captured independently -> VERIFIED_FIXED
 *   -> issue reappears -> verification -> REOPENED (attempt #1 preserved)
 *   -> fix applied again -> attempt #2 -> verification -> VERIFIED_FIXED again
 *   (both attempts intact, immutable, in one Task document)
 */

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

const PAGE_URL = 'https://example.com/lifecycle-e2e';
const ISSUE_KEY = 'meta_description_missing';

async function seedOpenIssue(projectId, { detectedValue = 'No meta description content' } = {}) {
  await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId, issue_code: ISSUE_KEY, page_url: PAGE_URL });
  await mongoose.connection.db.collection('seo_page_issues').insertOne({
    projectId,
    issue_code: ISSUE_KEY,
    page_url: PAGE_URL,
    status: 'open',
    dedup_key: `e2e-${projectId}-${ISSUE_KEY}`,
    data_path: 'meta_tags.description',
    detected_value: detectedValue,
    before_snapshot: { type: 'meta_description', metaDescription: null },
    first_detected_at: new Date(),
  });
}

async function markIssueResolved(projectId) {
  await mongoose.connection.db.collection('seo_page_issues').updateOne(
    { projectId, issue_code: ISSUE_KEY, page_url: PAGE_URL },
    { $set: { status: 'resolved', last_verified_at: new Date() }, $inc: { fix_count: 1 } }
  );
}

async function markIssueReopened(projectId) {
  await mongoose.connection.db.collection('seo_page_issues').updateOne(
    { projectId, issue_code: ISSUE_KEY, page_url: PAGE_URL },
    { $set: { status: 'open', last_verified_at: new Date() }, $inc: { regression_count: 1 } }
  );
}

async function setPageMetaDescription(projectId, text) {
  await mongoose.connection.db.collection('seo_page_data').updateOne(
    { projectId, url: PAGE_URL },
    {
      $set: {
        projectId, url: PAGE_URL,
        title: 'Example — Graphic Design & Video',
        meta_tags: { description: text ? [text] : [] },
        headings: [{ tag: 'h1', text: 'Graphic Design and Video Services' }],
        canonical: PAGE_URL,
        images: [],
      },
    },
    { upsert: true }
  );
}

async function createRecommendation(projectId, fingerprint, optimizedText) {
  return Recommendation.create({
    projectId,
    fingerprint,
    recommendationHash: `hash-${fingerprint}`,
    ruleId: ISSUE_KEY,
    issueCode: ISSUE_KEY,
    category: 'Content',
    pageUrl: PAGE_URL,
    sections: {
      whyThisMatters: 'Meta descriptions drive click-through rate from search results.',
      recommendedFix: 'Add a unique, compelling meta description under 160 characters.',
      implementationExample: { type: 'text', content: optimizedText },
      contentRewrite: { optimized: optimizedText },
    },
    generatedBy: 'claude',
  });
}

describe('Optimization Center — real lifecycle E2E (live Mongo)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await Recommendation.deleteMany({ projectId });
  });

  test('full lifecycle: detect -> fix -> verify -> reopen -> refix -> verify, with real independent BEFORE/AFTER and immutable history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // ── Phase 1: issue detected ────────────────────────────────────────
    await seedOpenIssue(projectId);

    // ── Phase 2: task created ──────────────────────────────────────────
    const task = await Task.create({
      projectId,
      issueKey: ISSUE_KEY,
      issueName: 'Meta Description Missing',
      issueCategory: 'Content',
      pageUrl: PAGE_URL,
      status: 'task_created',
      origin: 'ai_fix',
    });
    assert.equal(task.status, 'task_created');
    assert.equal(task.fixHistory.length, 0);

    // ── Phase 3: AI recommendation generated + applied (attempt #1) ────
    const optimizedV1 = 'Professional graphic design and video production services for growing brands.';
    const rec1 = await createRecommendation(projectId, 'e2e-fp-1', optimizedV1);

    const attempt1 = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: ISSUE_KEY, pageUrl: PAGE_URL, origin: 'ai_fix',
      recommendationId: rec1._id, attemptNumber: 1,
    });

    // BEFORE must reflect the state at detection time — real, not fake.
    assert.equal(attempt1.before.source, 'structured_snapshot');
    assert.deepEqual(attempt1.before.value, { type: 'meta_description', metaDescription: null });
    // FIX APPLIED must be the real recommendation content, frozen.
    assert.equal(attempt1.fixApplied.snapshot.contentRewrite.optimized, optimizedV1);
    assert.equal(attempt1.fixApplied.expectedAfterValue.metaDescription, optimizedV1);
    // Not yet verified.
    assert.equal(attempt1.verification.result, null);

    task.fixHistory.push(attempt1);
    task.status = 'implemented';
    task.implementedAt = attempt1.implementedAt;
    await task.save();

    // ── Phase 4: real recrawl simulated — issue resolves, page updated ─
    // Deliberately a DIFFERENT string (different capitalization) than what
    // the recommendation said, so a byte-identical copy from fixApplied
    // would FAIL this assertion — proves AFTER is independently resolved
    // from seo_page_data, not just copied from fixApplied.expectedAfterValue.
    const actualLiveTextV1 = 'PROFESSIONAL graphic design and video production services for growing brands.';
    await markIssueResolved(projectId);
    await setPageMetaDescription(projectId, actualLiveTextV1);

    const verifyResult1 = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-1', new mongoose.Types.ObjectId());

    assert.equal(verifyResult1.verified, 1);
    assert.equal(verifyResult1.reopened, 0);

    let reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'verified_fixed');
    assert.equal(reloaded.fixHistory.length, 1, 'still one attempt — verification fills in place, does not create a new one');

    const v1 = reloaded.fixHistory[0].verification;
    assert.equal(v1.method, 'value_diff', 'a real expected value was captured, so value-diff must be used, not presence fallback');
    assert.equal(v1.result, 'verified_fixed');
    assert.equal(v1.matched, true, 'case/whitespace-insensitive match against the live page text');
    // The critical negative-case-style assertion: AFTER is the ACTUAL live
    // text (different capitalization), not a copy of the fix's expected value.
    assert.equal(v1.after.value.metaDescription, actualLiveTextV1);
    assert.notEqual(v1.after.value.metaDescription, optimizedV1, 'AFTER must come from seo_page_data, not be a copy of fixApplied.expectedAfterValue');

    // Attempt #1's before/fixApplied must remain exactly as captured at
    // implement-time — verification only ever writes to .verification.
    assert.deepEqual(reloaded.fixHistory[0].before.value, { type: 'meta_description', metaDescription: null });
    assert.equal(reloaded.fixHistory[0].fixApplied.snapshot.contentRewrite.optimized, optimizedV1);

    // ── Idempotency: re-running verification with nothing changed must
    // re-confirm (verified_fixed tasks stay in scope — Phase 3) without
    // growing fixHistory — the "same result" branch refreshes in place.
    const verifyResultIdempotent = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-1B', new mongoose.Types.ObjectId());
    assert.equal(verifyResultIdempotent.verified, 1, 'verified_fixed tasks stay in scope and are re-confirmed, not skipped');
    const afterIdempotentCheck = await Task.findById(task._id);
    assert.equal(afterIdempotentCheck.fixHistory.length, 1, 'no duplicate/spurious history entry from a redundant verification pass with no change');

    // ── Phase 5: THE NEGATIVE CASE — issue regresses ────────────────────
    await markIssueReopened(projectId);
    await setPageMetaDescription(projectId, null); // meta description removed again

    const verifyResult2 = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-2', new mongoose.Types.ObjectId());
    assert.equal(verifyResult2.reopened, 1);
    assert.equal(verifyResult2.verified, 0);

    reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'reopened');
    assert.equal(reloaded.fixHistory.length, 2, 'a reverify_only entry is appended — attempt #1 already had a verification.result');

    // Attempt #1 must be COMPLETELY UNTOUCHED — this is the core immutability guarantee.
    const attempt1AfterRegression = reloaded.fixHistory[0];
    assert.equal(attempt1AfterRegression.verification.result, 'verified_fixed', 'attempt #1\'s original successful verification must never be overwritten');
    assert.equal(attempt1AfterRegression.verification.after.value.metaDescription, actualLiveTextV1);
    assert.equal(attempt1AfterRegression.fixApplied.snapshot.contentRewrite.optimized, optimizedV1);
    assert.deepEqual(attempt1AfterRegression.before.value, { type: 'meta_description', metaDescription: null });

    const reverifyEntry = reloaded.fixHistory[1];
    assert.equal(reverifyEntry.attemptKind, 'reverify_only');
    assert.equal(reverifyEntry.verification.result, 'reopened');
    assert.equal(reverifyEntry.fixApplied.snapshot, null, 'no new fix was applied in a reverify_only entry');

    // ── Phase 6: second real fix attempt ────────────────────────────────
    const optimizedV2 = 'Award-winning graphic design and video production for ambitious brands worldwide.';
    const rec2 = await createRecommendation(projectId, 'e2e-fp-2', optimizedV2);

    const attempt3 = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: ISSUE_KEY, pageUrl: PAGE_URL, origin: 'ai_fix',
      recommendationId: rec2._id, attemptNumber: reloaded.fixHistory.length + 1,
    });
    // BEFORE for this new attempt reflects the CURRENT (regressed) state,
    // not the original attempt's before-state.
    assert.equal(attempt3.before.source, 'structured_snapshot');
    assert.equal(attempt3.fixApplied.expectedAfterValue.metaDescription, optimizedV2);

    reloaded.fixHistory.push(attempt3);
    reloaded.status = 'implemented';
    reloaded.implementedAt = attempt3.implementedAt;
    await reloaded.save();

    assert.equal(reloaded.fixHistory.length, 3, 'attempt #3 (real fix_attempt) — attempt #1 and #2 (reverify_only) both preserved');

    // ── Phase 7: verify again — fixed a second time ─────────────────────
    await markIssueResolved(projectId);
    await setPageMetaDescription(projectId, optimizedV2);

    const verifyResult3 = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-3', new mongoose.Types.ObjectId());
    assert.equal(verifyResult3.verified, 1);

    const final = await Task.findById(task._id).lean();
    assert.equal(final.status, 'verified_fixed');
    assert.equal(final.fixHistory.length, 3, 'no attempts merged, none lost');

    // Every prior attempt's history remains exactly as it was.
    assert.equal(final.fixHistory[0].verification.result, 'verified_fixed');
    assert.equal(final.fixHistory[0].verification.after.value.metaDescription, actualLiveTextV1);
    assert.equal(final.fixHistory[1].verification.result, 'reopened');
    assert.equal(final.fixHistory[1].attemptKind, 'reverify_only');
    // The new attempt reflects the new fix, independently verified.
    assert.equal(final.fixHistory[2].verification.result, 'verified_fixed');
    assert.equal(final.fixHistory[2].verification.method, 'value_diff');
    assert.equal(final.fixHistory[2].verification.after.value.metaDescription, optimizedV2);
    assert.equal(final.fixHistory[2].fixApplied.snapshot.contentRewrite.optimized, optimizedV2);
  });

  test('negative case: fix API succeeds but the live page was never actually changed -> reopened, not falsely verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedOpenIssue(projectId);
    const task = await Task.create({
      projectId, issueKey: ISSUE_KEY, issueName: 'Meta Description Missing',
      issueCategory: 'Content', pageUrl: PAGE_URL, status: 'task_created', origin: 'ai_fix',
    });

    const rec = await createRecommendation(projectId, 'e2e-fp-negative', 'A description that was recommended but never actually applied.');
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: ISSUE_KEY, pageUrl: PAGE_URL, origin: 'ai_fix',
      recommendationId: rec._id, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    // The "fix" was recorded, but the real website was never actually
    // updated — the issue is still open and the page still has no
    // description. The system must not report success just because a
    // recommendation exists and a task was marked implemented.
    // (seo_page_issues stays 'open', seo_page_data stays empty — no calls
    // to markIssueResolved/setPageMetaDescription.)

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-NEG', new mongoose.Types.ObjectId());
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'reopened', 'must NOT be verified_fixed merely because a fix was applied and a recommendation existed');
    assert.equal(reloaded.fixHistory[0].verification.result, 'reopened');
  });

  test('presence_fallback: an issue type with no captured expected value still verifies correctly via presence/absence, honestly labeled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // A rule outside the 5 structured-snapshot types (no before_snapshot,
    // no expectedAfterValue is ever derivable) — e.g. an accessibility issue.
    const issueKey = 'form_labels';
    const pageUrl = 'https://example.com/presence-fallback';
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: issueKey, page_url: pageUrl, status: 'open',
      dedup_key: `e2e-presence-${projectId}`, detected_value: 'Form input missing associated label',
      first_detected_at: new Date(),
    });

    const task = await Task.create({
      projectId, issueKey, issueName: 'Form Labels Missing', issueCategory: 'Accessibility',
      pageUrl, status: 'implemented', origin: 'diy_guide',
      fixHistory: [await taskHistoryService.buildFixAttempt({
        projectId, issueKey, pageUrl, origin: 'diy_guide', recommendationId: null, attemptNumber: 1,
      })],
    });
    assert.equal(task.fixHistory[0].fixApplied.expectedAfterValue, null, 'no structured expected value exists for this issue type');

    // Real recrawl: the issue is no longer detected (resolved).
    await mongoose.connection.db.collection('seo_page_issues').updateOne(
      { projectId, issue_code: issueKey, page_url: pageUrl },
      { $set: { status: 'resolved' } }
    );

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-PRESENCE', new mongoose.Types.ObjectId());
    assert.equal(result.verified, 1);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'verified_fixed');
    assert.equal(reloaded.fixHistory[0].verification.method, 'presence_fallback', 'honestly labeled — no expected value was ever available to value-diff against');
    assert.equal(reloaded.fixHistory[0].verification.matched, null, 'matched is meaningless for presence_fallback and must not be fabricated as true');
  });

  test('legacy task (no fixHistory) is verified via scalar status only, without crashing or fabricating history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Simulates a pre-Phase-1 Task document — created without ever going
    // through TaskHistoryService, so fixHistory is the schema default ([]).
    const legacyTask = await Task.create({
      projectId, issueKey: ISSUE_KEY, issueName: 'Meta Description Missing',
      issueCategory: 'Content', pageUrl: PAGE_URL, status: 'implemented', origin: 'manual',
    });
    assert.equal(legacyTask.fixHistory.length, 0);

    await markIssueResolved(projectId); // issue not present -> should verify

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'E2E-LEGACY', new mongoose.Types.ObjectId());
    assert.equal(result.verified, 1);

    const reloaded = await Task.findById(legacyTask._id);
    assert.equal(reloaded.status, 'verified_fixed');
    assert.equal(reloaded.fixHistory.length, 0, 'no fabricated history for a legacy task — stays empty, exactly what historyAvailable:false surfaces to the UI');
  });
});
