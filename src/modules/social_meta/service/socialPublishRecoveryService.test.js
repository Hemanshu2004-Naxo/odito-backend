import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import metaApiService from './metaApiService.js';
import { recoverStalePublications, reconcileUnknownOutcomes, markMissedPublications } from './socialPublishRecoveryService.js';
import { executeDuePublications } from './socialPublishingService.js';
import { ensureProject, removeProject } from '../testSupport/projectFixture.js';

/**
 * Stale-lock recovery + unknown-outcome reconciliation (P0 #3, #5, #8):
 * what happens to a post left in 'publishing' by a PM2 restart / crash / OOM
 * / failed DB save, and to a publish whose response was lost. Real MongoDB,
 * real adapters + classifier; only the Graph HTTP layer is replaced.
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
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const MIN = 60_000;
const NOW = () => new Date();
const ago = (ms, base = Date.now()) => new Date(base - ms);
const listOf = (...items) => ({ success: true, status: 200, data: { data: items } });
const feedItem = (id, message, createdAt) => ({ id, message, created_time: createdAt.toISOString() });
const isReconcile = (o) => o.method === 'GET' && o.path === '/pg_rec/posts';
const isPost = (o) => o.method === 'POST';

async function withGraph(handler, fn) {
  const original = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => { calls.push(opts); return handler(opts, calls); };
  try { return await fn(calls); } finally { metaApiService.request = original; }
}

describe('recovery sweeps', () => {
  let userId, projectId, project, fb;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    projectId = new mongoose.Types.ObjectId();
    await ensureProject(projectId, { userId });
    project = projectId.toString();
    fb = await SocialAccount.create({
      user_id: userId, project_id: projectId, platform: 'facebook', platformAccountId: 'pg_rec', pageId: 'pg_rec', accountType: 'page',
      accessToken: 'tok-recovery', status: 'active', isActive: true, scopes: ['pages_manage_posts'],
    });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: projectId });
    await SocialAccount.deleteMany({ project_id: projectId });
    await removeProject(projectId);
  });

  /** A row exactly as a crashed worker leaves it: claimed, lock stamped, never finalized. */
  function orphan(over = {}) {
    const started = over.startedAt || ago(15 * MIN);
    return SocialPublication.create({
      project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: over.content ?? 'Orphaned post', media: over.media || [],
      status: 'publishing', scheduledAt: ago(20 * MIN), createdBy: userId,
      publishingStartedAt: started, lockedBy: 'dead-worker:123', lastAttemptAt: started,
      publishTrigger: over.trigger || 'scheduler', attempts: over.attempts ?? 1,
      ...(over.extra || {}),
    });
  }
  const reload = (id) => SocialPublication.findById(id);

  // ───────────── stale 'publishing' ─────────────
  describe('recoverStalePublications', () => {
    test('a stale row whose post DID reach Meta is reconciled and marked PUBLISHED with the real id (no duplicate)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ content: 'It went out before the crash' });
      let posts = 0;
      const summary = await withGraph((o) => {
        if (isPost(o)) posts += 1;
        return isReconcile(o) ? listOf(feedItem('pg_rec_55', 'It went out before the crash', ago(14 * MIN))) : listOf();
      }, () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(posts, 0, 'recovery never publishes');
      assert.equal(summary.published, 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'published');
      assert.equal(r.externalPostId, 'pg_rec_55');
      assert.equal(r.lockedBy, null);
      assert.equal(r.publishingStartedAt, null);
    });

    test('a stale row that provably never published is re-queued (scheduler attempt, budget left): back to scheduled with backoff — and Meta\'s publish endpoint is never touched by recovery', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ attempts: 1 });
      let posts = 0;
      const now = NOW();
      const summary = await withGraph((o) => { if (isPost(o)) posts += 1; return listOf(feedItem('older', 'something else', ago(60 * MIN))); }, () => recoverStalePublications({ projectId, now }));
      assert.equal(posts, 0);
      assert.equal(summary.requeued, 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'scheduled');
      assert.equal(r.outcomeUnknown, false);
      assert.ok(r.nextRetryAt.getTime() >= now.getTime() + 60_000, 'backoff applied');
      assert.equal(r.attempts, 1);
      assert.equal(r.lockedBy, null);
    });

    test('...and the normal scheduler then re-publishes it exactly once (crash recovery end to end)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ attempts: 1 });
      await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      const queued = await reload(row._id);
      let posts = 0;
      const s = await withGraph((o) => { if (isPost(o)) { posts += 1; return { success: true, status: 200, data: { id: 'pg_rec_new' } }; } return listOf(); },
        () => executeDuePublications({ projectId, now: new Date(queued.nextRetryAt.getTime() + 1000) }));
      assert.equal(s.succeeded, 1);
      assert.equal(posts, 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'published');
      assert.equal(r.attempts, 2, 'the crashed attempt counted');
    });

    test('a stale MANUAL attempt that provably did not publish becomes failed/PUBLISH_INTERRUPTED (the person retries) — never auto-retried', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ trigger: 'manual' });
      await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      const r = await reload(row._id);
      assert.equal(r.status, 'failed');
      assert.equal(r.failureCode, 'PUBLISH_INTERRUPTED');
      assert.equal(r.outcomeUnknown, false, 'verified not published, so a manual retry is safe');
      assert.equal(r.nextRetryAt, null);
    });

    test('a stale scheduler attempt that has used its whole retry budget is not re-queued', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ attempts: 4 });
      await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      const r = await reload(row._id);
      assert.equal(r.status, 'failed');
      assert.equal(r.nextRetryAt, null);
    });

    test('when reconciliation CANNOT tell (Meta lookup fails): the row is quarantined as failed + outcomeUnknown and Meta is never asked to publish', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan();
      let posts = 0;
      const summary = await withGraph((o) => { if (isPost(o)) posts += 1; return isReconcile(o) ? { success: false, kind: 'http', status: 503, data: null } : listOf(); }, () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(posts, 0);
      assert.equal(summary.quarantined, 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'failed');
      assert.equal(r.outcomeUnknown, true);
      assert.equal(r.failureCode, 'PUBLISH_OUTCOME_UNKNOWN');
      assert.equal(r.lockedBy, null);
    });

    test('content that cannot be fingerprinted (image, no caption) is quarantined — never blindly re-published', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ content: '', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }] });
      await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal((await reload(row._id)).outcomeUnknown, true);
    });

    test('a dead token discovered during reconciliation expires the account and quarantines the row', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan();
      await withGraph((o) => (isReconcile(o) ? { success: false, kind: 'http', status: 400, data: { error: { type: 'OAuthException', code: 190, message: 'expired' } } } : listOf()), () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
      assert.equal((await reload(row._id)).outcomeUnknown, true);
    });

    test('an already-unavailable account cannot be reconciled: quarantined without any Meta call', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'revoked' } });
      const row = await orphan();
      let metaCalls = 0;
      await withGraph(() => { metaCalls += 1; return listOf(); }, () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(metaCalls, 0);
      assert.equal((await reload(row._id)).outcomeUnknown, true);
    });

    test('a RECENTLY started publish (a live worker) is left completely alone', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ startedAt: ago(2 * MIN) });
      let metaCalls = 0;
      const summary = await withGraph(() => { metaCalls += 1; return listOf(); }, () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(summary.found, 0);
      assert.equal(metaCalls, 0);
      const r = await reload(row._id);
      assert.equal(r.status, 'publishing');
      assert.equal(r.lockedBy, 'dead-worker:123');
    });

    test('the stale threshold is configurable and measured from the lock timestamp', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan({ startedAt: ago(4 * MIN) });
      const saved = process.env.SOCIAL_PUBLISH_STALE_MS;
      process.env.SOCIAL_PUBLISH_STALE_MS = String(3 * MIN);
      try {
        const summary = await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
        assert.equal(summary.found, 1);
      } finally { if (saved === undefined) delete process.env.SOCIAL_PUBLISH_STALE_MS; else process.env.SOCIAL_PUBLISH_STALE_MS = saved; }
      assert.notEqual((await reload(row._id)).status, 'publishing');
    });

    test('LEGACY rows stuck before the lock fields existed (no publishingStartedAt) are recovered from their last-write age', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: 'legacy stuck', status: 'publishing', scheduledAt: ago(60 * MIN), createdBy: userId });
      // raw write so Mongoose's timestamps don't refresh updatedAt
      await SocialPublication.collection.updateOne({ _id: row._id }, { $set: { updatedAt: ago(45 * MIN) } });
      const summary = await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(summary.found, 1);
      assert.notEqual((await reload(row._id)).status, 'publishing');
    });

    test('rows in other statuses are never touched by the stale sweep', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      for (const status of ['draft', 'scheduled', 'published', 'failed', 'cancelled']) {
        await SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: status, status, scheduledAt: ago(30 * MIN), createdBy: userId, publishingStartedAt: ago(60 * MIN), externalPostId: status === 'published' ? 'pg_rec_pub' : null });
      }
      const summary = await withGraph(() => listOf(), () => recoverStalePublications({ projectId, now: NOW() }));
      assert.equal(summary.found, 0);
    });

    test('MULTIPLE WORKERS running recovery at once process each stale row exactly once (4 concurrent sweeps, 3 rows => 3 reconciliations)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const rows = [await orphan({ content: 'one' }), await orphan({ content: 'two' }), await orphan({ content: 'three' })];
      let lookups = 0;
      const summaries = await withGraph(async (o) => {
        if (isReconcile(o)) { lookups += 1; await new Promise((r) => setTimeout(r, 40)); }
        return listOf(feedItem('older', 'nothing relevant', ago(60 * MIN)));
      }, () => Promise.all(Array.from({ length: 4 }, () => recoverStalePublications({ projectId, now: NOW() }))));
      assert.equal(lookups, 3, 'each row reconciled once, not once per worker');
      assert.equal(summaries.reduce((n, s) => n + s.recovered, 0), 3);
      for (const row of rows) assert.notEqual((await reload(row._id)).status, 'publishing');
    });

    test('recovery of a row that is concurrently finalized by its (slow but alive) worker does not clobber it', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await orphan();
      // the "alive" worker completes just as the sweeper starts reconciling
      const summary = await withGraph(async (o) => {
        if (isReconcile(o)) {
          await SocialPublication.updateOne({ _id: row._id }, { $set: { status: 'published', externalPostId: 'pg_rec_alive', lockedBy: null } });
        }
        return listOf();
      }, () => recoverStalePublications({ projectId, now: NOW() }));
      assert.ok(summary.found >= 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'published', 'recovery\'s late decision must not overwrite a finished publish');
      assert.equal(r.externalPostId, 'pg_rec_alive');
    });
  });

  // ───────────── parked unknown outcomes ─────────────
  describe('reconcileUnknownOutcomes', () => {
    const parked = (over = {}) => SocialPublication.create({
      project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: over.content ?? 'Parked post',
      status: 'failed', outcomeUnknown: true, failureCode: 'PUBLISH_OUTCOME_UNKNOWN', failureReason: 'unknown', scheduledAt: ago(30 * MIN), createdBy: userId,
      lastAttemptAt: over.lastAttemptAt || ago(5 * MIN), publishTrigger: over.trigger || 'scheduler', attempts: over.attempts ?? 1,
    });

    test('a parked unknown outcome that Meta now shows is marked PUBLISHED', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await parked({ content: 'Found it' });
      const s = await withGraph((o) => (isReconcile(o) ? listOf(feedItem('pg_rec_f', 'Found it', ago(4 * MIN))) : listOf()), () => reconcileUnknownOutcomes({ projectId, now: NOW() }));
      assert.equal(s.published, 1);
      const r = await reload(row._id);
      assert.equal(r.status, 'published');
      assert.equal(r.externalPostId, 'pg_rec_f');
      assert.equal(r.outcomeUnknown, false);
    });

    test('confidently NOT published: a scheduler attempt goes back to scheduled with backoff; a manual one becomes a plain, safely-retryable failure', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const sch = await parked({ content: 'sched', trigger: 'scheduler' });
      const man = await parked({ content: 'man', trigger: 'manual' });
      const s = await withGraph(() => listOf(feedItem('older', 'other', ago(90 * MIN))), () => reconcileUnknownOutcomes({ projectId, now: NOW() }));
      assert.equal(s.cleared, 2);
      const a = await reload(sch._id);
      assert.equal(a.status, 'scheduled');
      assert.equal(a.outcomeUnknown, false);
      assert.ok(a.nextRetryAt);
      const b = await reload(man._id);
      assert.equal(b.status, 'failed');
      assert.equal(b.failureCode, 'PUBLISH_INTERRUPTED');
      assert.equal(b.outcomeUnknown, false);
    });

    test('too soon (inside the settle window) nothing is concluded: "not found yet" is not "not published"', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await parked({ lastAttemptAt: ago(60_000) });
      let metaCalls = 0;
      const s = await withGraph(() => { metaCalls += 1; return listOf(); }, () => reconcileUnknownOutcomes({ projectId, now: NOW() }));
      assert.equal(s.found, 0);
      assert.equal(metaCalls, 0);
      assert.equal((await reload(row._id)).outcomeUnknown, true);
    });

    test('still undeterminable: the flag stays, the check is stamped, and the next sweep does not hammer Meta again immediately', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await parked();
      const now = NOW();
      let lookups = 0;
      const graph = (o) => { if (isReconcile(o)) { lookups += 1; return { success: false, kind: 'http', status: 503, data: null }; } return listOf(); };
      const s1 = await withGraph(graph, () => reconcileUnknownOutcomes({ projectId, now }));
      const s2 = await withGraph(graph, () => reconcileUnknownOutcomes({ projectId, now: new Date(now.getTime() + 30_000) }));
      assert.equal(s1.stillUnknown, 1);
      assert.equal(s2.found, 0);
      assert.equal(lookups, 1);
      const r = await reload(row._id);
      assert.equal(r.outcomeUnknown, true);
      assert.equal(r.reconcileAttempts, 1);
      assert.ok(r.reconcileCheckedAt);
    });

    test('after the give-up window it stops checking and leaves the post flagged for a person to verify', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const row = await parked({ lastAttemptAt: ago(25 * 60 * MIN) });
      let metaCalls = 0;
      const s = await withGraph(() => { metaCalls += 1; return listOf(); }, () => reconcileUnknownOutcomes({ projectId, now: NOW() }));
      assert.equal(s.found, 0);
      assert.equal(metaCalls, 0);
      assert.equal((await reload(row._id)).outcomeUnknown, true);
    });

    test('concurrent sweeps reconcile each parked row once', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await parked({ content: 'a' }); await parked({ content: 'b' });
      let lookups = 0;
      await withGraph(async (o) => { if (isReconcile(o)) { lookups += 1; await new Promise((r) => setTimeout(r, 30)); } return listOf(feedItem('older', 'x', ago(90 * MIN))); },
        () => Promise.all(Array.from({ length: 4 }, () => reconcileUnknownOutcomes({ projectId, now: NOW() }))));
      assert.equal(lookups, 2);
    });
  });

  // ───────────── missed ─────────────
  describe('markMissedPublications', () => {
    test('only scheduled rows older than the window are failed; boundary and non-scheduled rows are untouched', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const mk = (status, ms) => SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: status + ms, status, scheduledAt: ago(ms), createdBy: userId });
      const old = await mk('scheduled', 120 * MIN);
      const ok = await mk('scheduled', 30 * MIN);
      const draft = await mk('draft', 500 * MIN);
      const r = await markMissedPublications({ projectId, now: NOW() });
      assert.equal(r.missed, 1);
      assert.equal((await reload(old._id)).failureCode, 'SCHEDULE_MISSED');
      assert.equal((await reload(ok._id)).status, 'scheduled');
      assert.equal((await reload(draft._id)).status, 'draft');
    });
  });
});
