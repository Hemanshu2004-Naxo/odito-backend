import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import metaApiService from './metaApiService.js';
import adapters from './platformAdapters/index.js';
import {
  createPublication, updatePublication, schedulePublication, cancelPublication, deletePublication, publishNow, executeDuePublications,
} from './socialPublishingService.js';
import { recordPublished, settleFailure, getInstanceId } from './publicationLifecycle.js';
import { createPublicationHandler } from '../controller/socialPublishingController.js';
import '../testSupport/stubPermalinkLookup.js';
import { renderMetrics } from '../../../monitoring/metrics.js';
import '../../../monitoring/socialAiMetrics.js';
import { ensureProject, removeProject } from '../testSupport/projectFixture.js';

/**
 * Publishing reliability — real MongoDB, REAL platform adapters + REAL error
 * classifier. Only the Graph HTTP layer (metaApiService.request) is replaced,
 * so every scenario exercises the exact production path from publishNow()
 * down to the classified Meta response. Time is injected via the `now`
 * option, so retry/backoff/lateness are deterministic.
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
const TIMEOUT = { success: false, kind: 'timeout', status: null, data: null, message: 'Meta API request timed out' };
/** One series of the operational metrics (publish outcomes, expired connections). */
const metric = async (name, label, value) => {
  const wanted = label ? `${name}{${label}="${value}"} ` : `${name} `;
  return Number((await renderMetrics()).split('\n').find((l) => l.startsWith(wanted)).slice(wanted.length));
};
const http = (status, error) => ({ success: false, kind: 'http', status, data: error ? { error } : null, message: error?.message || 'err' });
const metaErr = (code, message = 'm', extra = {}) => ({ type: 'OAuthException', code, message, ...extra });

/** Replaces the Graph layer; `handler(opts)` decides every response. Records all calls. */
async function withGraph(handler, fn) {
  const original = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => { calls.push(opts); return handler(opts, calls); };
  try { return await fn(calls); } finally { metaApiService.request = original; }
}
const isPublishPost = (o, page = 'pg_r1') => o.method === 'POST' && o.path === `/${page}/feed`;
const isReconcile = (o, page = 'pg_r1') => o.method === 'GET' && o.path === `/${page}/posts`;
const feedItem = (id, message, createdAt = new Date()) => ({ id, message, created_time: createdAt.toISOString() });
const listOf = (...items) => ({ success: true, status: 200, data: { data: items } });

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join('\n');
}

describe('socialPublishing reliability', () => {
  let userId, projectId, project, fb, ig;
  const PAGE_TOKEN = 'PAGE-ACCESS-TOKEN-must-not-leak';
  const FB_FIELDS = (extra = {}) => ({ platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Hello world', ...extra });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    projectId = new mongoose.Types.ObjectId();
    await ensureProject(projectId, { userId });
    project = projectId.toString();
    const base = { user_id: userId, project_id: projectId, accessToken: PAGE_TOKEN, status: 'active', scopes: ['pages_show_list', 'pages_manage_posts', 'instagram_content_publish'] };
    fb = await SocialAccount.create({ ...base, platform: 'facebook', platformAccountId: 'pg_r1', pageId: 'pg_r1', accountType: 'page', isActive: true });
    ig = await SocialAccount.create({ ...base, platform: 'instagram', platformAccountId: 'ig_r1', pageId: 'pg_r1', instagramBusinessAccountId: 'ig_r1', accountType: 'business' });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: projectId });
    await SocialAccount.deleteMany({ project_id: projectId });
    await removeProject(projectId);
  });

  /** A scheduled post that is due `minutesAgo` minutes ago (created via the real API for the future, then moved back in time). */
  async function dueFb(fields = {}, minutesAgo = 1) {
    const created = await createPublication(project, userId, FB_FIELDS({ ...fields, scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
    assert.equal(created.success, true, JSON.stringify(created.error));
    await SocialPublication.updateOne({ _id: created.publication.id }, { $set: { scheduledAt: new Date(Date.now() - minutesAgo * MIN) } });
    return created.publication.id;
  }
  const reload = (id) => SocialPublication.findById(id);
  // Every publish gets a DISTINCT Meta post id (a repeated id would — correctly — hit the unique externalPostId index).
  const okPublish = (id) => { let n = 0; return (o) => (isPublishPost(o) ? { success: true, status: 200, data: { id: id || `pg_r1_auto_${n += 1}` } } : { success: true, status: 200, data: { data: [] } }); };
  /** Backoff is measured from the real failure time (not the tick's start), so a few ms of drift is expected. */
  const near = (actualMs, expectedMs, slackMs = 10_000) => assert.ok(actualMs >= expectedMs && actualMs <= expectedMs + slackMs, `expected ${expectedMs}..+${slackMs}ms, got offset ${actualMs - expectedMs}ms`);

  // ═════════════════════ A. atomic claim / duplicate publishing ═════════════════════
  describe('A. atomic claim and duplicate prevention', () => {
    test('two concurrent manual publishNow calls on the same post reach Meta ONCE — the loser gets NOT_PUBLISHABLE', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const publishedBefore = await metric('odito_social_publish_total', 'outcome', 'published');
      let publishCalls = 0;
      const [a, b] = await withGraph(async (o) => {
        if (isPublishPost(o)) { publishCalls += 1; await new Promise((r) => setTimeout(r, 80)); return { success: true, status: 200, data: { id: 'p1' } }; }
        return listOf();
      }, () => Promise.all([publishNow(project, id, userId), publishNow(project, id, userId)]));
      assert.equal(publishCalls, 1, 'exactly one real publish request');
      assert.equal([a, b].filter((r) => r.success).length, 1);
      assert.equal([a, b].find((r) => !r.success).error.code, 'NOT_PUBLISHABLE');
      assert.equal((await reload(id)).status, 'published');
      assert.equal(await metric('odito_social_publish_total', 'outcome', 'published') - publishedBefore, 1, 'one real publish is one "published" event');
    });

    test('eight concurrent SCHEDULER claims of one due post (simulating several PM2 instances) publish exactly once', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      let publishCalls = 0;
      const results = await withGraph(async (o) => {
        if (isPublishPost(o)) { publishCalls += 1; await new Promise((r) => setTimeout(r, 60)); return { success: true, status: 200, data: { id: 'p1' } }; }
        return listOf();
      }, () => Promise.all(Array.from({ length: 8 }, () => publishNow(project, id, null, { trigger: 'scheduler' }))));
      assert.equal(publishCalls, 1);
      assert.equal(results.filter((r) => r.success).length, 1);
      assert.equal(results.filter((r) => r.error?.code === 'NOT_PUBLISHABLE').length, 7);
    });

    test('two overlapping scheduler TICKS publish once; the loser reports skipped, not failed', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await dueFb();
      let publishCalls = 0;
      const [s1, s2] = await withGraph(async (o) => {
        if (isPublishPost(o)) { publishCalls += 1; await new Promise((r) => setTimeout(r, 60)); return { success: true, status: 200, data: { id: 'p1' } }; }
        return listOf();
      }, () => Promise.all([executeDuePublications({ projectId }), executeDuePublications({ projectId })]));
      assert.equal(publishCalls, 1);
      assert.equal(s1.succeeded + s2.succeeded, 1);
      assert.equal(s1.skipped + s2.skipped, 1, 'losing the claim race is "skipped"');
      assert.equal(s1.failed + s2.failed, 0, 'and is NOT counted as a failure');
    });

    test('the claim stamps lockedBy / publishingStartedAt / lastAttemptAt / attempts atomically with status:publishing', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      let during;
      await withGraph(async (o) => {
        if (isPublishPost(o)) { during = await reload(id); return { success: true, status: 200, data: { id: 'p1' } }; }
        return listOf();
      }, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(during.status, 'publishing');
      assert.equal(during.lockedBy, getInstanceId());
      assert.ok(during.lockedBy.includes(String(process.pid)), 'lock owner identifies the process (a PM2 restart is a new owner)');
      assert.ok(during.publishingStartedAt instanceof Date);
      assert.ok(during.lastAttemptAt instanceof Date);
      assert.equal(during.attempts, 1);
      assert.equal(during.publishTrigger, 'scheduler');
      const done = await reload(id);
      assert.equal(done.status, 'published');
      assert.equal(done.lockedBy, null, 'lock released on completion');
      assert.equal(done.publishingStartedAt, null);
    });

    test('the scheduler claim RE-CHECKS "due": a post rescheduled to the future after the scan is not published from a stale list', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await schedulePublication(project, id, userId, new Date(Date.now() + 2 * 3600_000).toISOString());
      let publishCalls = 0;
      const r = await withGraph(async (o) => { if (isPublishPost(o)) publishCalls += 1; return listOf(); }, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.error.code, 'NOT_PUBLISHABLE');
      assert.equal(publishCalls, 0);
      assert.equal((await reload(id)).status, 'scheduled');
    });

    test('a post cancelled after the scan is never published by the scheduler', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await cancelPublication(project, id, userId);
      let publishCalls = 0;
      const r = await withGraph(async (o) => { if (isPublishPost(o)) publishCalls += 1; return listOf(); }, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.error.code, 'NOT_PUBLISHABLE');
      assert.equal(publishCalls, 0);
    });

    test('a post that is already publishing or published cannot be published again, by either trigger', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph(okPublish(), () => publishNow(project, id, userId));
      let publishCalls = 0;
      await withGraph(async (o) => { if (isPublishPost(o)) publishCalls += 1; return listOf(); }, async () => {
        assert.equal((await publishNow(project, id, userId)).error.code, 'NOT_PUBLISHABLE');
        assert.equal((await publishNow(project, id, null, { trigger: 'scheduler' })).error.code, 'NOT_PUBLISHABLE');
      });
      assert.equal(publishCalls, 0);
    });

    test('edit / reschedule / delete cannot touch a row that is mid-publish (conditional writes, not read-then-save)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await SocialPublication.updateOne({ _id: id }, { $set: { status: 'publishing', lockedBy: 'someone', publishingStartedAt: new Date() } });
      assert.equal((await updatePublication(project, id, userId, { content: 'sneaky edit' })).error.code, 'NOT_EDITABLE');
      assert.equal((await schedulePublication(project, id, userId, new Date(Date.now() + 3600_000).toISOString())).error.code, 'NOT_EDITABLE');
      assert.equal((await deletePublication(project, id)).error.code, 'NOT_DELETABLE');
      const row = await reload(id);
      assert.equal(row.content, 'Hello world');
      assert.equal(row.status, 'publishing');
    });

    test('delete racing the claim: if the row flips to publishing right after the delete was validated, the delete is refused and the row survives', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const originalFindById = SocialPublication.findById;
      // findOwned() reads the row as 'scheduled'; the scheduler claims it before deleteOne runs.
      SocialPublication.findById = function patched(...args) {
        const q = originalFindById.apply(this, args);
        return q.then(async (doc) => { await SocialPublication.updateOne({ _id: id }, { $set: { status: 'publishing' } }); return doc; });
      };
      let result;
      try { result = await deletePublication(project, id); } finally { SocialPublication.findById = originalFindById; }
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'NOT_DELETABLE');
      assert.ok(await reload(id), 'the row must still exist — the in-flight publish still has somewhere to record its result');
    });
  });

  // ═════════════════════ B. past-date + timezone validation ═════════════════════
  describe('B. server-side scheduling validation', () => {
    test('create: a past scheduledAt is rejected with SCHEDULE_IN_PAST and nothing is persisted', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const r = await createPublication(project, userId, FB_FIELDS({ scheduledAt: new Date(Date.now() - MIN).toISOString() }));
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'SCHEDULE_IN_PAST');
      assert.equal(await SocialPublication.countDocuments({ project_id: projectId }), 0);
    });

    test('create: "right now" (scheduledAt <= now) is rejected — no tolerance window', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const r = await createPublication(project, userId, FB_FIELDS({ scheduledAt: new Date().toISOString() }));
      assert.equal(r.error.code, 'SCHEDULE_IN_PAST');
    });

    test('create: a future time and an explicit-offset future time are accepted', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      assert.equal((await createPublication(project, userId, FB_FIELDS({ scheduledAt: new Date(Date.now() + 5 * MIN).toISOString() }))).success, true);
      assert.equal((await createPublication(project, userId, FB_FIELDS({ scheduledAt: '2099-01-01T10:00:00+05:30', timezone: 'Asia/Kolkata' }))).success, true);
    });

    test('PATCH: rescheduling to a past time is rejected and the stored schedule is unchanged', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const future = new Date(Date.now() + 3600_000);
      const created = await createPublication(project, userId, FB_FIELDS({ scheduledAt: future.toISOString() }));
      const r = await updatePublication(project, created.publication.id, userId, { scheduledAt: new Date(Date.now() - 5 * MIN).toISOString() });
      assert.equal(r.error.code, 'SCHEDULE_IN_PAST');
      assert.equal((await reload(created.publication.id)).scheduledAt.getTime(), future.getTime());
    });

    test('PATCH: editing only the content of an already-late scheduled post is still allowed (scheduledAt not re-validated)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const r = await updatePublication(project, id, userId, { content: 'fixed typo' });
      assert.equal(r.success, true);
    });

    test('POST /:id/schedule: a past time is rejected; a future time is accepted', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const draft = await createPublication(project, userId, FB_FIELDS());
      assert.equal((await schedulePublication(project, draft.publication.id, userId, new Date(Date.now() - MIN).toISOString())).error.code, 'SCHEDULE_IN_PAST');
      assert.equal((await schedulePublication(project, draft.publication.id, userId, new Date(Date.now() + 10 * MIN).toISOString(), 'UTC')).success, true);
    });

    test('the HTTP layer maps the rejection to 400 SCHEDULE_IN_PAST (a body cannot opt out of the check)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
      await createPublicationHandler({ projectId: project, userId, body: { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'x', scheduledAt: new Date(Date.now() - MIN).toISOString(), allowPastSchedule: true } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.details.code, 'SCHEDULE_IN_PAST');
    });

    test('a naive timestamp with no offset is still INVALID_SCHEDULE (server timezone is never consulted)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      assert.equal((await createPublication(project, userId, FB_FIELDS({ scheduledAt: '2099-01-01T10:00:00' }))).error.code, 'INVALID_SCHEDULE');
    });

    test('timezone must be a real IANA zone on create, PATCH and /schedule', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const future = new Date(Date.now() + 3600_000).toISOString();
      assert.equal((await createPublication(project, userId, FB_FIELDS({ scheduledAt: future, timezone: 'Mars/Olympus' }))).error.code, 'INVALID_TIMEZONE');
      const ok = await createPublication(project, userId, FB_FIELDS({ scheduledAt: future, timezone: 'America/New_York' }));
      assert.equal(ok.success, true);
      assert.equal(ok.publication.timezone, 'America/New_York');
      assert.equal((await updatePublication(project, ok.publication.id, userId, { scheduledAt: future, timezone: 'nope' })).error.code, 'INVALID_TIMEZONE');
      assert.equal((await schedulePublication(project, ok.publication.id, userId, future, 'x'.repeat(200))).error.code, 'INVALID_TIMEZONE');
    });

    test('bulk import is not broken: the internal allowPastSchedule flag lets an immediately-due "publish" row through', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const r = await createPublication(project, userId, FB_FIELDS({ scheduledAt: new Date(Date.now() - 500).toISOString(), allowPastSchedule: true }));
      assert.equal(r.success, true);
      assert.equal(r.publication.status, 'scheduled');
    });
  });

  // ═════════════════════ C. retry / backoff / permanent failure ═════════════════════
  describe('C. retry system', () => {
    test('a RETRYABLE failure (rate limit, HTTP 400 code 613) of a scheduled post is re-queued: status scheduled, attempts 1, nextRetryAt = +5min, lastError kept', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const now = new Date();
      const r = await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(613, 'Calls to this api have exceeded the rate limit')) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler', now }));
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'FACEBOOK_RATE_LIMITED');
      assert.equal(r.publication.status, 'scheduled', 'queued for retry, not failed');
      const row = await reload(id);
      assert.equal(row.status, 'scheduled');
      assert.equal(row.attempts, 1);
      near(row.nextRetryAt.getTime(), now.getTime() + 5 * MIN);
      assert.equal(row.lastErrorCode, 'FACEBOOK_RATE_LIMITED');
      assert.equal(row.failureReason, null, 'not terminally failed');
      assert.equal(row.lockedBy, null);
    });

    test('backoff is exponential and honors nextRetryAt: not claimed early, claimed when due, delays 1m -> 2m -> 4m for a transient failure that provably never reached Meta', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      let publishCalls = 0;
      // DNS failure / connection refused: the request never left Odito, so this is
      // a DEFINITE, retryable failure (unlike a 5xx or timeout on the publish call,
      // which is an unknown outcome and is reconciled instead of retried).
      const unsent = { success: false, kind: 'network_unsent', status: null, data: null, message: 'Could not reach Meta API' };
      const graph = (o) => { if (isPublishPost(o)) { publishCalls += 1; return unsent; } return listOf(); };

      // Backoff is measured from the REAL failure time (not the tick's injected
      // `now`), so each delay is asserted against real before/after timestamps.
      const delayWindow = (row, before, after, delayMs) => {
        const at = row.nextRetryAt.getTime();
        assert.ok(at >= before + delayMs && at <= after + delayMs, `nextRetryAt ${at - before}ms after start, expected ~${delayMs}ms`);
      };

      // attempt 1
      let before = Date.now();
      const t1 = new Date();
      await withGraph(graph, () => executeDuePublications({ projectId, now: t1 }));
      let row = await reload(id);
      assert.equal(row.attempts, 1);
      delayWindow(row, before, Date.now(), 1 * MIN);

      // not yet due: nothing happens
      await withGraph(graph, () => executeDuePublications({ projectId, now: new Date(row.nextRetryAt.getTime() - 30_000) }));
      assert.equal(publishCalls, 1, 'must not retry before nextRetryAt');

      // attempt 2 once due
      before = Date.now();
      await withGraph(graph, () => executeDuePublications({ projectId, now: new Date(row.nextRetryAt.getTime() + 1000) }));
      row = await reload(id);
      assert.equal(row.attempts, 2);
      delayWindow(row, before, Date.now(), 2 * MIN);

      // attempt 3 once due
      before = Date.now();
      await withGraph(graph, () => executeDuePublications({ projectId, now: new Date(row.nextRetryAt.getTime() + 1000) }));
      row = await reload(id);
      assert.equal(row.attempts, 3);
      delayWindow(row, before, Date.now(), 4 * MIN);
      assert.equal(publishCalls, 3);
    });

    test('a 5xx on the final publish call is an UNKNOWN outcome — it is reconciled, NOT blindly retried', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      let publishCalls = 0;
      await withGraph((o) => { if (isPublishPost(o)) { publishCalls += 1; return http(503, null); } return listOf(); }, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      const row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.outcomeUnknown, true);
      assert.equal(row.failureCode, 'PUBLISH_OUTCOME_UNKNOWN');
      assert.equal(row.nextRetryAt, null, 'no automatic retry while the outcome is unknown');
      assert.equal(publishCalls, 1);
    });

    test('after the retry budget is exhausted the post FAILS with MAX_RETRIES_EXCEEDED and the original error is kept', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await withEnv({ SOCIAL_PUBLISH_MAX_ATTEMPTS: '3' }, async () => {
        const id = await dueFb();
        const graph = (o) => (isPublishPost(o) ? http(400, metaErr(17, 'User request limit reached')) : listOf());
        let when = new Date();
        for (let i = 1; i <= 3; i += 1) {
          await withGraph(graph, () => executeDuePublications({ projectId, now: when }));
          const row = await reload(id);
          assert.equal(row.attempts, i);
          if (i < 3) { assert.equal(row.status, 'scheduled'); when = new Date(row.nextRetryAt.getTime() + 1000); }
        }
        const final = await reload(id);
        assert.equal(final.status, 'failed');
        assert.equal(final.failureCode, 'MAX_RETRIES_EXCEEDED');
        assert.match(final.failureReason, /gave up after 3 attempts/);
        assert.equal(final.lastErrorCode, 'FACEBOOK_RATE_LIMITED');
        assert.equal(final.nextRetryAt, null);
        // and the scheduler never touches it again
        let calls = 0;
        await withGraph((o) => { if (isPublishPost(o)) calls += 1; return listOf(); }, () => executeDuePublications({ projectId, now: new Date(when.getTime() + 60 * MIN) }));
        assert.equal(calls, 0);
      });
    });

    test('NON-retryable failures fail immediately on attempt 1 and are never retried: invalid content/param, missing permission, invalid media', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const cases = [
        ['invalid parameter (HTTP 400 code 100)', http(400, { type: 'GraphMethodException', code: 100, message: 'Invalid parameter' }), 'FACEBOOK_PUBLISH_FAILED'],
        ['missing permission (HTTP 403 code 200)', http(403, metaErr(200, '(#200) requires pages_manage_posts permission')), 'FACEBOOK_PERMISSION_MISSING'],
        ['media rejected', http(400, metaErr(9004, 'Only photo or video can be accepted as media type')), 'FACEBOOK_MEDIA_INVALID'],
      ];
      for (const [label, response, expectedCode] of cases) {
        const id = await dueFb({ content: `non-retryable: ${label}` });
        await withGraph((o) => (isPublishPost(o) ? response : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
        const row = await reload(id);
        assert.equal(row.status, 'failed', label);
        assert.equal(row.failureCode, expectedCode, label);
        assert.equal(row.attempts, 1, label);
        assert.equal(row.nextRetryAt, null, label);
        let calls = 0;
        await withGraph((o) => { if (isPublishPost(o)) calls += 1; return listOf(); }, () => executeDuePublications({ projectId, now: new Date(Date.now() + 120 * MIN) }));
        assert.equal(calls, 0, `${label}: never retried`);
      }
    });

    test('missing media on Instagram (a content-validation failure) is not retried either', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const created = await createPublication(project, userId, { platform: 'instagram', socialAccountId: ig._id.toString(), content: 'no media', scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      await SocialPublication.updateOne({ _id: created.publication.id }, { $set: { scheduledAt: new Date(Date.now() - MIN) } });
      await withGraph(() => { throw new Error('Meta must not be called'); }, () => publishNow(project, created.publication.id, null, { trigger: 'scheduler' }));
      const row = await reload(created.publication.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.failureCode, 'MEDIA_REQUIRED');
      assert.equal(row.nextRetryAt, null);
    });

    test('a MANUAL publish that fails with a retryable error just becomes failed — only scheduler-triggered attempts auto-retry', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(4, 'rate')) : listOf()), () => publishNow(project, id, userId));
      const row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.nextRetryAt, null);
      assert.equal(row.attempts, 1);
    });

    test('retry state survives a restart: it lives only in the database, so a brand-new tick (any process) picks the post up when due', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const t1 = new Date();
      await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(613, 'rl')) : listOf()), () => executeDuePublications({ projectId, now: t1 }));
      const queued = await reload(id);
      assert.equal(queued.status, 'scheduled');
      // "restart": nothing in memory is carried over — a fresh tick later succeeds.
      const later = new Date(queued.nextRetryAt.getTime() + 1000);
      const summary = await withGraph(okPublish('pg_r1_post_9'), () => executeDuePublications({ projectId, now: later }));
      assert.equal(summary.succeeded, 1);
      const row = await reload(id);
      assert.equal(row.status, 'published');
      assert.equal(row.externalPostId, 'pg_r1_post_9');
      assert.equal(row.attempts, 2);
      assert.equal(row.lastError, null, 'cleared on success');
      assert.equal(row.nextRetryAt, null);
    });

    test('rescheduling or editing the schedule of a retry-pending post resets its retry state', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(613, 'rl')) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal((await reload(id)).attempts, 1);
      await schedulePublication(project, id, userId, new Date(Date.now() + 2 * 3600_000).toISOString());
      const row = await reload(id);
      assert.equal(row.attempts, 0);
      assert.equal(row.nextRetryAt, null);
      assert.equal(row.lastErrorCode, null);
    });

    test('cancelling a retry-pending post stops the retries', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph((o) => (isPublishPost(o) ? http(503, null) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      // 503 on the final call is "unknown"; use a definite retryable one instead
      await SocialPublication.updateOne({ _id: id }, { $set: { status: 'scheduled', outcomeUnknown: false, nextRetryAt: new Date(Date.now() + MIN), attempts: 1 } });
      assert.equal((await cancelPublication(project, id, userId)).success, true);
      let calls = 0;
      await withGraph((o) => { if (isPublishPost(o)) calls += 1; return listOf(); }, () => executeDuePublications({ projectId, now: new Date(Date.now() + 10 * MIN) }));
      assert.equal(calls, 0);
      assert.equal((await reload(id)).nextRetryAt, null);
    });
  });

  // ═════════════════════ D. token expiry on publish ═════════════════════
  describe('D. expired authentication on publish', () => {
    test('Facebook HTTP 400 code 190: the post fails with FACEBOOK_TOKEN_INVALID, the account (and its Instagram) becomes EXPIRED, nothing is retried, and the response says "reconnect"', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const reconnectBefore = await metric('odito_social_publish_total', 'outcome', 'reconnect_required');
      const expiredBefore = await metric('odito_social_connections_expired_total');
      let r;
      const logs = await captureLogs(async () => {
        r = await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(190, 'Error validating access token: Session has expired', { fbtrace_id: 'TRACEXYZ' })) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      });
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'FACEBOOK_TOKEN_INVALID');
      assert.equal(r.error.requiresReconnect, true);
      assert.equal(r.publication.status, 'failed');
      assert.equal(r.publication.requiresReconnect, true);
      assert.equal(r.publication.attempts, 1, 'not retried');
      const fbDoc = await SocialAccount.findById(fb._id);
      const igDoc = await SocialAccount.findById(ig._id);
      assert.equal(fbDoc.status, 'expired');
      assert.equal(fbDoc.statusReason, 'META_TOKEN_INVALID');
      assert.equal(igDoc.status, 'expired', 'the Instagram row shares the dead Page token');
      assert.ok(!JSON.stringify(r).includes(PAGE_TOKEN), 'response carries no token');
      assert.ok(!logs.includes(PAGE_TOKEN), 'logs carry no token');
      assert.ok(!JSON.stringify(r).includes('TRACEXYZ'), 'no Meta trace id leaks to the caller');
      assert.equal(await metric('odito_social_publish_total', 'outcome', 'reconnect_required') - reconnectBefore, 1, 'counted as a publish that needs a reconnect');
      assert.equal(await metric('odito_social_connections_expired_total') - expiredBefore, 1, 'and the expired connection is counted once');
    });

    test('once expired, further publishes are refused up-front (ACCOUNT_RECONNECT_REQUIRED) without calling Meta', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph((o) => (isPublishPost(o) ? http(400, metaErr(190, 'expired')) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      // (created directly: the API itself now refuses to create posts for an expired account — asserted just below)
      const secondRow = await SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: 'second post', status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId });
      const second = secondRow._id.toString();
      let metaCalls = 0;
      // creating is also refused for an expired account
      const create = await createPublication(project, userId, FB_FIELDS({ content: 'new' }));
      assert.equal(create.error.code, 'ACCOUNT_RECONNECT_REQUIRED');
      const r = await withGraph(() => { metaCalls += 1; return listOf(); }, () => publishNow(project, second, userId));
      assert.equal(r.error.code, 'ACCOUNT_RECONNECT_REQUIRED');
      assert.equal(r.error.requiresReconnect, true);
      assert.equal(metaCalls, 0);
      assert.equal((await reload(second)).status, 'failed');
    });

    test('Instagram code 190 behaves the same, and expires the Facebook Page that owns the token', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const pub = await SocialPublication.create({
        project_id: projectId, social_account_id: ig._id, platform: 'instagram', content: 'ig post', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }],
        status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId,
      });
      const r = await withGraph((o) => (o.path === '/ig_r1/media' ? http(400, metaErr(190, 'expired')) : listOf()), () => publishNow(project, pub._id.toString(), null, { trigger: 'scheduler' }));
      assert.equal(r.error.code, 'INSTAGRAM_TOKEN_INVALID');
      assert.equal((await SocialAccount.findById(ig._id)).status, 'expired');
      assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
    });

    test('ordinary content/validation failures and a MISSING PERMISSION do NOT expire the account', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      for (const response of [
        http(400, { type: 'GraphMethodException', code: 100, message: 'Invalid parameter' }),
        http(403, metaErr(200, '(#200) requires pages_manage_posts permission')),
        http(400, metaErr(613, 'rate')),
      ]) {
        const id = await dueFb({ content: `c-${Math.random()}` });
        await withGraph((o) => (isPublishPost(o) ? response : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
        assert.equal((await SocialAccount.findById(fb._id)).status, 'active');
      }
    });

    test('a bare HTTP 401 also expires the account (existing behavior preserved)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await withGraph((o) => (isPublishPost(o) ? http(401, null) : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
    });
  });

  // ═════════════════════ E. unknown outcome / reconciliation ═════════════════════
  describe('E. unknown publish outcome (lost response)', () => {
    test('timeout AFTER Meta accepted the post: reconciliation finds it, the post is marked PUBLISHED with its real id, and nothing is re-sent', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({ content: 'Launch day post' });
      let publishCalls = 0;
      const r = await withGraph((o) => {
        if (isPublishPost(o)) { publishCalls += 1; return TIMEOUT; }
        if (isReconcile(o)) return listOf(feedItem('pg_r1_777', 'Launch day post'));
        return listOf();
      }, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.success, true);
      assert.equal(r.reconciled, true);
      const row = await reload(id);
      assert.equal(row.status, 'published');
      assert.equal(row.externalPostId, 'pg_r1_777');
      assert.equal(row.outcomeUnknown, false);
      assert.equal(publishCalls, 1, 'the post is never sent a second time');
    });

    test('timeout and the post cannot be confirmed yet: the row is parked failed + outcomeUnknown (not freely retryable), and the next manual retry is REFUSED without calling Meta\'s publish endpoint', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({ content: 'Maybe posted' });
      let publishCalls = 0;
      const graph = (o) => {
        if (isPublishPost(o)) { publishCalls += 1; return TIMEOUT; }
        if (isReconcile(o)) return listOf(); // nothing visible (yet)
        return listOf();
      };
      const first = await withGraph(graph, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(first.success, false);
      assert.equal(first.error.code, 'PUBLISH_OUTCOME_UNKNOWN');
      let row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.outcomeUnknown, true);
      assert.equal(row.nextRetryAt, null);
      assert.equal(first.publication.outcomeUnknown, true);

      // the user immediately hits "Retry Publish"
      const retry = await withGraph(graph, () => publishNow(project, id, userId));
      assert.equal(retry.success, false);
      assert.equal(retry.error.code, 'RECONCILIATION_PENDING');
      assert.equal(publishCalls, 1, 'NO second publish request was made');
      row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.outcomeUnknown, true);
    });

    test('once settled and CONFIDENTLY not found, the flag clears and a manual retry may publish (this is the safe path to a retry)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({ content: 'Never made it' });
      let publishCalls = 0;
      const graph = (o) => {
        if (isPublishPost(o)) { publishCalls += 1; return publishCalls === 1 ? TIMEOUT : { success: true, status: 200, data: { id: 'pg_r1_real' } }; }
        if (isReconcile(o)) return listOf(feedItem('someone_elses', 'a different post'));
        return listOf();
      };
      await withGraph(graph, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal((await reload(id)).outcomeUnknown, true);

      const later = new Date(Date.now() + 5 * MIN); // beyond the settle window
      const retry = await withGraph(graph, () => publishNow(project, id, userId, { now: later }));
      assert.equal(retry.success, true);
      assert.equal(publishCalls, 2);
      const row = await reload(id);
      assert.equal(row.status, 'published');
      assert.equal(row.externalPostId, 'pg_r1_real');
      assert.equal(row.outcomeUnknown, false);
    });

    test('manual retry when reconciliation finds the earlier post: returns it as published, nothing re-sent', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({ content: 'It did go out' });
      let publishCalls = 0;
      let visible = false;
      const graph = (o) => {
        if (isPublishPost(o)) { publishCalls += 1; return TIMEOUT; }
        if (isReconcile(o)) return visible ? listOf(feedItem('pg_r1_live', 'It did go out')) : listOf();
        return listOf();
      };
      await withGraph(graph, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      visible = true; // Meta's index catches up
      const retry = await withGraph(graph, () => publishNow(project, id, userId));
      assert.equal(retry.success, true);
      assert.equal(retry.publication.status, 'published');
      assert.equal(retry.publication.externalPostId, 'pg_r1_live');
      assert.equal(publishCalls, 1);
    });

    test('content that cannot be fingerprinted (image with no caption) is never "confidently not found": retry stays refused with OUTCOME_UNKNOWN, and the scheduler never claims it', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const pub = await SocialPublication.create({
        project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: '', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }],
        status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId,
      });
      let publishCalls = 0;
      const graph = (o) => { if (o.method === 'POST') { publishCalls += 1; return TIMEOUT; } return listOf(); };
      await withGraph(graph, () => publishNow(project, pub._id.toString(), null, { trigger: 'scheduler' }));
      const retry = await withGraph(graph, () => publishNow(project, pub._id.toString(), userId, { now: new Date(Date.now() + 10 * MIN) }));
      assert.equal(retry.error.code, 'OUTCOME_UNKNOWN');
      await withGraph(graph, () => executeDuePublications({ projectId, now: new Date(Date.now() + 10 * MIN) }));
      assert.equal(publishCalls, 1);
    });

    test('a VIDEO is never confidently "not found" (its description does not reliably surface as the post message)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const pub = await SocialPublication.create({
        project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: 'Watch this', media: [{ url: 'https://cdn.example.com/v.mp4', type: 'video' }],
        status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId,
      });
      const graph = (o) => (o.method === 'POST' ? TIMEOUT : listOf());
      await withGraph(graph, () => publishNow(project, pub._id.toString(), null, { trigger: 'scheduler' }));
      const retry = await withGraph(graph, () => publishNow(project, pub._id.toString(), userId, { now: new Date(Date.now() + 10 * MIN) }));
      assert.equal(retry.error.code, 'OUTCOME_UNKNOWN');
    });

    test('reconciliation never claims a Meta post that is already recorded against ANOTHER Odito publication (two identical posts, one live)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      // an earlier, genuinely published row owns post pg_r1_dup
      await SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: 'Same text', status: 'published', externalPostId: 'pg_r1_dup', publishedAt: new Date(), createdBy: userId });
      const id = await dueFb({ content: 'Same text' });
      const graph = (o) => (isPublishPost(o) ? TIMEOUT : isReconcile(o) ? listOf(feedItem('pg_r1_dup', 'Same text')) : listOf());
      const r = await withGraph(graph, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.success, false, 'must not steal the other publication\'s post');
      const row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.externalPostId, null);
      assert.equal(row.outcomeUnknown, true);
    });

    test('a post matching the content but created BEFORE the attempt started is not this attempt\'s post', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({ content: 'Weekly update' });
      const old = new Date(Date.now() - 3 * 3600_000);
      const graph = (o) => (isPublishPost(o) ? TIMEOUT : isReconcile(o) ? listOf(feedItem('pg_r1_old', 'Weekly update', old)) : listOf());
      const r = await withGraph(graph, () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.success, false);
      assert.equal((await reload(id)).externalPostId, null);
    });

    test('a thrown exception inside the adapter is treated as an UNKNOWN outcome (safe), not a plain failure', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const original = adapters.facebook.publish;
      adapters.facebook.publish = async () => { throw new Error('boom'); };
      try {
        const r = await withGraph(() => listOf(), () => publishNow(project, id, null, { trigger: 'scheduler' }));
        assert.equal(r.success, false);
        assert.equal(r.error.code, 'PUBLISH_OUTCOME_UNKNOWN');
      } finally { adapters.facebook.publish = original; }
      assert.equal((await reload(id)).outcomeUnknown, true);
    });

    test('Meta answering OK with NO post id is an unknown outcome too, never "published" with a null id', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const r = await withGraph((o) => (isPublishPost(o) ? { success: true, status: 200, data: {} } : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.success, false);
      const row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.outcomeUnknown, true);
      assert.equal(row.externalPostId, null);
    });

    test('Instagram: a timeout creating the (unpublished) container is a DEFINITE failure and is retried; only a lost media_publish response is unknown', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const mk = () => SocialPublication.create({
        project_id: projectId, social_account_id: ig._id, platform: 'instagram', content: 'ig caption', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }],
        status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId,
      });

      const a = await mk();
      await withGraph((o) => (o.method === 'POST' && o.path === '/ig_r1/media' ? TIMEOUT : listOf()), () => publishNow(project, a._id.toString(), null, { trigger: 'scheduler' }));
      const rowA = await reload(a._id);
      assert.equal(rowA.status, 'scheduled', 'nothing can have been published — safely retried');
      assert.equal(rowA.outcomeUnknown, false);
      assert.ok(rowA.nextRetryAt);

      const b = await mk();
      await withGraph((o) => {
        if (o.method === 'POST' && o.path === '/ig_r1/media') return { success: true, status: 200, data: { id: 'container_1' } };
        if (o.method === 'GET' && o.path === '/container_1') return { success: true, status: 200, data: { status_code: 'FINISHED' } };
        if (o.method === 'POST' && o.path === '/ig_r1/media_publish') return TIMEOUT;
        return { success: true, status: 200, data: { data: [] } };
      }, () => publishNow(project, b._id.toString(), null, { trigger: 'scheduler' }));
      const rowB = await reload(b._id);
      assert.equal(rowB.status, 'failed');
      assert.equal(rowB.outcomeUnknown, true);
    });

    test('Instagram: a lost media_publish response is reconciled by caption and recorded as published', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const pub = await SocialPublication.create({
        project_id: projectId, social_account_id: ig._id, platform: 'instagram', content: 'caption to find', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }],
        status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), createdBy: userId,
      });
      const r = await withGraph((o) => {
        if (o.method === 'POST' && o.path === '/ig_r1/media') return { success: true, status: 200, data: { id: 'container_1' } };
        if (o.method === 'GET' && o.path === '/container_1') return { success: true, status: 200, data: { status_code: 'FINISHED' } };
        if (o.method === 'POST' && o.path === '/ig_r1/media_publish') return TIMEOUT;
        if (o.method === 'GET' && o.path === '/ig_r1/media') return { success: true, status: 200, data: { data: [{ id: 'ig_media_42', caption: 'caption to find', timestamp: new Date().toISOString() }] } };
        return { success: true, status: 200, data: {} };
      }, () => publishNow(project, pub._id.toString(), null, { trigger: 'scheduler' }));
      assert.equal(r.success, true);
      assert.equal((await reload(pub._id)).externalPostId, 'ig_media_42');
    });

    test('the same Meta post can never be recorded on two publications (unique index): a duplicate id fails safely', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialPublication.create({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: 'a', status: 'published', externalPostId: 'pg_r1_X', publishedAt: new Date(), createdBy: userId });
      const id = await dueFb({ content: 'b' });
      const r = await withGraph(okPublish('pg_r1_X'), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'DUPLICATE_EXTERNAL_POST');
      assert.equal((await reload(id)).status, 'failed');
    });

    test('LOCK LOSS: if a recovery took over while a slow publish was running, the original worker\'s FAILURE cannot overwrite the recovery\'s decision', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const claimed = await SocialPublication.findOneAndUpdate({ _id: id }, { $set: { status: 'publishing', lockedBy: 'worker-A', publishingStartedAt: new Date(), publishTrigger: 'scheduler', attempts: 1 } }, { new: true });
      // recovery took the lock
      await SocialPublication.updateOne({ _id: id }, { $set: { lockedBy: 'recovery:worker-B' } });
      const r = await settleFailure(claimed, { code: 'X', message: 'late failure', category: 'PERMANENT', retryable: false, outcome: 'not_published' });
      assert.equal(r.lockLost, true);
      const row = await reload(id);
      assert.equal(row.status, 'publishing', 'untouched');
      assert.equal(row.lockedBy, 'recovery:worker-B');
    });

    test('LATE SUCCESS: a real post that finishes after the row was quarantined is still recorded as published (never lost, never re-created)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await SocialPublication.updateOne({ _id: id }, { $set: { status: 'failed', outcomeUnknown: true, failureCode: 'PUBLISH_OUTCOME_UNKNOWN', lockedBy: null } });
      const { publication } = await recordPublished(await reload(id), 'pg_r1_late');
      assert.equal(publication.status, 'published');
      assert.equal(publication.externalPostId, 'pg_r1_late');
      assert.equal(publication.outcomeUnknown, false);
    });

    test('the API exposes the unknown state safely (flag + message), never internals or tokens', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      const r = await withGraph((o) => (isPublishPost(o) ? TIMEOUT : listOf()), () => publishNow(project, id, null, { trigger: 'scheduler' }));
      assert.equal(r.publication.outcomeUnknown, true);
      assert.equal(r.publication.failureCode, 'PUBLISH_OUTCOME_UNKNOWN');
      assert.ok(!JSON.stringify(r).includes(PAGE_TOKEN));
      assert.ok(!('lockedBy' in r.publication), 'lock identity is internal');
    });
  });

  // ═════════════════════ F. maximum lateness ═════════════════════
  describe('F. maximum lateness (catch-up window)', () => {
    test('within the window: a post 30 minutes late is published', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({}, 30);
      const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
      assert.equal(s.succeeded, 1);
      assert.equal((await reload(id)).status, 'published');
    });

    test('beyond the window: a post 61 minutes late is NOT published — it is failed as SCHEDULE_MISSED, Meta is never called, and the reason is clear', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({}, 61);
      let metaCalls = 0;
      const s = await withGraph(() => { metaCalls += 1; return listOf(); }, () => executeDuePublications({ projectId }));
      assert.equal(metaCalls, 0);
      assert.equal(s.processed, 0);
      assert.equal(s.missed, 1);
      const row = await reload(id);
      assert.equal(row.status, 'failed');
      assert.equal(row.failureCode, 'SCHEDULE_MISSED');
      assert.match(row.failureReason, /60 minutes/);
      assert.equal(row.externalPostId, null);
    });

    test('several overdue posts: only the ones inside the window go out; the rest are missed (10m, 59m published — 61m and 3 days missed)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const ids = {
        m10: await dueFb({ content: 'a' }, 10), m59: await dueFb({ content: 'b' }, 59),
        m61: await dueFb({ content: 'c' }, 61), d3: await dueFb({ content: 'd' }, 3 * 24 * 60),
      };
      const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
      assert.equal(s.succeeded, 2);
      assert.equal(s.missed, 2);
      assert.equal((await reload(ids.m10)).status, 'published');
      assert.equal((await reload(ids.m59)).status, 'published');
      assert.equal((await reload(ids.m61)).failureCode, 'SCHEDULE_MISSED');
      assert.equal((await reload(ids.d3)).failureCode, 'SCHEDULE_MISSED');
    });

    test('scheduler restart after downtime: on the first tick back, a post that came due 3 hours ago is missed, not published late', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const created = await createPublication(project, userId, FB_FIELDS({ scheduledAt: new Date(Date.now() + 10 * MIN).toISOString() }));
      let publishCalls = 0;
      const tickAfterOutage = new Date(Date.now() + 3 * 3600_000); // scheduler was down from before the due time until now
      const s = await withGraph((o) => { if (isPublishPost(o)) publishCalls += 1; return listOf(); }, () => executeDuePublications({ projectId, now: tickAfterOutage }));
      assert.equal(publishCalls, 0);
      assert.equal(s.missed, 1);
      assert.equal((await reload(created.publication.id)).failureCode, 'SCHEDULE_MISSED');
    });

    test('the window is configurable (SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES) and read at call time', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await withEnv({ SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES: '5' }, async () => {
        const id = await dueFb({}, 10);
        const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
        assert.equal(s.missed, 1);
        assert.equal((await reload(id)).failureCode, 'SCHEDULE_MISSED');
      });
      await withEnv({ SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES: '240' }, async () => {
        const id = await dueFb({ content: 'later' }, 200);
        const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
        assert.equal(s.succeeded, 1);
        assert.equal((await reload(id)).status, 'published');
      });
    });

    test('a retry that is itself too late is missed too (lateness for a retry is measured from its nextRetryAt)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb();
      await SocialPublication.updateOne({ _id: id }, { $set: { nextRetryAt: new Date(Date.now() - 90 * MIN), attempts: 1 } });
      const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
      assert.equal(s.missed, 1);
      assert.equal((await reload(id)).failureCode, 'SCHEDULE_MISSED');
    });

    test('a missed post still needs a deliberate user action: Retry Publish (manual) publishes it, unaffected by the window', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const id = await dueFb({}, 500);
      await withGraph(okPublish(), () => executeDuePublications({ projectId }));
      assert.equal((await reload(id)).failureCode, 'SCHEDULE_MISSED');
      const r = await withGraph(okPublish('pg_r1_manual'), () => publishNow(project, id, userId));
      assert.equal(r.success, true);
      assert.equal((await reload(id)).externalPostId, 'pg_r1_manual');
    });

    test('markMissed is idempotent across concurrent ticks (two workers, one transition)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await dueFb({}, 300);
      const [a, b] = await withGraph(okPublish(), () => Promise.all([executeDuePublications({ projectId }), executeDuePublications({ projectId })]));
      assert.equal(a.missed + b.missed, 1);
    });

    test('a post exactly inside the boundary is published; drafts and future posts are never touched', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const inside = await dueFb({}, 59.5);
      const draft = await createPublication(project, userId, FB_FIELDS({ content: 'draft' }));
      const future = await createPublication(project, userId, FB_FIELDS({ content: 'future', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
      const s = await withGraph(okPublish(), () => executeDuePublications({ projectId }));
      assert.equal(s.succeeded, 1);
      assert.equal((await reload(inside)).status, 'published');
      assert.equal((await reload(draft.publication.id)).status, 'draft');
      assert.equal((await reload(future.publication.id)).status, 'scheduled');
    });
  });
});
