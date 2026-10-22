import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';

// Live-Mongo, auto-skip if unreachable — same pattern as
// chainingEngine.p3-006-events.test.js. Covers the Optimization Center
// workflow fix: REOPENED tasks must now be re-checked (and can resolve to
// VERIFIED_FIXED) the same way IMPLEMENTED tasks already were — previously
// this service only ever queried status:'implemented', so a REOPENED task
// could never be automatically verified again without the user manually
// re-implementing it first.

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

describe('TaskVerificationService.verifyImplementedTasks — reopened tasks', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  test('a reopened task whose issue is gone resolves to verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/fixed-page',
      status: 'reopened',
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'verified_fixed');
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);
  });

  test('a reopened task whose issue still exists stays reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/still-broken',
      status: 'reopened',
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId,
      issue_code: 'missing-alt-text',
      page_url: 'https://example.com/still-broken',
      status: 'open',
      dedup_key: `test-dedup-still-broken-${projectId}`,
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'reopened');
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);
  });

  test('P3-002: a resolved issue document is ignored — task resolves to verified_fixed, not reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/fixed-page',
      status: 'implemented',
    });
    // A stale/historical issue document that PAGE_ANALYSIS has already
    // reconciled to resolved — must NOT be treated as "still open" just
    // because a document for this issueKey+url still exists.
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId,
      issue_code: 'missing-alt-text',
      page_url: 'https://example.com/fixed-page',
      status: 'resolved',
      dedup_key: `test-dedup-fixed-page-${projectId}`,
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'verified_fixed');
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);
  });

  test('task_created is left untouched — never implemented, nothing to verify', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const created = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/not-started',
      status: 'task_created',
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    assert.equal((await Task.findById(created._id)).status, 'task_created');
    assert.equal(result.verified, 0);
    assert.equal(result.reopened, 0);
  });

  // Phase 3: verified_fixed tasks are no longer excluded from re-verification
  // (see verifyImplementedTasks' scope comment) — a regression on an
  // already-verified issue must be detectable. This test covers the "nothing
  // changed" half of that: still counted/re-confirmed, but its status and
  // fixHistory length stay stable when the underlying issue really is still
  // fixed (the "issue reappears" half is covered by the E2E lifecycle test).
  test('an already verified_fixed task with no regression is re-confirmed, not left out of scope', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const fixed = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/already-verified',
      status: 'verified_fixed',
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    assert.equal((await Task.findById(fixed._id)).status, 'verified_fixed');
    assert.equal(result.verified, 1, 'verified_fixed tasks are now included in scope and re-confirmed on every pass');
    assert.equal(result.reopened, 0);
  });
});

// Concurrent verification safety (Phase 3 hardening). Reproduces a real bug
// found via a live-Mongo probe: two verification passes (e.g. a full-audit
// run and a URL-verification run racing, or a retried job overlapping a
// first attempt) can load the SAME Task before either writes. Mongoose's
// default versioning only version-checks *array* modifications it judges
// ambiguous — a plain nested-path update (mutating an existing
// fixHistory[i].verification.* field in place, the common "fill in place"
// case) was NOT version-checked, so the second save silently overwrote the
// first with no error — one verification result permanently lost, no trace
// in the logs. `Task.js`'s `optimisticConcurrency: true` schema option
// (added as the fix) forces a real `{_id,__v}` check on every save
// regardless of what changed, so the loser now throws a `VersionError`
// instead — already handled by verifyImplementedTasks' existing per-task
// try/catch (counted as `skipped`, logged, batch continues).
describe('TaskVerificationService — concurrent verification safety', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
  });

  test('two concurrent "fill in place" verification writes: loser errors instead of silently clobbering the winner', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const created = await Task.create({
      projectId,
      issueKey: 'meta_description_too_long',
      pageUrl: 'https://example.com/concurrent-a',
      status: 'implemented',
      origin: 'manual',
      fixHistory: [{
        attemptNumber: 1,
        attemptKind: 'fix_attempt',
        origin: 'manual',
        status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: null },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    // Two independent loads — simulates two overlapping verification passes
    // that both read before either writes.
    const docA = await Task.findById(created._id);
    const docB = await Task.findById(created._id);

    taskVerificationService._recordVerification(docA, docA.fixHistory[0], {
      now: new Date(), method: 'presence_fallback', result: 'verified_fixed', matched: null,
      afterSnapshot: { source: 'unavailable', value: null }, triggerJobId: null,
    });
    docA.status = 'verified_fixed';

    taskVerificationService._recordVerification(docB, docB.fixHistory[0], {
      now: new Date(), method: 'presence_fallback', result: 'reopened', matched: null,
      afterSnapshot: { source: 'unavailable', value: null }, triggerJobId: null,
    });
    docB.status = 'reopened';

    const results = await Promise.allSettled([docA.save(), docB.save()]);
    const outcomes = results.map((r) => r.status);
    // Exactly one must win and one must lose — never both silently "fulfilled"
    // (that would mean the race went undetected, the original bug).
    assert.deepEqual(outcomes.sort(), ['fulfilled', 'rejected']);
    const loser = results.find((r) => r.status === 'rejected');
    assert.equal(loser.reason.name, 'VersionError');

    // No matter which one won, fixHistory must still have exactly 1 entry
    // (no duplicate/partial write) and the DB must reflect a single
    // consistent verification result, not a merge of both.
    const final = await Task.findById(created._id).lean();
    assert.equal(final.fixHistory.length, 1);
    assert.ok(['verified_fixed', 'reopened'].includes(final.status));
    assert.equal(final.fixHistory[0].verification.result, final.status);
  });

  test('two concurrent verification passes that both observe a real transition: loser errors instead of creating a duplicate history entry', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Seeded as 'reopened' — both concurrent passes below independently
    // observe the issue is now fixed (a real result CHANGE, reopened ->
    // verified_fixed), which is exactly the case _recordVerification must
    // append a new reverify_only entry for (not the same-result-refresh
    // branch, which is covered by the "fill in place" test above).
    const created = await Task.create({
      projectId,
      issueKey: 'meta_description_too_long',
      pageUrl: 'https://example.com/concurrent-b',
      status: 'reopened',
      origin: 'manual',
      fixHistory: [{
        attemptNumber: 1,
        attemptKind: 'fix_attempt',
        origin: 'manual',
        status: 'reopened',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: null },
        implementedAt: new Date(),
        // Already has a verification.result of 'reopened' — the next verify
        // pass observing 'verified_fixed' must APPEND a reverify_only entry,
        // not mutate this one in place.
        verification: { verifiedAt: new Date(), method: 'presence_fallback', result: 'reopened', matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const docA = await Task.findById(created._id);
    const docB = await Task.findById(created._id);

    taskVerificationService._recordVerification(docA, docA.fixHistory[0], {
      now: new Date(), method: 'presence_fallback', result: 'verified_fixed', matched: null,
      afterSnapshot: { source: 'unavailable', value: null }, triggerJobId: new mongoose.Types.ObjectId(),
    });
    docA.status = 'verified_fixed';

    taskVerificationService._recordVerification(docB, docB.fixHistory[0], {
      now: new Date(), method: 'presence_fallback', result: 'verified_fixed', matched: null,
      afterSnapshot: { source: 'unavailable', value: null }, triggerJobId: new mongoose.Types.ObjectId(),
    });
    docB.status = 'verified_fixed';

    const results = await Promise.allSettled([docA.save(), docB.save()]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.name, 'VersionError');

    // The bug this reproduces: without optimisticConcurrency, BOTH pushes
    // landed and fixHistory grew to 3 entries from one logical verification
    // event. Must stay at exactly 2 (attempt #1 + one new reverify_only).
    const final = await Task.findById(created._id).lean();
    assert.equal(final.fixHistory.length, 2);
    assert.equal(final.fixHistory[0].verification.result, 'reopened', 'attempt #1 must remain untouched');
  });

  test('a re-confirmation of the SAME result (nothing changed) refreshes in place instead of growing fixHistory — bounds growth now that verified_fixed tasks stay in scope forever', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const created = await Task.create({
      projectId,
      issueKey: 'meta_description_too_long',
      pageUrl: 'https://example.com/reconfirm',
      status: 'verified_fixed',
      origin: 'manual',
      fixHistory: [{
        attemptNumber: 1,
        attemptKind: 'fix_attempt',
        origin: 'manual',
        status: 'verified_fixed',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: null },
        implementedAt: new Date(),
        verification: { verifiedAt: new Date('2026-01-01'), method: 'presence_fallback', result: 'verified_fixed', matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'RECONFIRM');
    assert.equal(result.verified, 1);

    const final = await Task.findById(created._id).lean();
    assert.equal(final.fixHistory.length, 1, 'a routine re-check with no change must not grow fixHistory');
    assert.ok(final.fixHistory[0].verification.verifiedAt > new Date('2026-01-01'), 'the existing record IS refreshed with the new check timestamp');
  });
});

// Phase 3 verification audit — proves the valueNormalization.js fix (curly
// quotes / trailing slashes) through the REAL verifyImplementedTasks() path,
// not just the isolated utility (see valueNormalization.test.js for that).
describe('TaskVerificationService — value_diff normalization (WordPress round-trip realism)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  test('title verifies via value_diff despite WordPress rendering a curly apostrophe where the recommendation used a straight one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-title';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      // As BeautifulSoup would extract it after WordPress's wptexturize
      // rendered a straight apostrophe as a curly one.
      title: 'Company’s Best Widgets',
    });

    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          // The AI-recommended value, plain ASCII apostrophe.
          expectedAfterValue: { type: 'title', title: "Company's Best Widgets" },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-TITLE');
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('canonical verifies via value_diff despite WordPress adding a trailing slash the recommendation did not include', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-canonical';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      canonical: 'https://example.com/normalization-canonical/',
    });

    const task = await Task.create({
      projectId, issueKey: 'canonical_tag_errors', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'canonical', canonical: 'https://example.com/normalization-canonical' },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-CANONICAL');
    assert.equal(result.verified, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('a genuinely incorrect after-value: presence (issue still open) drives reopened, AND value_diff correctly reports matched:false — normalization never masks a real content mismatch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Per TaskVerificationService's own documented design ("presence always
    // wins for 'still reopened' — value-diff only refines HOW CONFIDENTLY a
    // verified_fixed result is reported"), an issue still open in
    // seo_page_issues drives `reopened` regardless of value_diff — this test
    // confirms that stays true AND that value_diff's own matched flag is
    // correctly false (not accidentally folded into a match by the new
    // normalization), giving two independent, correct signals rather than
    // one masking the other.
    const pageUrl = 'https://example.com/normalization-mismatch';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl, title: 'Completely Different Title',
    });
    // dedup_key must be explicitly set and unique — seo_page_issues has a
    // GLOBAL unique index on it (not scoped by projectId), so an omitted
    // (null) value collides with any other test's leftover null-key
    // document across the whole shared dev database, not just this run's
    // own projectId-scoped cleanup. Matches the existing tests above
    // (lines ~76/~104) — missed here in the first pass, causing a real
    // E11000 collision against test residue from an earlier run.
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: 'title_missing', page_url: pageUrl, status: 'open',
      dedup_key: `test-dedup-normalization-mismatch-${projectId}`,
    });

    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'title', title: 'The Recommended Title' },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-MISMATCH');
    assert.equal(result.reopened, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, false);
  });

  test('robots verifies via value_diff when the crawler sees a real rendered <meta name="robots"> with no restriction, even though it spells out "index, follow" explicitly rather than omitting the tag', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // meta_tags.robots is an array of raw content-attribute strings (same
    // convention as meta_tags.description) — [0] is what a real theme
    // rendered, which may spell out "index, follow" explicitly rather than
    // omitting the tag when there's no restriction.
    const pageUrl = 'https://example.com/normalization-robots-fixed';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl, meta_tags: { robots: ['index, follow'] },
    });

    const task = await Task.create({
      projectId, issueKey: 'noindex_key_pages', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'robots', index: true, follow: true },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-ROBOTS-FIXED');
    assert.equal(result.verified, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('robots: a page still rendering noindex is reopened, and value_diff correctly reports matched:false', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-robots-still-noindex';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl, meta_tags: { robots: ['noindex, follow'] },
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: 'noindex_key_pages', page_url: pageUrl, status: 'open',
      dedup_key: `test-dedup-normalization-robots-still-noindex-${projectId}`,
    });

    const task = await Task.create({
      projectId, issueKey: 'noindex_key_pages', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'robots', index: true, follow: true },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-ROBOTS-STILL-NOINDEX');
    assert.equal(result.reopened, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, false);
  });

  test('same_as verifies via value_diff once the crawler sees the added URL in the rendered Organization schema sameAs list', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-sameas-fixed';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [
        { '@type': 'Organization', name: 'Example', sameAs: ['https://twitter.com/example', 'https://linkedin.com/company/example'] },
      ],
    });

    const task = await Task.create({
      projectId, issueKey: 'sameas_array', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'same_as', url: 'https://linkedin.com/company/example' },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-SAMEAS-FIXED');
    assert.equal(result.verified, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('same_as: the URL is genuinely absent from the rendered schema, reopened with matched:false', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-sameas-missing';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [ { '@type': 'Organization', name: 'Example', sameAs: ['https://twitter.com/example'] } ],
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: 'sameas_array', page_url: pageUrl, status: 'open',
      dedup_key: `test-dedup-normalization-sameas-missing-${projectId}`,
    });

    const task = await Task.create({
      projectId, issueKey: 'sameas_array', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'same_as', url: 'https://linkedin.com/company/example' },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-SAMEAS-MISSING');
    assert.equal(result.reopened, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, false);
  });

  test('breadcrumb verifies via value_diff once the crawler sees a rendered BreadcrumbList entity', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-breadcrumb-fixed';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      // A real, valid trail ending at this page. (This fixture used to be an EMPTY BreadcrumbList,
      // which "verified" a fix that renders nothing — schema tasks are now judged on the markup itself.)
      structured_data: [ { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, name: 'Fixed', item: pageUrl },
      ] } ],
    });

    const task = await Task.create({
      projectId, issueKey: 'breadcrumblist_schema', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'breadcrumb', enabled: true },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-BREADCRUMB-FIXED');
    assert.equal(result.verified, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('breadcrumb: a rendered but EMPTY BreadcrumbList is not a fix -> reopened with the reason recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-breadcrumb-empty';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [ { '@type': 'BreadcrumbList', itemListElement: [] } ],
    });

    const task = await Task.create({
      projectId, issueKey: 'breadcrumblist_schema', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'breadcrumb', enabled: true },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-BREADCRUMB-EMPTY');
    assert.equal(result.verified, 0);
    assert.equal(result.reopened, 1);
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.matched, false);
    assert.match(latest.verification.after.value.reasons.join(' '), /empty_list|at least|1 item|0 item/);
  });

  test('breadcrumb: still absent from rendered schema, reopened with matched:false', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/normalization-breadcrumb-missing';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl, structured_data: [],
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: 'breadcrumblist_schema', page_url: pageUrl, status: 'open',
      dedup_key: `test-dedup-normalization-breadcrumb-missing-${projectId}`,
    });

    const task = await Task.create({
      projectId, issueKey: 'breadcrumblist_schema', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'breadcrumb', enabled: true },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'NORM-BREADCRUMB-MISSING');
    assert.equal(result.reopened, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, false);
  });
});
