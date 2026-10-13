import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import { mintState } from '../testSupport/metaState.js';
import { handleMetaCallback } from './metaOAuthController.js';
import { getSocialAccountsStatus } from './socialAccountController.js';

/**
 * Backend support the Social Media AI frontend integration relies on:
 *  - the OAuth callback returns the browser to the module's own Connect
 *    Accounts screen (fixed return-target map — never an open redirect)
 *  - the status API exposes the safe display fields the UI renders
 *    (profile picture, account type) and still never a token.
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

const mockRes = () => ({
  statusCode: null, body: null, redirectedTo: null,
  status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, redirect(u) { this.redirectedTo = u; return this; }, send() { return this; },
});

describe('OAuth return target for /app/social-media/connect-accounts', () => {
  let userId, project;
  const saved = process.env.CORS_ORIGIN;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    process.env.CORS_ORIGIN = 'https://app.odito.example';
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `SMAI ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = saved;
    if (mongoAvailable) await SeoProject.deleteOne({ _id: project._id });
  });

  // A signed state whose project belongs to someone else is rejected AFTER the
  // return target is read from the state — so the redirect shows where the
  // browser is sent back to, without needing a real Meta exchange.
  const redirectFor = async (returnTo) => {
    const state = await mintState({ userId: new mongoose.Types.ObjectId(), projectId: project._id, returnTo: returnTo || null });
    const res = mockRes();
    await handleMetaCallback({ query: { code: 'c', state } }, res);
    return res.redirectedTo;
  };

  test('returnTo "social-media" sends the browser back to the Social Media AI Connect Accounts screen', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = await redirectFor('social-media');
    assert.ok(url.startsWith('https://app.odito.example/app/social-media/connect-accounts'), url);
    assert.ok(url.includes('meta_error=access_denied'));
  });

  test('the existing targets are unchanged (social, profile, and the default)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.ok((await redirectFor('social')).startsWith('https://app.odito.example/app/social?'));
    assert.ok((await redirectFor('profile')).startsWith('https://app.odito.example/app/settings/profile?'));
    assert.ok((await redirectFor(undefined)).startsWith('https://app.odito.example/app/social?'));
  });

  test('an unknown / hostile returnTo can never redirect anywhere else (no open redirect)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const bad of ['https://evil.example', '//evil.example', '/app/../../evil', 'social-media/../x']) {
      const url = await redirectFor(bad);
      assert.ok(url.startsWith('https://app.odito.example/app/social?'), `${bad} -> ${url}`);
      assert.ok(!url.includes('evil'));
    }
  });
});

describe('status API display fields', () => {
  let userId, projectId;
  beforeEach(() => { userId = new mongoose.Types.ObjectId(); projectId = new mongoose.Types.ObjectId(); });
  afterEach(async () => { if (mongoAvailable) await SocialAccount.deleteMany({ project_id: projectId }); });

  test('connected Facebook + Instagram expose picture and account type (and still no token)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const TOKEN = 'DISPLAY-FIELDS-SECRET-TOKEN';
    const base = { user_id: userId, project_id: projectId, accessToken: TOKEN, status: 'active', scopes: ['pages_manage_posts'] };
    await SocialAccount.create({ ...base, platform: 'facebook', platformAccountId: 'pg_d', pageId: 'pg_d', accountType: 'page', isActive: true, platformAccountName: 'Acme', metadata: { picture: 'https://cdn.example/fb.jpg', category: 'Marketing agency' } });
    await SocialAccount.create({ ...base, platform: 'instagram', platformAccountId: 'ig_d', pageId: 'pg_d', instagramBusinessAccountId: 'ig_d', accountType: 'business', platformAccountName: 'acme_ig', metadata: { username: 'acme_ig', profilePicture: 'https://cdn.example/ig.jpg' } });
    const res = mockRes();
    await getSocialAccountsStatus({ user: { _id: userId }, projectId: projectId.toString() }, res);
    const d = res.body.data;
    assert.equal(d.facebook.picture, 'https://cdn.example/fb.jpg');
    assert.equal(d.facebook.category, 'Marketing agency');
    assert.equal(d.facebook.accountType, 'page');
    assert.equal(d.instagram.picture, 'https://cdn.example/ig.jpg');
    assert.equal(d.instagram.accountType, 'business');
    assert.equal(d.instagram.username, 'acme_ig');
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));
  });

  test('a connected account with no stored picture reports picture:null, never a made-up value', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({ user_id: userId, project_id: projectId, accessToken: 't', status: 'active', platform: 'facebook', platformAccountId: 'pg_n', pageId: 'pg_n', accountType: 'page', isActive: true, scopes: [] });
    const res = mockRes();
    await getSocialAccountsStatus({ user: { _id: userId }, projectId: projectId.toString() }, res);
    assert.equal(res.body.data.facebook.picture, null);
  });
});
