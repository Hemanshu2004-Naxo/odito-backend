import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import SocialAccount from '../../social_meta/model/SocialAccount.js';
import SocialPublication from '../../social_meta/model/SocialPublication.js';
import SocialApprovalSettings from '../../social_meta/model/SocialApprovalSettings.js';
import SocialImportBatch from '../../social_meta/model/SocialImportBatch.js';
import PendingMetaConnection from '../../social_meta/model/PendingMetaConnection.js';
import SocialProjectCleanup from '../../social_meta/model/SocialProjectCleanup.js';
import SocialContentCalendar from '../../social_meta/model/SocialContentCalendar.js';
import metaApiService from '../../social_meta/service/metaApiService.js';
import { executeDuePublications, publishNow } from '../../social_meta/service/socialPublishingService.js';
import { purgeProjectSocialData, purgeOrphanedSocialData } from '../../social_meta/service/socialProjectCleanupService.js';
import { setProjectTrashed } from '../../social_meta/testSupport/projectFixture.js';
import { deleteProjectCascade } from './projectCascadeDeleteService.js';
import '../../social_meta/testSupport/stubPermalinkLookup.js';

/**
 * Permanently deleting (or trashing) a project must stop everything social for it: no stored credential, no scheduled post
 * that can still go out, no row left behind - and must never touch another project of the same user.
 * Real MongoDB (run against an isolated database), the Graph HTTP layer replaced and recorded: a post "going out" is a POST.
 */
let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const MIN = 60_000;
const TOKEN = 'EAAG-secret-page-token-1234567890';

async function withGraph(fn) {
  const original = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => {
    calls.push(opts);
    return opts.method === 'POST' ? { success: true, status: 200, data: { id: `pg_${calls.length}_post` } } : { success: true, status: 200, data: { data: [] } };
  };
  try { return await fn(calls); } finally { metaApiService.request = original; }
}
const posts = (calls) => calls.filter((c) => c.method === 'POST');

describe('project deletion — social data and publishing safety', () => {
  let userId;
  let seq = 0;
  const made = [];

  beforeEach(() => { userId = new mongoose.Types.ObjectId(); });
  afterEach(async () => {
    if (!mongoAvailable) return;
    for (const id of made.splice(0)) await deleteProjectCascade(String(id)).catch(() => {});
  });

  const project = async () => {
    const p = await SeoProject.create({ user_id: userId, project_name: `Cascade Social ${Date.now()} ${(seq += 1)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    made.push(p._id);
    return p;
  };

  /** One connected Facebook Page, one scheduled-and-due post, one draft, plus the other social rows of a real project. */
  const seed = async (p, { due = true } = {}) => {
    const pageId = `pg_${p._id}`;
    const account = await SocialAccount.create({
      user_id: userId, project_id: p._id, platform: 'facebook', platformAccountId: pageId, pageId, accountType: 'page',
      accessToken: TOKEN, status: 'active', isActive: true, scopes: ['pages_manage_posts'],
    });
    const base = { project_id: p._id, social_account_id: account._id, platform: 'facebook', createdBy: userId };
    const scheduled = await SocialPublication.create({ ...base, content: 'goes out soon', status: 'scheduled', scheduledAt: new Date(Date.now() - (due ? MIN : -60 * MIN)) });
    const draft = await SocialPublication.create({ ...base, content: 'a draft', status: 'draft' });
    await SocialApprovalSettings.create({ project_id: p._id, contentApprovalRequired: false, designApprovalRequired: false });
    await PendingMetaConnection.create({ user_id: userId, project_id: p._id, userAccessToken: TOKEN, pages: [], scopes: [], expiresAt: new Date(Date.now() + 10 * MIN) });
    return { account, scheduled, draft, pageId };
  };

  test('1: a permanent purge removes accounts, tokens, publications and every other social row, and records a non-sensitive trace', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    await seed(p);

    const summary = await deleteProjectCascade(String(p._id));

    assert.equal(summary.projectDeleted, true);
    assert.equal(summary.retryable, false);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.socialCounts.accounts, 1);
    assert.equal(summary.socialCounts.publications, 2);
    assert.equal(summary.socialCounts.scheduledPublications, 1);
    assert.equal(await SocialAccount.countDocuments({ project_id: p._id }), 0);
    assert.equal(await SocialPublication.countDocuments({ project_id: p._id }), 0);
    assert.equal(await SocialApprovalSettings.countDocuments({ project_id: p._id }), 0);
    assert.equal(await PendingMetaConnection.countDocuments({ project_id: p._id }), 0);

    const record = await SocialProjectCleanup.findOne({ project_id: p._id }).lean();
    assert.ok(record, 'a cleanup record exists');
    assert.equal(record.accounts[0].externalRevocation, 'not_supported');
    assert.match(record.actionRequired, /Business Integrations/);
    assert.equal(record.counts.publications, 2);
    assert.ok(!JSON.stringify(record).includes(TOKEN), 'the record never holds a token');
    assert.ok(record.expiresAt > new Date(), 'retention is bounded (TTL)');
  });

  test('2: repeating the purge is safe and does not erase or duplicate the trace', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    await seed(p);
    await deleteProjectCascade(String(p._id));
    const first = await SocialProjectCleanup.findOne({ project_id: p._id }).lean();
    const again = await deleteProjectCascade(String(p._id));
    assert.equal(again.failures.length, 0);
    assert.equal(again.projectDeleted, false, 'the project document is already gone');
    assert.equal(await SocialProjectCleanup.countDocuments({ project_id: p._id }), 1);
    const second = await SocialProjectCleanup.findOne({ project_id: p._id }).lean();
    assert.equal(second.counts.publications, first.counts.publications, 'a re-run does not lower the counts');
    assert.equal(second.accounts.length, 1);
  });

  test('3: another project of the same user is untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const doomed = await project();
    const kept = await project();
    await seed(doomed);
    const k = await seed(kept, { due: false });
    await SocialContentCalendar.create({
      project_id: kept._id, version: 1, status: 'ready', config: { startDate: '2026-10-06', endDate: '2026-10-12', postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced' },
      strategy: { id: new mongoose.Types.ObjectId(), version: 1, profileSnapshotHash: 'h' },
    });

    await deleteProjectCascade(String(doomed._id));

    assert.equal(await SocialAccount.countDocuments({ project_id: kept._id, status: 'active' }), 1);
    assert.equal((await SocialAccount.findById(k.account._id)).accessToken, TOKEN, 'the other project keeps its working credential');
    assert.equal(await SocialPublication.countDocuments({ project_id: kept._id }), 2);
    assert.equal(await SocialApprovalSettings.countDocuments({ project_id: kept._id }), 1);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: kept._id }), 1);
    assert.equal(await SocialProjectCleanup.countDocuments({ project_id: kept._id }), 0);
  });

  test('4: a scheduled post of a purged project is never dispatched (not even from a leftover row)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const { scheduled } = await seed(p);
    await deleteProjectCascade(String(p._id));

    // an older purge could have left the row behind: put one back, for a project that no longer exists
    const ghost = await SocialPublication.create({ project_id: p._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook', createdBy: userId, content: 'ghost', status: 'scheduled', scheduledAt: new Date(Date.now() - MIN) });
    const calls = await withGraph(async (c) => { await executeDuePublications({}); await publishNow(String(p._id), String(ghost._id), null, { trigger: 'scheduler' }); return c; });

    assert.equal(posts(calls).length, 0, 'nothing reached Meta');
    assert.equal((await SocialPublication.findById(ghost._id)).status, 'cancelled');
    assert.equal((await SocialPublication.findById(ghost._id)).failureCode, 'PROJECT_DELETED');
    assert.equal(await SocialPublication.countDocuments({ _id: scheduled._id }), 0);
    await SocialPublication.deleteOne({ _id: ghost._id });
  });

  test('5: a trashed project is not dispatched; restoring it lets the same post go out', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const { scheduled, pageId } = await seed(p);
    await setProjectTrashed(p._id, true);

    const during = await withGraph(async (c) => { await executeDuePublications({}); return c; });
    assert.equal(posts(during).filter((c) => String(c.path).includes(pageId)).length, 0, 'trashed: nothing published');
    const manual = await withGraph(() => publishNow(String(p._id), String(scheduled._id), null, { trigger: 'manual' }));
    assert.equal(manual.success, false);
    assert.equal(manual.error.code, 'PROJECT_UNAVAILABLE');
    const untouched = await SocialPublication.findById(scheduled._id);
    assert.equal(untouched.status, 'scheduled', 'the schedule is preserved for a restore');
    assert.equal(untouched.attempts || 0, 0);

    await setProjectTrashed(p._id, false);
    const after = await withGraph(async (c) => { await executeDuePublications({ projectId: String(p._id) }); return c; });
    assert.equal(posts(after).length, 1, 'restored: the post goes out');
    assert.equal((await SocialPublication.findById(scheduled._id)).status, 'published');
  });

  test('6: recovery sweeps ignore a trashed project too (no Meta lookups for it)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { recoverStalePublications, reconcileUnknownOutcomes, markMissedPublications } = await import('../../social_meta/service/socialPublishRecoveryService.js');
    const p = await project();
    const { account } = await seed(p);
    const stuck = await SocialPublication.create({
      project_id: p._id, social_account_id: account._id, platform: 'facebook', createdBy: userId, content: 'stuck', status: 'publishing',
      publishingStartedAt: new Date(Date.now() - 60 * MIN), lockedBy: 'dead:1', lastAttemptAt: new Date(Date.now() - 60 * MIN), publishTrigger: 'scheduler', attempts: 1,
    });
    const overdue = await SocialPublication.create({ project_id: p._id, social_account_id: account._id, platform: 'facebook', createdBy: userId, content: 'overdue', status: 'scheduled', scheduledAt: new Date(Date.now() - 24 * 60 * MIN) });
    await setProjectTrashed(p._id, true);

    const calls = await withGraph(async (c) => {
      assert.equal((await recoverStalePublications({ projectId: String(p._id) })).found, 0);
      assert.equal((await reconcileUnknownOutcomes({ projectId: String(p._id) })).found, 0);
      assert.equal((await markMissedPublications({ projectId: String(p._id) })).missed, 0);
      await recoverStalePublications({});
      return c;
    });
    assert.equal(calls.length, 0, 'no Graph request for a trashed project');
    assert.equal((await SocialPublication.findById(stuck._id)).status, 'publishing');
    assert.equal((await SocialPublication.findById(overdue._id)).status, 'scheduled', 'not marked missed while in the trash');
  });

  test('7: deleted between the scan and the claim - the claimed post is handed back and never reaches Meta', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const { scheduled, pageId } = await seed(p);

    const original = SocialPublication.findOneAndUpdate;
    SocialPublication.findOneAndUpdate = async function patched(filter, ...rest) {
      const result = await original.call(this, filter, ...rest);
      if (filter?.status === 'scheduled' && result?.status === 'publishing') await setProjectTrashed(p._id, true); // the project is deleted right after the claim
      return result;
    };
    let outcome;
    let calls;
    try {
      calls = await withGraph(async (c) => { outcome = await publishNow(String(p._id), String(scheduled._id), null, { trigger: 'scheduler' }); return c; });
    } finally { SocialPublication.findOneAndUpdate = original; }

    assert.equal(outcome.success, false);
    assert.equal(outcome.error.code, 'PROJECT_UNAVAILABLE');
    assert.equal(posts(calls).filter((c) => String(c.path).includes(pageId)).length, 0);
    const row = await SocialPublication.findById(scheduled._id);
    assert.equal(row.status, 'scheduled', 'handed back, schedule intact');
    assert.equal(row.attempts, 0, 'the aborted attempt is not counted');
    assert.equal(row.lockedBy, null);
  });

  /** Makes ONE raw-collection operation fail once (the next call to `op` on `collectionName`), then restores itself. */
  const failOnce = (collectionName, op) => {
    const db = mongoose.connection.db;
    const realCollection = db.collection.bind(db);
    let failures = 0;
    db.collection = (name, ...rest) => {
      const c = realCollection(name, ...rest);
      if (name !== collectionName || failures >= 1) return c;
      return new Proxy(c, { get: (target, prop) => (prop === op ? async () => { failures += 1; throw new Error('simulated mongo failure'); } : (typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop])) });
    };
    return () => { db.collection = realCollection; };
  };

  test('8: publications cannot be deleted - the project is kept for a retry, no credential remains, nothing can be published; the retry finishes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    await seed(p);
    await setProjectTrashed(p._id, true); // a permanent purge only ever runs on a trashed project

    const restore = failOnce('socialpublications', 'deleteMany');
    let first;
    try { first = await deleteProjectCascade(String(p._id)); } finally { restore(); }

    assert.equal(first.retryable, true);
    assert.equal(first.projectDeleted, false, 'the project stays in place so the daily purge retries it');
    assert.ok(first.failures.some((f) => f.collection === 'social:publications'));
    assert.ok(!JSON.stringify(first).includes(TOKEN), 'the failure report never contains a secret');
    assert.equal(await SocialAccount.countDocuments({ project_id: p._id }), 0, 'no stored credential is left');
    assert.equal(await SocialPublication.countDocuments({ project_id: p._id, status: 'scheduled' }), 1, 'the scheduled post is still there');

    const calls = await withGraph(async (c) => { await executeDuePublications({}); await executeDuePublications({ projectId: String(p._id) }); return c; });
    assert.equal(posts(calls).length, 0, 'the leftover scheduled post cannot go out');

    const second = await deleteProjectCascade(String(p._id));
    assert.equal(second.retryable, false);
    assert.equal(second.projectDeleted, true);
    assert.equal(await SocialPublication.countDocuments({ project_id: p._id }), 0);
    assert.equal(await SocialProjectCleanup.countDocuments({ project_id: p._id }), 1, 'the trace written before the failure is kept, once');
  });

  test('8b: credentials cannot be invalidated - the project stays trashed (not dispatchable), nothing is deleted, and the retry completes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const { pageId } = await seed(p);
    await setProjectTrashed(p._id, true);

    const restore = failOnce('socialaccounts', 'updateMany');
    let first;
    try { first = await deleteProjectCascade(String(p._id)); } finally { restore(); }

    assert.equal(first.retryable, true);
    assert.equal(first.projectDeleted, false);
    assert.ok(first.failures.some((f) => f.collection === "social:credentials"));
    const calls = await withGraph(async (c) => { await executeDuePublications({}); return c; });
    assert.equal(posts(calls).filter((c) => String(c.path).includes(pageId)).length, 0, 'a trashed project is never dispatched, even with an intact credential');

    const second = await deleteProjectCascade(String(p._id));
    assert.equal(second.projectDeleted, true);
    assert.equal(await SocialAccount.countDocuments({ project_id: p._id }), 0);
    assert.equal(await SocialProjectCleanup.countDocuments({ project_id: p._id }), 1);
  });

  test('9: the orphan sweep removes social rows of projects that no longer exist, and only those', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const live = await project();
    await seed(live);
    const goneId = new mongoose.Types.ObjectId();
    await SocialAccount.create({ user_id: userId, project_id: goneId, platform: 'facebook', platformAccountId: `pg_${goneId}`, pageId: `pg_${goneId}`, accountType: 'page', accessToken: TOKEN, status: 'active', isActive: true });
    await SocialImportBatch.collection.insertOne({ project_id: goneId, status: 'imported', createdAt: new Date() });

    const result = await purgeOrphanedSocialData();

    assert.ok(result.purged >= 1);
    assert.equal(await SocialAccount.countDocuments({ project_id: goneId }), 0);
    assert.equal(await SocialImportBatch.countDocuments({ project_id: goneId }), 0);
    assert.equal(await SocialAccount.countDocuments({ project_id: live._id, status: 'active' }), 1, 'a live project is never swept');
    assert.equal(await SocialPublication.countDocuments({ project_id: live._id }), 2);
    await SocialProjectCleanup.deleteMany({ project_id: goneId });
  });

  test('10: purgeProjectSocialData on a project without any social data is a no-op with no trace', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const result = await purgeProjectSocialData(String(p._id));
    assert.equal(result.retryable, false);
    assert.equal(result.counts.accounts, 0);
    assert.equal(await SocialProjectCleanup.countDocuments({ project_id: p._id }), 0);
  });
});
