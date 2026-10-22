import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Task from './model/Task.js';
import taskHistoryService from './service/TaskHistoryService.js';
import taskVerificationService from './service/TaskVerificationService.js';

/**
 * Phase 5 — AI Visibility V2 Task Verification, real lifecycle E2E.
 *
 * Live Mongo, auto-skip if unreachable (same pattern as
 * optimizationLifecycle.e2e.test.js). Real Task model, real
 * TaskHistoryService.buildFixAttempt, real TaskVerificationService.
 * verifyImplementedTasks — nothing mocked. The V2 AI-visibility pipeline
 * itself (python_workers/scraper/workers/ai_v2) is simulated by writing
 * directly to ai_issues / ai_scores in the exact shape issue_engine.py /
 * scorer.py actually produce (verified field-for-field against that code,
 * not guessed): project_id/url/rule_id/hub/card/issue_title/
 * issue_description/severity on ai_issues, project_id/url/scored_at on
 * ai_scores.
 *
 * Covers the Phase 5 test matrix:
 *   1. AI issue present -> task's real BEFORE captured from ai_issues
 *   2. issue disappears + fresh score -> verified_fixed
 *   3. issue remains + fresh score -> reopened, never falsely verified
 *   4. previously verified_fixed task regresses -> reopened, history immutable
 *   5. reopened task fixed again -> verified_fixed, full history preserved
 *   6. concurrent verification -> loser errors, no duplicate history
 *   7. idempotent re-verification with no change -> no fixHistory growth
 *   8. AI score never recomputed since the fix -> safely skipped, not guessed
 *   9. legacy AI-visibility task (no fixHistory) -> scalar-only, no fabrication
 *  10. project_id scoping -> another project's identical url+rule_id can't leak in
 *  11. AFTER snapshot reflects real ai_issues presence/absence, not a copy of BEFORE
 *  12. on-page (non-AI) verification is completely unaffected by this branch
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

const AI_PAGE_URL = 'https://example.com/ai-visibility-e2e';
const AI_ISSUE_KEY = 'AISO-001';

async function seedAiIssue(projectId, { ruleId = AI_ISSUE_KEY, url = AI_PAGE_URL, overrides = {} } = {}) {
  await mongoose.connection.db.collection('ai_issues').deleteMany({ project_id: projectId, url, rule_id: ruleId });
  await mongoose.connection.db.collection('ai_issues').insertOne({
    project_id: projectId,
    job_id: new mongoose.Types.ObjectId(),
    page_id: new mongoose.Types.ObjectId(),
    score_id: new mongoose.Types.ObjectId(),
    url,
    scope: 'page',
    rule_id: ruleId,
    hub: 'AISO',
    card: 'crawlability',
    severity: 'high',
    issue_title: 'Missing llms.txt directive',
    issue_description: 'No llms.txt file found at the site root.',
    recommendation: 'Add an llms.txt file.',
    expected_impact: 'medium',
    evidence: { path: '/llms.txt' },
    created_at: new Date(),
    version: 'v2',
    ...overrides,
  });
}

async function removeAiIssue(projectId, { ruleId = AI_ISSUE_KEY, url = AI_PAGE_URL } = {}) {
  await mongoose.connection.db.collection('ai_issues').deleteMany({ project_id: projectId, url, rule_id: ruleId });
}

async function seedAiScore(projectId, scoredAt, { url = AI_PAGE_URL } = {}) {
  await mongoose.connection.db.collection('ai_scores').updateOne(
    { project_id: projectId, url },
    {
      $set: {
        project_id: projectId,
        job_id: new mongoose.Types.ObjectId(),
        page_id: new mongoose.Types.ObjectId(),
        url,
        version: 'v2',
        scored_at: scoredAt,
        hubs: {},
        summary: { total_rules: 10, total_passed: 9, total_failed: 1, total_skipped: 0, overall_pass_rate: 90 },
      },
    },
    { upsert: true }
  );
}

async function createAiTask(projectId, { status = 'task_created', issueKey = AI_ISSUE_KEY, url = AI_PAGE_URL } = {}) {
  return Task.create({
    projectId,
    issueKey,
    issueName: 'Missing llms.txt directive',
    issueCategory: 'AI Visibility',
    pageUrl: url,
    status,
    origin: 'ai_fix',
  });
}

describe('AI Visibility V2 Task Verification — real lifecycle E2E (live Mongo)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('ai_issues').deleteMany({ project_id: projectId });
    await mongoose.connection.db.collection('ai_scores').deleteMany({ project_id: projectId });
  });

  test('1. AI issue present in ai_issues -> real BEFORE captured (not fabricated, not from seo_page_issues)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);

    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });

    assert.equal(attempt.before.source, 'structured_snapshot');
    assert.equal(attempt.before.value.type, 'ai_visibility_issue');
    assert.equal(attempt.before.value.ruleId, AI_ISSUE_KEY);
    assert.equal(attempt.before.value.hub, 'AISO');
    assert.equal(attempt.before.value.title, 'Missing llms.txt directive');
    assert.equal(attempt.before.value.issuePresent, true);
  });

  test('2. issue disappears from ai_issues + AI score recomputed after the fix -> verified_fixed via ai_visibility_issue_lifecycle', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    // Fix applied -> next V2 analysis run resolves the issue and re-scores the page.
    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-2', new mongoose.Types.ObjectId());
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);
    assert.equal(result.skipped, 0);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'verified_fixed');
    assert.equal(reloaded.fixHistory[0].verification.method, 'ai_visibility_issue_lifecycle');
    assert.equal(reloaded.fixHistory[0].verification.result, 'verified_fixed');
    assert.equal(reloaded.fixHistory[0].verification.after.value.issuePresent, false);
  });

  test('3. issue remains present + AI score recomputed after the fix -> reopened, never falsely verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    // Fix was marked implemented, but the underlying page still fails the rule.
    await seedAiScore(projectId, new Date(Date.now() + 1000)); // ai_issues doc untouched -> still present

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-3', new mongoose.Types.ObjectId());
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'reopened', 'must NOT be verified_fixed merely because the task was marked implemented');
    assert.equal(reloaded.fixHistory[0].verification.result, 'reopened');
    assert.equal(reloaded.fixHistory[0].verification.after.value.issuePresent, true);
  });

  test('4 & 5. full AI-visibility lifecycle: verified_fixed -> regresses -> reopened (immutable) -> refix -> verified_fixed again', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt1 = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt1);
    task.status = 'implemented';
    task.implementedAt = attempt1.implementedAt;
    await task.save();

    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    const r1 = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-4A', new mongoose.Types.ObjectId());
    assert.equal(r1.verified, 1);

    let reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'verified_fixed');
    assert.equal(reloaded.fixHistory.length, 1);

    // Regression: the issue reappears (e.g. a later content change reintroduced it),
    // and a fresh analysis run re-scores the page after that.
    await seedAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 2000));

    const r2 = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-4B', new mongoose.Types.ObjectId());
    assert.equal(r2.reopened, 1);

    reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'reopened');
    assert.equal(reloaded.fixHistory.length, 2, 'a reverify_only entry is appended — attempt #1 already had a verification.result');

    // Attempt #1's own verification record must be untouched by the regression.
    assert.equal(reloaded.fixHistory[0].verification.result, 'verified_fixed');
    assert.equal(reloaded.fixHistory[0].verification.after.value.issuePresent, false);
    assert.equal(reloaded.fixHistory[1].attemptKind, 'reverify_only');
    assert.equal(reloaded.fixHistory[1].verification.result, 'reopened');

    // Re-implement (attempt #2) and fix for real this time.
    const attempt2 = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: reloaded.fixHistory.length + 1,
    });
    reloaded.fixHistory.push(attempt2);
    reloaded.status = 'implemented';
    reloaded.implementedAt = attempt2.implementedAt;
    await reloaded.save();

    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 3000));

    const r3 = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-5', new mongoose.Types.ObjectId());
    assert.equal(r3.verified, 1);

    const final = await Task.findById(task._id).lean();
    assert.equal(final.status, 'verified_fixed');
    assert.equal(final.fixHistory.length, 3, 'no attempts merged, none lost');
    assert.equal(final.fixHistory[2].verification.result, 'verified_fixed');
    assert.equal(final.fixHistory[2].verification.method, 'ai_visibility_issue_lifecycle');
  });

  test('6. concurrent verification passes on the same AI-visibility task -> loser errors, no duplicate history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    // Two verification passes racing over the same task, as a full-project
    // recrawl and a single-URL re-verification completing at nearly the same
    // time would produce (see TaskVerificationService's own docstring).
    const [a, b] = await Promise.allSettled([
      taskVerificationService.verifyImplementedTasks(projectId, 'AIV-6A', new mongoose.Types.ObjectId()),
      taskVerificationService.verifyImplementedTasks(projectId, 'AIV-6B', new mongoose.Types.ObjectId()),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'fulfilled');

    // One of the two passes' internal try/catch absorbs the VersionError as
    // a "skipped" outcome — across both calls exactly one task-level result
    // (verified) was actually recorded, never two.
    const totalVerified = a.value.verified + b.value.verified;
    const totalSkipped = a.value.skipped + b.value.skipped;
    assert.equal(totalVerified, 1, 'exactly one of the two racing passes wins');
    assert.equal(totalSkipped, 1, 'the loser is recorded as skipped (race), not a silent double-write');

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.fixHistory.length, 1, 'no duplicate history entry from the losing race');
  });

  test('7. idempotent re-verification with no change -> no fixHistory growth', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    const r1 = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-7A', new mongoose.Types.ObjectId());
    assert.equal(r1.verified, 1);

    // A second verification pass runs later (e.g. a routine recrawl) with
    // nothing having changed at all — same ai_issues/ai_scores state.
    const r2 = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-7B', new mongoose.Types.ObjectId());
    assert.equal(r2.verified, 1, 'verified_fixed AI-visibility tasks stay in scope and are re-confirmed');

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.fixHistory.length, 1, 'same result -> refreshed in place, not appended');
  });

  test('8. AI score never recomputed since the fix -> verification safely skipped, task left untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId);
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    // The fix was applied, but no fresh V2 analysis has run since (no
    // ai_scores doc at all — never scored). Removing the issue here would be
    // fabricating a result, since nothing has actually re-examined the page.
    await removeAiIssue(projectId);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-8', new mongoose.Types.ObjectId());
    assert.equal(result.verified, 0);
    assert.equal(result.reopened, 0);
    assert.equal(result.skipped, 1);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'implemented', 'left completely untouched — no guessed verified_fixed or reopened');
    assert.equal(reloaded.fixHistory[0].verification.result, null);
  });

  test('8b. AI score exists but predates the fix -> verification safely skipped (stale, not trusted)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // A score was computed BEFORE the fix was implemented (e.g. the last
    // full audit ran, then the user applied the fix afterward) — that score
    // says nothing about whether the fix actually worked.
    await seedAiScore(projectId, new Date(Date.now() - 60_000));
    await seedAiIssue(projectId);

    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = new Date(); // implemented AFTER the only known score
    await task.save();

    await removeAiIssue(projectId); // even though the issue is now gone, the score predates the fix

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-8B', new mongoose.Types.ObjectId());
    assert.equal(result.skipped, 1);
    assert.equal(result.verified, 0);

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'implemented');
  });

  test('9. legacy AI-visibility task (no fixHistory) -> scalar-only skip when no fresh score exists, no fabricated history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Simulates a Task created before TaskHistoryService existed (or a
    // manually-created one) — fixHistory is the schema default ([]).
    const legacyTask = await createAiTask(projectId, { status: 'implemented' });
    assert.equal(legacyTask.fixHistory.length, 0);

    // No ai_scores doc at all for this URL.
    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-9', new mongoose.Types.ObjectId());
    assert.equal(result.skipped, 1);
    assert.equal(result.verified, 0);
    assert.equal(result.reopened, 0);

    const reloaded = await Task.findById(legacyTask._id);
    assert.equal(reloaded.status, 'implemented', 'no false verified_fixed fabricated for a legacy task with no fresh data');
    assert.equal(reloaded.fixHistory.length, 0, 'no history fabricated for a task that never had any');
  });

  test('10. project_id scoping — another project\'s identical url+rule_id cannot leak into this project\'s verification', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const otherProjectId = new mongoose.Types.ObjectId();

    // This project's task: fix applied, but the issue is STILL open here.
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();
    await seedAiIssue(projectId); // issue still open in THIS project
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    // Another project, same url + rule_id, issue is RESOLVED there — must
    // have zero influence on this project's task.
    await seedAiIssue(otherProjectId);
    await removeAiIssue(otherProjectId);
    await seedAiScore(otherProjectId, new Date(Date.now() + 1000));

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-10', new mongoose.Types.ObjectId());
    assert.equal(result.reopened, 1, 'this project\'s still-open issue must win — the other project\'s resolved state must not leak in');

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.status, 'reopened');

    await Task.deleteMany({ projectId: otherProjectId });
    await mongoose.connection.db.collection('ai_issues').deleteMany({ project_id: otherProjectId });
    await mongoose.connection.db.collection('ai_scores').deleteMany({ project_id: otherProjectId });
  });

  test('11. AFTER snapshot reflects the real current ai_issues presence/absence, not a copy of BEFORE or a guess', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await seedAiIssue(projectId, { overrides: { issue_title: 'ORIGINAL before-fix title' } });
    const task = await createAiTask(projectId);
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: AI_ISSUE_KEY, pageUrl: AI_PAGE_URL, origin: 'ai_fix',
      recommendationId: null, attemptNumber: 1,
    });
    assert.equal(attempt.before.value.title, 'ORIGINAL before-fix title');

    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    await task.save();

    await removeAiIssue(projectId);
    await seedAiScore(projectId, new Date(Date.now() + 1000));

    await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-11', new mongoose.Types.ObjectId());

    const reloaded = await Task.findById(task._id);
    const after = reloaded.fixHistory[0].verification.after;
    assert.equal(after.source, 'structured_snapshot');
    assert.equal(after.value.type, 'ai_visibility_issue');
    assert.equal(after.value.issuePresent, false, 'AFTER reflects the real current (absent) state');
    // BEFORE must remain exactly as captured at implement-time — verification never rewrites it.
    assert.equal(reloaded.fixHistory[0].before.value.title, 'ORIGINAL before-fix title');
  });

  test('12. on-page (non-AI) task verification is completely unaffected by the AI-visibility branch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const onPageUrl = 'https://example.com/on-page-regression-guard';
    const onPageIssueKey = 'meta_description_missing';

    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId, issue_code: onPageIssueKey, page_url: onPageUrl });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: onPageIssueKey, page_url: onPageUrl, status: 'open',
      dedup_key: `aiv-regress-${projectId}`, detected_value: 'No meta description content',
      first_detected_at: new Date(),
    });

    const onPageTask = await Task.create({
      projectId, issueKey: onPageIssueKey, issueName: 'Meta Description Missing',
      issueCategory: 'Content', pageUrl: onPageUrl, status: 'implemented', origin: 'manual',
    });

    // An unrelated AI-visibility task in the SAME project, in an unresolved
    // state — its presence must not change how the on-page task resolves.
    await seedAiIssue(projectId);
    await createAiTask(projectId, { status: 'implemented' });

    // On-page issue resolves via the existing seo_page_issues path.
    await mongoose.connection.db.collection('seo_page_issues').updateOne(
      { projectId, issue_code: onPageIssueKey, page_url: onPageUrl },
      { $set: { status: 'resolved' } }
    );

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'AIV-12', new mongoose.Types.ObjectId());

    const reloadedOnPage = await Task.findById(onPageTask._id);
    assert.equal(reloadedOnPage.status, 'verified_fixed', 'on-page presence_fallback path resolves exactly as before Phase 5');
    assert.equal(reloadedOnPage.fixHistory.length, 0, 'legacy task shape (no fixHistory) still handled correctly alongside an AI-visibility task in the same batch');

    // Sanity: the AI task in the same batch was correctly skipped (no fresh score), not counted as a false verify.
    assert.ok(result.skipped >= 1);

    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId, issue_code: onPageIssueKey, page_url: onPageUrl });
  });
});
