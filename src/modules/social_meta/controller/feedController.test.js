import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
import facebookPageDataService from '../service/facebookPageDataService.js';
import { getFeedsHandler, syncFeedsHandler } from './feedController.js';

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

function mockReq(projectId, query = {}, body = {}) {
  return { projectId, query, body };
}

describe('getFeedsHandler — input validation', () => {
  test('1: an invalid platform value is rejected with 400, never silently ignored', async () => {
    const res = mockRes();
    await getFeedsHandler(mockReq('proj-1', { platform: 'snapchat' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_PLATFORM');
  });

  test('2: an invalid sort value is rejected with 400', async () => {
    const res = mockRes();
    await getFeedsHandler(mockReq('proj-1', { sort: 'random' }), res);
    assert.equal(res.statusCode, 400);
  });

  test('3: a malformed "from" date is rejected with 400', async () => {
    const res = mockRes();
    await getFeedsHandler(mockReq('proj-1', { from: 'not-a-date' }), res);
    assert.equal(res.statusCode, 400);
  });

  test('4: an overlong search string is rejected with 400 rather than sent unbounded to the database', async () => {
    const res = mockRes();
    await getFeedsHandler(mockReq('proj-1', { search: 'a'.repeat(500) }), res);
    assert.equal(res.statusCode, 400);
  });
});

describe('getFeedsHandler / syncFeedsHandler — real MongoDB, project isolation', () => {
  let project;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Feed Controller Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['feed controller test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPost.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('5: getFeedsHandler only ever returns THIS project\'s posts, using req.projectId — never a client-supplied project scope beyond it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      externalPostId: 'ctrl1', accountId: 'acct', status: 'published', publishedAt: new Date(),
      metrics: { likes: 1, comments: null, shares: null, views: null },
    });

    const res = mockRes();
    // allAccounts:true — this test is about project isolation and the
    // aggregate() ObjectId-casting regression, not account scoping (no
    // SocialAccount exists for this project at all, so the new default
    // active-account scoping would otherwise correctly return empty here).
    await getFeedsHandler(mockReq(project._id.toString(), { allAccounts: 'true' }), res);
    assert.equal(res.statusCode, null); // res.json() without an explicit status() call means the default 200
    assert.equal(res.body.data.data.length, 1);
    assert.equal(res.body.data.data[0].externalPostId, 'ctrl1');
    // Regression guard: req.projectId is always a STRING (from
    // req.query.projectId), never an ObjectId — a real, shipped bug had
    // the post list correct (via .find()'s automatic string->ObjectId
    // casting) while summary.facebook/summary.all stayed 0 forever,
    // because Mongoose's aggregate() does NOT apply that same casting.
    assert.equal(res.body.data.summary.all, 1, 'summary must be correct for a string projectId, not just an ObjectId');
    assert.equal(res.body.data.summary.facebook, 1);
  });

  test('5b: without allAccounts, the default is account-scoped — a post with no matching active account never appears', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      externalPostId: 'unscoped1', accountId: 'acct', status: 'published', publishedAt: new Date(),
      metrics: { likes: 1, comments: null, shares: null, views: null },
    });
    const res = mockRes();
    await getFeedsHandler(mockReq(project._id.toString(), {}), res);
    assert.equal(res.body.data.data.length, 0, 'no active Facebook Page exists for this project — scoped default must not fall back to every post');
  });

  test('5c: allAccounts=true is honored end-to-end through the real HTTP handler', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      externalPostId: 'allacc1', accountId: 'acct', status: 'published', publishedAt: new Date(),
      metrics: { likes: 1, comments: null, shares: null, views: null },
    });
    const res = mockRes();
    await getFeedsHandler(mockReq(project._id.toString(), { allAccounts: 'true' }), res);
    assert.equal(res.body.data.data.length, 1);
    assert.equal(res.body.data.data[0].externalPostId, 'allacc1');
  });

  test('6: syncFeedsHandler runs a real sync and never leaks an access token anywhere in the response body', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_ctrl', platformAccountName: 'Ctrl Page', accountType: 'page',
      pageId: 'pg_ctrl', accessToken: 'super-secret-real-token-value', status: 'active', isActive: true,
    });

    const original = facebookPageDataService.getPagePosts;
    facebookPageDataService.getPagePosts = async () => ({ success: true, posts: [], error: null, nextCursor: null });
    try {
      const res = mockRes();
      await syncFeedsHandler(mockReq(project._id.toString(), {}, {}), res);
      assert.equal(res.body.success, true);
      const bodyText = JSON.stringify(res.body);
      assert.ok(!bodyText.includes('super-secret-real-token-value'), 'access token must never appear in the sync response');
    } finally {
      facebookPageDataService.getPagePosts = original;
    }
  });
});
