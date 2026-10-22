import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from './metaApiService.js';
import { buildAuthorizationUrl, fetchGrantedScopes, META_OAUTH_SCOPES } from './metaOAuthService.js';

async function withMockedRequest(request, fn) {
  const original = metaApiService.request;
  metaApiService.request = request;
  try {
    return await fn();
  } finally {
    metaApiService.request = original;
  }
}

/**
 * Root-cause regression coverage: every Facebook Page connected before
 * pages_manage_posts/instagram_content_publish were added to
 * META_OAUTH_SCOPES still cannot publish, even after a user re-clicked
 * "Connect" — because nothing ever forced Meta to show the permissions
 * dialog again for an already-authorized app, so Meta silently reused the
 * old grant. auth_type=rerequest (Meta's own documented parameter for
 * exactly this) is the fix; these tests lock in that it's opt-in only.
 */
describe('buildAuthorizationUrl — reconnect / auth_type', () => {
  test('a normal connect (no reconnect flag) never includes auth_type — must not force re-consent on every ordinary Connect', () => {
    const url = new URL(buildAuthorizationUrl({ redirectUri: 'https://x/callback', state: 's' }));
    assert.equal(url.searchParams.has('auth_type'), false);
  });

  test('reconnect:true adds auth_type=rerequest — the real, documented Meta parameter for re-showing declined/new permissions', () => {
    const url = new URL(buildAuthorizationUrl({ redirectUri: 'https://x/callback', state: 's', reconnect: true }));
    assert.equal(url.searchParams.get('auth_type'), 'rerequest');
  });

  test('reconnect:false behaves identically to omitting it', () => {
    const url = new URL(buildAuthorizationUrl({ redirectUri: 'https://x/callback', state: 's', reconnect: false }));
    assert.equal(url.searchParams.has('auth_type'), false);
  });

  test('the requested scopes always include the publishing permissions this app needs', () => {
    assert.ok(META_OAUTH_SCOPES.includes('pages_manage_posts'));
    assert.ok(META_OAUTH_SCOPES.includes('instagram_content_publish'));
    // No duplicates.
    assert.equal(new Set(META_OAUTH_SCOPES).size, META_OAUTH_SCOPES.length);
  });
});

describe('fetchGrantedScopes', () => {
  test('returns only permissions Meta reports as status:"granted", excluding declined ones', async () => {
    const granted = await withMockedRequest(async () => ({
      success: true, status: 200,
      data: { data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'declined' },
      ] },
    }), () => fetchGrantedScopes('fake_user_token'));

    assert.deepEqual(granted, ['pages_show_list', 'pages_read_engagement']);
    assert.equal(granted.includes('pages_manage_posts'), false);
  });

  test('never throws and returns an empty array (not the requested list) when the Graph call itself fails', async () => {
    const granted = await withMockedRequest(async () => ({ success: false, status: 400, data: null, message: 'bad token' }), () => fetchGrantedScopes('fake_user_token'));
    assert.deepEqual(granted, []);
  });

  test('never logs or returns the access token it was called with', async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };
    try {
      await withMockedRequest(async () => ({ success: true, status: 200, data: { data: [] } }), () => fetchGrantedScopes('THE_SECRET_TOKEN_VALUE'));
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.ok(!captured.join('\n').includes('THE_SECRET_TOKEN_VALUE'));
  });
});
