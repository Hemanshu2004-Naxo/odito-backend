import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { storeHeadlessReport } from '../jobs/service/headlessReportService.js';
import IssueContextEngine from './service/IssueContextEngine.js';
import recommendationService from '../recommendations/service/recommendationService.js';
import Recommendation from '../recommendations/model/Recommendation.js';
import taskHistoryService from '../tasks/service/TaskHistoryService.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import Task from '../tasks/model/Task.js';
import { createTask, updateTaskStatus } from '../tasks/controller/taskController.js';
import { AuthUtil } from '../../utils/AuthUtil.js';
import { mock } from 'node:test';

/**
 * The whole accessibility chain on REAL data, against real Mongo:
 *
 *   real audit of https://naxonify.com/  ->  production write path (storeHeadlessReport)
 *   -> IssueContextEngine (HeadlessExtractor + AccessibilityResolver)
 *   -> recommendationService (deterministic, element-level)
 *   -> task before/after state  ->  TaskVerificationService re-test
 *
 * The chain was broken at three joints before: the worker's element data was dropped by the
 * schema, HeadlessExtractor queried a field that does not exist (so the resolver always saw
 * null), and the model was given one diagnostic sentence. Auto-skips without Mongo.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_AUDIT = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/naxonify-home-keyboard-audit.json'), 'utf8'));
const URL = 'https://naxonify.com/';
const projectId = new mongoose.Types.ObjectId();
const jobId = new mongoose.Types.ObjectId();

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => {
  if (!mongoAvailable) return;
  const db = mongoose.connection.db;
  for (const c of ['seo_headless_data', 'seo_page_data', 'seo_page_issues']) await db.collection(c).deleteMany({ projectId });
  await Recommendation.deleteMany({ projectId });
  await Task.deleteMany({ projectId });
  await mongoose.connection.close();
});

const store = (url, keyboard_analysis) => storeHeadlessReport({
  projectId, seo_jobId: jobId,
  results: [{ url, render_status: 'success', statusCode: 200, keyboard_analysis, scannedAt: new Date().toISOString() }],
});
const db = () => mongoose.connection.db;
const ruleMeta = { category: 'Accessibility', severity: 'high', title: 'Keyboard accessibility' };

/** The same audit AFTER the site owner applied the fix: every element now shows an indicator. */
function fixedAudit(testedAt) {
  const audit = JSON.parse(JSON.stringify(REAL_AUDIT));
  audit.tested_at = testedAt;
  audit.missing_focus_outline = 0;
  audit.affected_elements.missing_focus_indicator = [];
  audit.affected_elements.missing_focus_indicator_total = 0;
  audit.element_results = audit.element_results.map((r) => ({ ...r, status: 'present' }));
  return audit;
}

describe('accessibility pipeline on the real Naxonify audit', () => {
  test('IssueContextEngine now sees the audit (HeadlessExtractor used to return null) and lists the 40 exact elements', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await db().collection('seo_page_data').insertOne({ projectId, url: URL, page_context: { cms: 'WordPress' }, cms: 'WordPress' });
    await store(URL, REAL_AUDIT);

    const ctx = await IssueContextEngine.resolve(projectId.toString(), 'keyboard_accessibility', URL);
    const audit = ctx.accessibilityAudit;

    assert.equal(audit.available, true);
    assert.equal(audit.findings[0].type, 'missing_focus_indicator');
    assert.equal(audit.findings[0].count, 40);
    assert.equal(audit.findings[0].elements.length, 40);
    assert.equal(audit.technology.kind, 'wordpress-divi');

    assert.equal(ctx.currentState.displayType, 'table');
    assert.equal(ctx.currentState.affectedItems.length, 40, 'the generic current-state view lists the 40 elements, not one diagnostic sentence');
    assert.equal(ctx.currentState.isAbsent, false);
    assert.match(ctx.currentState.affectedItems[0].Selector, /et_pb_menu__logo/);
  });

  test('a legacy (counts-only) audit resolves as "outdated", with no fabricated elements', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const legacyUrl = 'https://naxonify.com/legacy-page';
    await store(legacyUrl, { keyboard_navigation_checked: true, focus_trap_detected: true, missing_focus_outline: 10, total_tab_presses: 10, focus_order: [{ tag: 'a', id: '', selector: 'a' }] });
    const ctx = await IssueContextEngine.resolve(projectId.toString(), 'keyboard_accessibility', legacyUrl);
    assert.equal(ctx.accessibilityAudit.available, false);
    assert.equal(ctx.accessibilityAudit.reason, 'legacy_audit');
    assert.deepEqual(ctx.accessibilityAudit.findings, []);
  });

  test('recommendationService produces an element-level recommendation — not "No implementation example available"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await recommendationService.getOrGenerate({ projectId: projectId.toString(), issueId: 'keyboard_accessibility', pageUrl: URL, issueSource: 'on_page', ruleMetadata: ruleMeta });
    const sections = result.recommendation.sections;

    assert.equal(result.source, 'template');
    assert.match(sections.recommendedFix, /40 keyboard-focusable elements \(of 44 tested/);
    assert.match(sections.recommendedFix, /Divi → Theme Options → Custom CSS/);
    assert.equal(sections.implementationExample.type, 'css');
    assert.match(sections.implementationExample.content, /a:focus-visible,\nbutton:focus-visible/);
    assert.doesNotMatch(JSON.stringify(sections), /No implementation example available/);

    const stored = await Recommendation.findOne({ projectId, ruleId: 'keyboard_accessibility' }).lean();
    assert.equal(stored.sections.afterState.expect.focusIndicatorVisibleOn.length, 40);
    assert.equal(stored.sections.sourceAttribution.contextSources.llmUsed, false);
  });

  test('a legacy page gets a precise refusal (409), and nothing is stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await assert.rejects(
      () => recommendationService.getOrGenerate({ projectId: projectId.toString(), issueId: 'keyboard_accessibility', pageUrl: 'https://naxonify.com/legacy-page', issueSource: 'on_page', ruleMetadata: ruleMeta }),
      (e) => e.code === 'ACCESSIBILITY_AUDIT_OUTDATED' && e.statusCode === 409 && e.userFacing === true && /Re-run the accessibility audit/.test(e.message)
    );
    assert.equal(await Recommendation.countDocuments({ projectId, pageUrl: 'https://naxonify.com/legacy-page' }), 0);
  });

  test('a page with no audit at all is refused with the missing information named', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await assert.rejects(
      () => recommendationService.getOrGenerate({ projectId: projectId.toString(), issueId: 'keyboard_accessibility', pageUrl: 'https://naxonify.com/never-audited', issueSource: 'on_page', ruleMetadata: ruleMeta }),
      (e) => e.code === 'ACCESSIBILITY_AUDIT_UNAVAILABLE'
    );
  });

  test('caller-supplied issueContext cannot smuggle in elements — the server\'s own audit is used', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await recommendationService.getOrGenerate({
      projectId: projectId.toString(), issueId: 'keyboard_accessibility', pageUrl: URL, issueSource: 'on_page', ruleMetadata: ruleMeta,
      issueContext: { accessibilityAudit: { available: true, findings: [{ type: 'missing_focus_indicator', count: 1, elements: [{ selector: '#injected', tag: 'a' }] }] } },
    });
    assert.doesNotMatch(JSON.stringify(result.recommendation.sections), /#injected/);
  });
});

describe('a task keeps the affected elements and is verified by re-testing them', () => {
  let recommendation;

  async function taskWithAttempt() {
    recommendation = await Recommendation.findOne({ projectId, ruleId: 'keyboard_accessibility', pageUrl: URL }).lean();
    // The issue document as the Python rule writes it (one of the page's several keyboard findings).
    await db().collection('seo_page_issues').insertOne({
      projectId, issue_code: 'keyboard_accessibility', page_url: URL, status: 'open', data_path: 'keyboard_analysis.missing_focus_outline',
      before_snapshot: { type: 'keyboard_accessibility', finding: 'missing_focus_indicator', count: 40, elements: [{ selector: 'only-one-of-three-findings' }] },
      dedup_key: `kb-${projectId}`,
    });
    const attempt = await taskHistoryService.buildFixAttempt({
      projectId, issueKey: 'keyboard_accessibility', pageUrl: URL, origin: 'ai_fix', recommendationId: recommendation._id, attemptNumber: 1,
    });
    return { attempt, task: await Task.create({ projectId, issueKey: 'keyboard_accessibility', pageUrl: URL, status: 'implemented', origin: 'ai_fix', recommendationId: recommendation._id, fixHistory: [attempt] }) };
  }

  test('createTask context: before-state carries ALL findings\' elements, and the expected-after lists the exact selectors', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { attempt } = await taskWithAttempt();

    assert.equal(attempt.before.source, 'structured_snapshot');
    assert.equal(attempt.before.value.type, 'keyboard_accessibility');
    assert.equal(attempt.before.value.findings[0].elements.length, 40, 'the task did not lose the affected elements (nor use the single issue doc\'s partial snapshot)');
    assert.notEqual(attempt.before.value.elements?.[0]?.selector, 'only-one-of-three-findings');

    const expected = attempt.fixApplied.expectedAfterValue;
    assert.equal(expected.type, 'keyboard_accessibility');
    assert.equal(expected.selectors.length, 40);
    assert.equal(expected.requireNoUnintendedTrap, false);
    assert.ok(expected.notBefore, 'only an audit run after the fix can confirm it');

    assert.equal(attempt.fixApplied.snapshot.beforeState.findings[0].elements.length, 40);
    assert.equal(attempt.fixApplied.snapshot.afterState.expect.focusIndicatorVisibleOn.length, 40);
    assert.match(attempt.fixApplied.snapshot.recommendedFix, /Divi/);
    assert.equal(attempt.origin, 'ai_fix');
  });

  test('verification: nothing changed on the site (elements still fail, issue still open) -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await Task.findOne({ projectId, issueKey: 'keyboard_accessibility' });
    // A re-crawl AFTER the fix attempt that still shows the original failures.
    const later = { ...REAL_AUDIT, tested_at: new Date(Date.now() + 5000).toISOString() };
    await store(URL, later);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'KB-NOFIX');
    assert.equal(result.reopened, 1);
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
  });

  test('verification: the issue DISAPPEARED but a targeted element still has no indicator -> reopened, never verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await db().collection('seo_page_issues').deleteMany({ projectId });                 // the rule no longer fires...
    const partial = fixedAudit(new Date(Date.now() + 10_000).toISOString());
    partial.element_results[3].status = 'missing';                                       // ...but one target is still bare
    partial.affected_elements.missing_focus_indicator_total = 1;
    await store(URL, partial);
    await Task.updateMany({ projectId }, { $set: { status: 'implemented' } });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'KB-PARTIAL');
    assert.equal(result.reopened, 1);
    const saved = await Task.findOne({ projectId, issueKey: 'keyboard_accessibility' });
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(saved.status, 'reopened');
    assert.equal(latest.verification.matched, false);
    assert.equal(latest.verification.method, 'value_diff');
  });

  test('verification: every targeted element now shows a visible indicator in a fresh audit -> verified_fixed via value_diff', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await store(URL, fixedAudit(new Date(Date.now() + 20_000).toISOString()));
    await Task.updateMany({ projectId }, { $set: { status: 'implemented' } });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'KB-FIXED');
    assert.equal(result.verified, 1);
    const saved = await Task.findOne({ projectId, issueKey: 'keyboard_accessibility' });
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(saved.status, 'verified_fixed');
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
    assert.equal(latest.verification.after.value.auditable, true);
  });

  test('verification: an audit that predates the fix cannot verify it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await store(URL, fixedAudit('2020-01-01T00:00:00Z'));
    await Task.updateMany({ projectId }, { $set: { status: 'implemented' } });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'KB-STALE');
    assert.equal(result.reopened, 1, 'a stale "all good" audit is not evidence');
  });
});

describe('Create Task keeps the affected elements on the task itself (no recommendation needed)', () => {
  const fakeRes = () => {
    const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
    return res;
  };
  const OTHER = 'https://naxonify.com/about-naxonify';

  test('createTask (no recommendation yet) freezes the element-level before/after state from the server\'s own audit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await store(OTHER, REAL_AUDIT);
    mock.method(AuthUtil, 'validateProjectAccess', async () => true);
    try {
      const res = fakeRes();
      await createTask({
        user: { _id: new mongoose.Types.ObjectId() },
        body: { projectId: projectId.toString(), issueKey: 'keyboard_accessibility', pageUrl: OTHER, issueName: 'Keyboard accessibility', origin: 'ai_fix', status: 'task_created',
                // a hostile client tries to smuggle in its own "elements":
                issueContext: { beforeState: { findings: [{ elements: [{ selector: '#injected' }] }] } } },
      }, res);

      assert.equal(res.statusCode, 201);
      const saved = await Task.findById(res.body.data._id).lean();
      assert.equal(saved.recommendationId, null);
      assert.equal(saved.issueContext.type, 'keyboard_accessibility');
      assert.equal(saved.issueContext.beforeState.findings[0].elements.length, 40);
      assert.equal(saved.issueContext.afterState.expect.focusIndicatorVisibleOn.length, 40);
      assert.equal(saved.issueContext.technology, 'WordPress · Divi');
      assert.doesNotMatch(JSON.stringify(saved.issueContext), /#injected/, 'the request body never supplies the elements');
      assert.equal(saved.pageUrl, OTHER);
      assert.equal(saved.issueKey, 'keyboard_accessibility');
    } finally {
      mock.restoreAll();
    }
  });

  test('marking it implemented later builds the fix attempt from that frozen context — no recommendation exists', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(AuthUtil, 'validateProjectAccess', async () => true);
    try {
      const task = await Task.findOne({ projectId, pageUrl: OTHER });
      const res = fakeRes();
      await updateTaskStatus({ params: { taskId: task._id.toString() }, body: { status: 'implemented' }, user: { _id: new mongoose.Types.ObjectId() } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));

      const saved = await Task.findById(task._id).lean();
      const attempt = saved.fixHistory[0];
      assert.equal(attempt.before.source, 'structured_snapshot');
      assert.equal(attempt.before.value.findings[0].elements.length, 40);
      assert.equal(attempt.fixApplied.expectedAfterValue.type, 'keyboard_accessibility');
      assert.equal(attempt.fixApplied.expectedAfterValue.selectors.length, 40);
      assert.ok(attempt.fixApplied.expectedAfterValue.notBefore);
    } finally {
      mock.restoreAll();
    }
  });

  test('...and the next fresh audit verifies it, again without any recommendation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await store(OTHER, fixedAudit(new Date(Date.now() + 30_000).toISOString()));
    await db().collection('seo_page_issues').deleteMany({ projectId, page_url: OTHER });
    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'KB-CTX');
    assert.ok(result.verified >= 1);
    const saved = await Task.findOne({ projectId, pageUrl: OTHER });
    assert.equal(saved.status, 'verified_fixed');
    assert.equal(saved.fixHistory[0].verification.method, 'value_diff');
  });

  test('an issue type that is not element-level gets no issueContext (nothing changes for it)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(AuthUtil, 'validateProjectAccess', async () => true);
    try {
      const res = fakeRes();
      await createTask({ user: { _id: new mongoose.Types.ObjectId() }, body: { projectId: projectId.toString(), issueKey: 'title_missing', pageUrl: 'https://naxonify.com/x', status: 'task_created' } }, res);
      assert.equal(res.statusCode, 201);
      assert.equal((await Task.findById(res.body.data._id).lean()).issueContext, null);
    } finally {
      mock.restoreAll();
    }
  });

  test('a page with no audit: the task is still created, with no context (never blocked)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(AuthUtil, 'validateProjectAccess', async () => true);
    try {
      const res = fakeRes();
      await createTask({ user: { _id: new mongoose.Types.ObjectId() }, body: { projectId: projectId.toString(), issueKey: 'keyboard_accessibility', pageUrl: 'https://naxonify.com/never-audited-2', status: 'task_created' } }, res);
      assert.equal(res.statusCode, 201);
      assert.equal((await Task.findById(res.body.data._id).lean()).issueContext, null);
    } finally {
      mock.restoreAll();
    }
  });
});
