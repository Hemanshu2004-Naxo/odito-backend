import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import metaApiService from './metaApiService.js';
import { runOnce, getSchedulerStatus } from './socialSchedulerService.js';
import { ensureProject, removeProject } from '../testSupport/projectFixture.js';

/**
 * The scheduler tick (P0 #12): recovery + reconciliation + due execution in
 * one pass, isolated stages, and "scheduler errors don't crash the API
 * process". Real MongoDB; only the Graph HTTP layer is replaced.
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
const listOf = (...items) => ({ success: true, status: 200, data: { data: items } });

async function withGraph(handler, fn) {
  const original = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => { calls.push(opts); return handler(opts, calls); };
  try { return await fn(calls); } finally { metaApiService.request = original; }
}

describe('runOnce — one scheduler tick', () => {
  let userId, projectId, fb;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    projectId = new mongoose.Types.ObjectId();
    await ensureProject(projectId, { userId });
    fb = await SocialAccount.create({ user_id: userId, project_id: projectId, platform: 'facebook', platformAccountId: 'pg_tick', pageId: 'pg_tick', accountType: 'page', accessToken: 'tok', status: 'active', isActive: true, scopes: ['pages_manage_posts'] });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: projectId });
    await SocialAccount.deleteMany({ project_id: projectId });
    await removeProject(projectId);
  });

  const base = (over) => ({ project_id: projectId, social_account_id: fb._id, platform: 'facebook', createdBy: userId, ...over });
  const publishOk = (id) => (o) => (o.method === 'POST' ? { success: true, status: 200, data: { id } } : listOf());

  test('a single tick recovers an orphaned post AND publishes a due one, then reports a structured summary and status', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const orphan = await SocialPublication.create(base({
      content: 'orphan', status: 'publishing', scheduledAt: new Date(Date.now() - 30 * MIN), publishingStartedAt: new Date(Date.now() - 20 * MIN),
      lockedBy: 'dead:1', lastAttemptAt: new Date(Date.now() - 20 * MIN), publishTrigger: 'scheduler', attempts: 1,
    }));
    const due = await SocialPublication.create(base({ content: 'due now', status: 'scheduled', scheduledAt: new Date(Date.now() - MIN) }));

    const summary = await withGraph(publishOk('pg_tick_1'), () => runOnce({ projectId }));

    assert.equal(summary.stale.found, 1);
    assert.equal(summary.stale.requeued, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal((await SocialPublication.findById(due._id)).status, 'published');
    assert.equal((await SocialPublication.findById(orphan._id)).status, 'scheduled');

    const status = getSchedulerStatus();
    assert.ok(status.lastRunAt);
    assert.equal(status.lastRunError, null);
    assert.equal(status.lastSummary.succeeded, 1);
    assert.equal(status.lastSummary.results, undefined, 'status does not embed per-post results');
  });

  test('stages are ISOLATED: if stale recovery blows up, due posts are still published, and the tick does not throw', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const due = await SocialPublication.create(base({ content: 'still goes out', status: 'scheduled', scheduledAt: new Date(Date.now() - MIN) }));

    const originalFind = SocialPublication.find;
    SocialPublication.find = function patched(filter, ...rest) {
      if (filter && filter.status === 'publishing') throw new Error('simulated mongo failure in recovery');
      return originalFind.call(this, filter, ...rest);
    };
    let summary;
    try {
      summary = await withGraph(publishOk('pg_tick_2'), () => runOnce({ projectId }));
    } finally { SocialPublication.find = originalFind; }

    assert.equal(summary.succeeded, 1, 'the due post was still processed');
    assert.equal((await SocialPublication.findById(due._id)).status, 'published');
    assert.match(getSchedulerStatus().lastRunError, /simulated mongo failure/);
  });

  test('even a TOTAL database failure never throws out of the tick (the API process must not crash)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const originalFind = SocialPublication.find;
    const originalUpdateMany = SocialPublication.updateMany;
    SocialPublication.find = () => { throw new Error('mongo down'); };
    SocialPublication.updateMany = () => { throw new Error('mongo down'); };
    let result;
    try {
      result = await runOnce({ projectId }); // must resolve, not reject
    } finally {
      SocialPublication.find = originalFind;
      SocialPublication.updateMany = originalUpdateMany;
    }
    assert.equal(result.processed, 0);
    assert.match(getSchedulerStatus().lastRunError, /mongo down/);
  });

  test('a Meta outage during a tick is contained: the post is re-queued, the tick completes normally', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const due = await SocialPublication.create(base({ content: 'meta is down', status: 'scheduled', scheduledAt: new Date(Date.now() - MIN) }));
    const summary = await withGraph((o) => (o.method === 'POST' ? { success: false, kind: 'network_unsent', status: null, data: null, message: 'down' } : listOf()), () => runOnce({ projectId }));
    assert.equal(summary.failed, 1);
    const row = await SocialPublication.findById(due._id);
    assert.equal(row.status, 'scheduled');
    assert.ok(row.nextRetryAt);
    assert.equal(getSchedulerStatus().lastRunError, null, 'a Meta failure is handled, not a scheduler error');
  });

  test('a scheduler restart (a fresh tick with no in-memory state) loses nothing: a retry-pending post is still picked up from the DB', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const row = await SocialPublication.create(base({
      content: 'survives restart', status: 'scheduled', scheduledAt: new Date(Date.now() - 10 * MIN), nextRetryAt: new Date(Date.now() - 1000), attempts: 1, lastErrorCode: 'FACEBOOK_RATE_LIMITED',
    }));
    const summary = await withGraph(publishOk('pg_tick_3'), () => runOnce({ projectId }));
    assert.equal(summary.succeeded, 1);
    assert.equal((await SocialPublication.findById(row._id)).status, 'published');
  });
});
