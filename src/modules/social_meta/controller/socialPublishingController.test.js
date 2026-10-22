import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import adapters from '../service/platformAdapters/index.js';
import { executeDuePublications } from '../service/socialPublishingService.js';
import {
  listPublicationsHandler, createPublicationHandler, getPublicationHandler, publishPublicationHandler,
  deletePublicationHandler,
} from './socialPublishingController.js';
import '../testSupport/stubPermalinkLookup.js';

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

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('socialPublishingController — input validation', () => {
  test('1: an invalid platform filter is rejected with 400', async () => {
    const res = mockRes();
    await listPublicationsHandler({ projectId: 'proj-1', query: { platform: 'snapchat' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_PLATFORM');
  });

  test('2: an invalid status filter is rejected with 400', async () => {
    const res = mockRes();
    await listPublicationsHandler({ projectId: 'proj-1', query: { status: 'nonsense' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

describe('socialPublishingController — real MongoDB, project ownership, :publicationId safety', () => {
  let project, userId, account;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Publishing Ctrl Test ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['publishing controller test'],
    });
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_ctrl_pub',
      platformAccountName: 'Ctrl Publishing Page', accountType: 'page', pageId: 'pg_ctrl_pub', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('3: creating a publication via the HTTP handler persists a real draft scoped to req.projectId/req.userId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: account._id.toString(), content: 'From the API' },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.publication.status, 'draft');
    const stored = await SocialPublication.findById(res.body.data.publication.id);
    assert.equal(stored.project_id.toString(), project._id.toString());
  });

  test('4: getPublicationHandler cannot be tricked into treating :publicationId as a project id — a publication from ANOTHER project 404s, never returns cross-project data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: userId, project_name: `Other Ctrl ${Date.now()}`, main_url: 'https://otherctrl.example.com', seo_scope: 'local', keywords: ['other'] });
    const otherAccount = await SocialAccount.create({
      user_id: userId, project_id: otherProject._id, platform: 'facebook', platformAccountId: 'pg_other_ctrl',
      platformAccountName: 'Other Ctrl Page', accountType: 'page', pageId: 'pg_other_ctrl', accessToken: 'real-token', status: 'active',
    });
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: otherProject._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: otherAccount._id.toString(), content: 'Belongs to the other project' },
    }, createRes);
    const otherPublicationId = createRes.body.data.publication.id;

    // Request THIS project's data but pass the OTHER project's publication id
    // as :publicationId — this is exactly the shape that would be dangerous
    // if validateProjectAccess() ever misread this route param as the
    // project id instead of req.query/body.projectId.
    const res = mockRes();
    await getPublicationHandler({ projectId: project._id.toString(), params: { publicationId: otherPublicationId } }, res);
    assert.equal(res.statusCode, 404);

    await SocialPublication.deleteMany({ project_id: otherProject._id });
    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('5: a real publish through the HTTP handler never leaks the access token in the response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Publish via HTTP' },
    }, createRes);
    const publicationId = createRes.body.data.publication.id;

    const original = adapters.facebook.publish;
    adapters.facebook.publish = async () => ({ success: true, externalPostId: 'http_real_post_1', error: null });
    try {
      const res = mockRes();
      await publishPublicationHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { publicationId } }, res);
      assert.equal(res.body.data.publication.status, 'published');
      const bodyText = JSON.stringify(res.body);
      assert.ok(!bodyText.includes('real-token'));
    } finally {
      adapters.facebook.publish = original;
    }
  });

  // Regression coverage for the "scheduled post publishes immediately"
  // investigation: schedules a post through the exact same HTTP handler
  // the real Create Post -> Schedule flow uses, with publishNow explicitly
  // false and a real future scheduledAt (5-10 minutes out, matching the
  // reported repro), and proves — against real MongoDB, not a mock —
  // that (a) it lands as status='scheduled'/publishedAt=null immediately,
  // (b) the adapter is never called during creation, and (c) a real
  // executeDuePublications() tick run right afterward correctly leaves it
  // untouched because it is not yet due.
  test('6: scheduling 5-10 minutes in the future with publishNow:false creates status=scheduled/publishedAt=null, never calls the adapter, and is correctly skipped by the due-publication scheduler', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    let adapterCalled = false;
    const original = adapters.facebook.publish;
    adapters.facebook.publish = async () => { adapterCalled = true; return { success: true, externalPostId: 'should_never_be_called', error: null }; };

    try {
      const scheduledAt = new Date(Date.now() + 7 * 60 * 1000).toISOString(); // 7 minutes from now
      const res = mockRes();
      await createPublicationHandler({
        projectId: project._id.toString(), userId: userId.toString(),
        body: {
          platform: 'facebook', socialAccountId: account._id.toString(), content: 'Scheduled 7 minutes out',
          scheduledAt, timezone: 'Asia/Kolkata', publishNow: false,
        },
      }, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.data.publication.status, 'scheduled');
      assert.equal(res.body.data.publication.publishedAt, null);
      assert.equal(adapterCalled, false, 'the adapter must never be called while creating a scheduled post');

      const publicationId = res.body.data.publication.id;
      const storedImmediately = await SocialPublication.findById(publicationId);
      assert.equal(storedImmediately.status, 'scheduled');
      assert.equal(storedImmediately.publishedAt, null);
      assert.equal(storedImmediately.scheduledAt.toISOString(), new Date(scheduledAt).toISOString());

      // A real due-publication tick, run immediately after creation, must
      // NOT touch this post — it is 7 minutes away from being due.
      const summary = await executeDuePublications({ projectId: project._id });
      assert.equal(summary.results.some((r) => r.id === publicationId), false, 'a not-yet-due post must not appear in this tick\'s results at all');
      assert.equal(adapterCalled, false, 'the adapter must still never have been called after a due-publication tick, since this post is not due');

      const storedAfterTick = await SocialPublication.findById(publicationId);
      assert.equal(storedAfterTick.status, 'scheduled');
      assert.equal(storedAfterTick.publishedAt, null);
    } finally {
      adapters.facebook.publish = original;
    }
  });

  // Helper: create + publish a real Facebook post through the real HTTP
  // handlers, with adapters.facebook.publish mocked (Meta can't actually
  // publish for a fake token). Returns the publicationId.
  async function createAndPublishFacebook(content, externalPostId) {
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: account._id.toString(), content },
    }, createRes);
    const publicationId = createRes.body.data.publication.id;

    const originalPublish = adapters.facebook.publish;
    adapters.facebook.publish = async () => ({ success: true, externalPostId, error: null });
    try {
      const publishRes = mockRes();
      await publishPublicationHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { publicationId } }, publishRes);
      assert.equal(publishRes.body.data.publication.status, 'published');
    } finally {
      adapters.facebook.publish = originalPublish;
    }
    return publicationId;
  }

  // Regression coverage for "Implement Real External Social Post
  // Deletion": the DELETE endpoint must now attempt a REAL Meta DELETE
  // for a published Facebook post through the real HTTP handler chain,
  // and only remove the MongoDB record once that succeeds.
  test('7: DELETE succeeds for a genuinely published Facebook post — Meta DELETE is called for real (mocked at the adapter boundary) and the record is gone from MongoDB afterward', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const publicationId = await createAndPublishFacebook('Publish then delete', 'delete_me_1');

    let deleteCalledWith = null;
    const originalRemove = adapters.facebook.remove;
    adapters.facebook.remove = async ({ externalPostId }) => { deleteCalledWith = externalPostId; return { success: true, alreadyDeleted: false, error: null }; };
    let deleteRes;
    try {
      deleteRes = mockRes();
      await deletePublicationHandler({ projectId: project._id.toString(), params: { publicationId } }, deleteRes);
    } finally {
      adapters.facebook.remove = originalRemove;
    }

    assert.equal(deleteCalledWith, 'delete_me_1');
    // The success path calls res.json(...) with no explicit .status() call
    // first — real Express defaults an unset status to 200; this file's
    // mockRes() stub only records an EXPLICIT .status(code) call, so
    // statusCode staying null here (not 200) is this mock's own quirk, not
    // a real failure — the actually meaningful checks are the response
    // body and the real MongoDB state below.
    assert.equal(deleteRes.statusCode, null);
    assert.equal(deleteRes.body.success, true);
    assert.equal(deleteRes.body.data.deleted, true);
    assert.equal(await SocialPublication.findById(publicationId), null);
  });

  test('7b: DELETE returns a real error status and keeps the post visible when Meta DELETE fails', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const publicationId = await createAndPublishFacebook('Must survive via HTTP', 'survive_http_1');

    const originalRemove = adapters.facebook.remove;
    adapters.facebook.remove = async () => ({ success: false, alreadyDeleted: false, error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied this request — the Page connection may need to be reconnected. The post was NOT deleted.' } });
    let deleteRes;
    try {
      deleteRes = mockRes();
      await deletePublicationHandler({ projectId: project._id.toString(), params: { publicationId } }, deleteRes);
    } finally {
      adapters.facebook.remove = originalRemove;
    }

    assert.equal(deleteRes.statusCode, 409);
    assert.equal(deleteRes.body.success, false);
    assert.equal(deleteRes.body.details?.code, 'FACEBOOK_TOKEN_INVALID');
    const stillThere = await SocialPublication.findById(publicationId);
    assert.ok(stillThere, 'the post must still be visible — a failed external deletion must never remove the Odito record');
    assert.equal(stillThere.status, 'published');
  });

  test('7c: DELETE on a published Instagram post is rejected with EXTERNAL_DELETE_UNSUPPORTED (409) via the real HTTP handler, and the record remains', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const igAccount = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'ig_ctrl_delete',
      platformAccountName: 'ig_ctrl_delete', accountType: 'business', instagramBusinessAccountId: 'ig_ctrl_delete',
      accessToken: 'real-token', status: 'active', scopes: ['instagram_basic', 'instagram_content_publish'],
    });
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'instagram', socialAccountId: igAccount._id.toString(), content: 'IG via HTTP',
        media: [{ url: `${backend}/storage/social_media/${project._id.toString()}/img.png`, type: 'image' }] },
    }, createRes);
    const publicationId = createRes.body.data.publication.id;

    const originalIgPublish = adapters.instagram.publish;
    adapters.instagram.publish = async () => ({ success: true, externalPostId: 'ig_ctrl_media_1', error: null });
    try {
      const publishRes = mockRes();
      await publishPublicationHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { publicationId } }, publishRes);
      assert.equal(publishRes.body.data.publication.status, 'published');
    } finally {
      adapters.instagram.publish = originalIgPublish;
    }

    const deleteRes = mockRes();
    await deletePublicationHandler({ projectId: project._id.toString(), params: { publicationId } }, deleteRes);

    assert.equal(deleteRes.statusCode, 409);
    assert.equal(deleteRes.body.details?.code, 'EXTERNAL_DELETE_UNSUPPORTED');
    assert.ok(await SocialPublication.findById(publicationId));
  });

  test('7d: "Remove from Odito history" (body.historyOnly=true) succeeds via the real HTTP handler for a published Instagram post', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const igAccount = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'ig_ctrl_history',
      platformAccountName: 'ig_ctrl_history', accountType: 'business', instagramBusinessAccountId: 'ig_ctrl_history',
      accessToken: 'real-token', status: 'active', scopes: ['instagram_basic', 'instagram_content_publish'],
    });
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'instagram', socialAccountId: igAccount._id.toString(), content: 'IG history via HTTP',
        media: [{ url: `${backend}/storage/social_media/${project._id.toString()}/img.png`, type: 'image' }] },
    }, createRes);
    const publicationId = createRes.body.data.publication.id;

    const originalIgPublish = adapters.instagram.publish;
    adapters.instagram.publish = async () => ({ success: true, externalPostId: 'ig_ctrl_media_2', error: null });
    try {
      const publishRes = mockRes();
      await publishPublicationHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { publicationId } }, publishRes);
    } finally {
      adapters.instagram.publish = originalIgPublish;
    }

    const deleteRes = mockRes();
    await deletePublicationHandler({ projectId: project._id.toString(), params: { publicationId }, body: { historyOnly: true } }, deleteRes);

    assert.equal(deleteRes.body.success, true);
    assert.equal(deleteRes.body.data.deleted, true);
    assert.equal(await SocialPublication.findById(publicationId), null);
  });

  test('8: DELETE for a publication belonging to ANOTHER project still returns NOT_FOUND — never leaks or deletes cross-project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: userId, project_name: `Other Delete ${Date.now()}`, main_url: 'https://otherdelete.example.com', seo_scope: 'local', keywords: ['other'] });
    const otherAccount = await SocialAccount.create({
      user_id: userId, project_id: otherProject._id, platform: 'facebook', platformAccountId: 'pg_other_delete',
      platformAccountName: 'Other Delete Page', accountType: 'page', pageId: 'pg_other_delete', accessToken: 'real-token', status: 'active',
    });
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: otherProject._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: otherAccount._id.toString(), content: 'Belongs to the other project' },
    }, createRes);
    const otherPublicationId = createRes.body.data.publication.id;

    const deleteRes = mockRes();
    await deletePublicationHandler({ projectId: project._id.toString(), params: { publicationId: otherPublicationId } }, deleteRes);

    assert.equal(deleteRes.statusCode, 404);
    assert.equal(deleteRes.body.details?.code, 'NOT_FOUND');
    assert.ok(await SocialPublication.findById(otherPublicationId), 'the other project\'s document must still exist untouched');

    await SocialPublication.deleteMany({ project_id: otherProject._id });
    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });
});
