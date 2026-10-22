import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import metaApiService from './metaApiService.js';
import { listPublications, getPublication, publishNow, executeDuePublications } from './socialPublishingService.js';
import { recoverStalePublications } from './socialPublishRecoveryService.js';
import { ensureProject, removeProject } from '../testSupport/projectFixture.js';

/**
 * The derived `canRetry` flag: the backend — not each UI — decides whether a
 * manual "Retry Publish" is safe and sensible. Real MongoDB; real adapters +
 * classifier; only the Graph HTTP layer is replaced.
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
const http = (status, error) => ({ success: false, kind: 'http', status, data: error ? { error } : null, message: 'x' });
const listOf = (...items) => ({ success: true, status: 200, data: { data: items } });

async function withGraph(handler, fn) {
  const original = metaApiService.request;
  metaApiService.request = async (o) => handler(o);
  try { return await fn(); } finally { metaApiService.request = original; }
}

describe('publication.canRetry', () => {
  let userId, projectId, project, fb;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    projectId = new mongoose.Types.ObjectId();
    await ensureProject(projectId, { userId });
    project = projectId.toString();
    fb = await SocialAccount.create({ user_id: userId, project_id: projectId, platform: 'facebook', platformAccountId: 'pg_cr', pageId: 'pg_cr', accountType: 'page', accessToken: 'tok', status: 'active', isActive: true, scopes: ['pages_manage_posts'] });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: projectId });
    await SocialAccount.deleteMany({ project_id: projectId });
    await removeProject(projectId);
  });

  const row = (over = {}) => SocialPublication.create({
    project_id: projectId, social_account_id: fb._id, platform: 'facebook', content: `c-${Math.random()}`, status: 'draft', createdBy: userId, ...over,
  });
  /** Publish a fresh draft manually against a stubbed Graph response, return the API publication. */
  async function failWith(response) {
    const r = await row();
    const out = await withGraph((o) => (o.method === 'POST' ? response : listOf()), () => publishNow(project, r._id.toString(), userId));
    return out.publication;
  }

  test('a manual failure the classifier calls RETRYABLE (rate limit) can be retried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith(http(400, { type: 'OAuthException', code: 613, message: 'rate' }));
    assert.equal(p.status, 'failed');
    assert.equal(p.canRetry, true);
  });

  test('a PERMANENT Meta rejection cannot be retried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith(http(400, { type: 'GraphMethodException', code: 100, message: 'Invalid parameter' }));
    assert.equal(p.status, 'failed');
    assert.equal(p.canRetry, false);
  });

  test('expired authentication cannot be retried and says reconnect is required', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith(http(400, { type: 'OAuthException', code: 190, message: 'expired' }));
    assert.equal(p.canRetry, false);
    assert.equal(p.requiresReconnect, true);
  });

  test('a missing publishing permission cannot be retried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith(http(403, { type: 'OAuthException', code: 200, message: '(#200) requires pages_manage_posts permission' }));
    assert.equal(p.canRetry, false);
  });

  test('invalid media cannot be retried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith(http(400, { type: 'OAuthException', code: 9004, message: 'Only photo or video can be accepted as media type' }));
    assert.equal(p.failureCode, 'FACEBOOK_MEDIA_INVALID');
    assert.equal(p.canRetry, false);
  });

  test('an UNKNOWN publish outcome can NEVER be retried (re-sending could duplicate the post)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await failWith({ success: false, kind: 'timeout', status: null, data: null, message: 't' });
    assert.equal(p.outcomeUnknown, true);
    assert.equal(p.canRetry, false);
  });

  test('a missed schedule, exhausted retries and an interrupted-and-verified publish CAN be retried', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // missed
    const missed = await row({ status: 'scheduled', scheduledAt: new Date(Date.now() - 5 * 60 * MIN) });
    await executeDuePublications({ projectId });
    assert.equal((await getPublication(project, missed._id)).canRetry, true);
    assert.equal((await getPublication(project, missed._id)).failureCode, 'SCHEDULE_MISSED');

    // exhausted: 4th attempt of a retryable error
    const ex = await row({ status: 'scheduled', scheduledAt: new Date(Date.now() - MIN), attempts: 3 });
    await withGraph((o) => (o.method === 'POST' ? http(400, { type: 'OAuthException', code: 4, message: 'rate' }) : listOf()), () => publishNow(project, ex._id.toString(), null, { trigger: 'scheduler' }));
    const exApi = await getPublication(project, ex._id);
    assert.equal(exApi.failureCode, 'MAX_RETRIES_EXCEEDED');
    assert.equal(exApi.canRetry, true);

    // interrupted + verified not published (manual trigger)
    const orphan = await row({ status: 'publishing', publishTrigger: 'manual', attempts: 1, publishingStartedAt: new Date(Date.now() - 30 * MIN), lastAttemptAt: new Date(Date.now() - 30 * MIN), lockedBy: 'dead' });
    await withGraph(() => listOf(), () => recoverStalePublications({ projectId }));
    const orApi = await getPublication(project, orphan._id);
    assert.equal(orApi.failureCode, 'PUBLISH_INTERRUPTED');
    assert.equal(orApi.canRetry, true);
  });

  test('only FAILED posts are retryable; scheduled / published / cancelled / draft are not', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const status of ['draft', 'scheduled', 'publishing', 'published', 'cancelled']) {
      const r = await row({ status, scheduledAt: new Date(Date.now() + 3600_000), externalPostId: status === 'published' ? 'ext1' : null });
      assert.equal((await getPublication(project, r._id)).canRetry, false, status);
    }
  });

  test('a legacy failed row (no stored verdict) with an ordinary failure code stays retryable; with a hard-block code it does not', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const legacy = await row({ status: 'failed', failureCode: 'FACEBOOK_PUBLISH_FAILED', failureReason: 'Meta rejected this post.' });
    const media = await row({ status: 'failed', failureCode: 'MEDIA_REQUIRED', failureReason: 'Instagram requires a photo or video.' });
    assert.equal((await getPublication(project, legacy._id)).canRetry, true);
    assert.equal((await getPublication(project, media._id)).canRetry, false);
  });

  test('the list endpoint payload carries canRetry for every row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await row({ status: 'failed', failureCode: 'FACEBOOK_RATE_LIMITED', failureRetryable: true });
    await row({ status: 'failed', failureCode: 'FACEBOOK_PUBLISH_FAILED', failureRetryable: false });
    const { data } = await listPublications(project, { status: 'failed' });
    assert.deepEqual(data.map((d) => d.canRetry).sort(), [false, true]);
  });
});
