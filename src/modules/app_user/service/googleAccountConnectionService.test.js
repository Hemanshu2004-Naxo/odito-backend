import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import GoogleConnection from '../model/GoogleConnection.js';
import {
  getProjectGoogleServiceConnections,
  disconnectProjectGoogleConnection,
} from './googleAccountConnectionService.js';

/**
 * Independent Google account per service — the exact Section 30/39 scenario:
 * Google Ads/Search Console/Analytics/Business Profile each hold a
 * different Google account for one project, disconnecting one never
 * touches the others, and changing one (a fresh OAuth callback upsert,
 * exactly like oauth.routes.js's per-service branch does) never touches the
 * others either. Real MongoDB, real GoogleConnection documents — no mocked
 * DB layer — same convention as metaOAuth.phase1.test.js. revokeGoogleToken
 * is exercised for real (a fake token against Google's real revoke
 * endpoint); it is documented to never throw and always resolve, so this
 * never makes the test flaky - only the DB-side "marked revoked" outcome is
 * asserted, never whether Google's own revoke call itself succeeded.
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

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function connectionFixture({ userId, projectId, purpose, email }) {
  return {
    user_id: userId,
    project_id: projectId,
    purpose,
    service_type: [purpose],
    refresh_token: `fake-refresh-token-${purpose}`,
    access_token: `fake-access-token-${purpose}`,
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    google_email: email,
    google_name: email.split('@')[0],
    status: 'active',
  };
}

describe('googleAccountConnectionService — independent per-service Google connections', () => {
  let userA, userB, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    userB = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Google Services Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['google services test'],
    });

    await GoogleConnection.create([
      connectionFixture({ userId: userA, projectId: projectA._id, purpose: 'google_ads', email: 'accounta@example.com' }),
      connectionFixture({ userId: userA, projectId: projectA._id, purpose: 'search_console', email: 'accountb@example.com' }),
      connectionFixture({ userId: userA, projectId: projectA._id, purpose: 'analytics', email: 'accountc@example.com' }),
      connectionFixture({ userId: userA, projectId: projectA._id, purpose: 'business_profile', email: 'accountd@example.com' }),
    ]);
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await GoogleConnection.deleteMany({ project_id: projectA._id });
    await SeoProject.deleteOne({ _id: projectA._id });
  });

  test('each of the four services resolves to its own independent Google account', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const connections = await getProjectGoogleServiceConnections(userA, projectA._id);

    assert.equal(connections.google_ads.connected, true);
    assert.equal(connections.google_ads.email, 'accounta@example.com');
    assert.equal(connections.search_console.connected, true);
    assert.equal(connections.search_console.email, 'accountb@example.com');
    assert.equal(connections.analytics.connected, true);
    assert.equal(connections.analytics.email, 'accountc@example.com');
    assert.equal(connections.business_profile.connected, true);
    assert.equal(connections.business_profile.email, 'accountd@example.com');
  });

  test('a project with no connections at all reports every service as not_connected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bareProject = await SeoProject.create({
      user_id: userA,
      project_name: `Bare Project ${Date.now()}`,
      main_url: 'https://bare.example.com',
      seo_scope: 'local',
      keywords: ['bare'],
    });

    const connections = await getProjectGoogleServiceConnections(userA, bareProject._id);
    for (const service of ['google_ads', 'search_console', 'analytics', 'business_profile']) {
      assert.equal(connections[service].connected, false);
      assert.equal(connections[service].status, 'not_connected');
      assert.equal(connections[service].email, null);
    }

    await SeoProject.deleteOne({ _id: bareProject._id });
  });

  test('disconnecting Analytics only affects Analytics — Ads/Search Console/Business Profile stay connected under their original accounts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const result = await disconnectProjectGoogleConnection(userA, projectA._id, 'analytics');
    assert.equal(result.disconnected, true);

    const connections = await getProjectGoogleServiceConnections(userA, projectA._id);
    assert.equal(connections.analytics.connected, false);
    assert.equal(connections.analytics.status, 'revoked');

    assert.equal(connections.google_ads.connected, true);
    assert.equal(connections.google_ads.email, 'accounta@example.com');
    assert.equal(connections.search_console.connected, true);
    assert.equal(connections.search_console.email, 'accountb@example.com');
    assert.equal(connections.business_profile.connected, true);
    assert.equal(connections.business_profile.email, 'accountd@example.com');
  });

  test('changing the Google Ads account (a fresh OAuth callback upsert) never touches the other three services', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // First disconnect Analytics, exactly like the Section 39 scenario -
    // changing Ads afterward must not resurrect it or touch Search
    // Console/Business Profile.
    await disconnectProjectGoogleConnection(userA, projectA._id, 'analytics');

    // Mirrors oauth.routes.js's per-service callback branch: upsert on
    // {user_id, project_id, purpose}, same row, new identity.
    await GoogleConnection.findOneAndUpdate(
      { user_id: userA, project_id: projectA._id, purpose: 'google_ads' },
      { $set: { google_email: 'accounte@example.com', google_name: 'accountE', status: 'active', refresh_token: 'fake-refresh-token-google_ads-2' } },
      { upsert: true, new: true }
    );

    const connections = await getProjectGoogleServiceConnections(userA, projectA._id);
    assert.equal(connections.google_ads.connected, true);
    assert.equal(connections.google_ads.email, 'accounte@example.com');

    assert.equal(connections.search_console.connected, true);
    assert.equal(connections.search_console.email, 'accountb@example.com');
    assert.equal(connections.business_profile.connected, true);
    assert.equal(connections.business_profile.email, 'accountd@example.com');
    assert.equal(connections.analytics.connected, false);
  });

  test('disconnecting a project you do not own is rejected — cross-user isolation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await assert.rejects(
      () => disconnectProjectGoogleConnection(userB, projectA._id, 'google_ads'),
      (error) => {
        assert.equal(error.statusCode, 403);
        return true;
      }
    );

    // Untouched — the rejected attempt must not have revoked anything.
    const connections = await getProjectGoogleServiceConnections(userA, projectA._id);
    assert.equal(connections.google_ads.connected, true);
  });

  test('disconnecting an already-disconnected service is a safe no-op', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await disconnectProjectGoogleConnection(userA, projectA._id, 'business_profile');
    const second = await disconnectProjectGoogleConnection(userA, projectA._id, 'business_profile');
    assert.equal(second.disconnected, false);
    assert.equal(second.alreadyDisconnected, true);
  });

  test('rejects an invalid service name', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await assert.rejects(() => disconnectProjectGoogleConnection(userA, projectA._id, 'not_a_real_service'));
  });
});
