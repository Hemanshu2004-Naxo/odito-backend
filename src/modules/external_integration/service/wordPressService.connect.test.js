import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import WordPressConnection from '../model/WordPressConnection.js';

/**
 * Connect-flow classification of a 401 from /wp-json/wp/v2/users/me, plus the
 * temporary per-domain diagnostics. axios is mocked — no network, no database.
 */

const USER = 'clinic-admin';
const APP_PASSWORD = 'AbCd EfGh IjKl MnOp QrSt UvWx';
const BASIC = `Basic ${Buffer.from(`${USER}:${APP_PASSWORD}`).toString('base64')}`;

const wpRoot = { status: 200, data: { name: 'Krishna Eye Centre', namespaces: ['wp/v2', 'rankmath/v1'] }, headers: {} };
const unauthorized = (code, message) => ({ status: 401, data: { code, message, data: { status: 401 } }, headers: { server: 'hcdn' } });

let calls;
let logs;
function stubSite({ usersMe }) {
  mock.method(axios, 'get', async (url, config = {}) => {
    calls.push({ url, hasAuth: Boolean(config.headers?.Authorization) });
    if (url.endsWith('/wp-json/')) return wpRoot;
    if (url.endsWith('/wp-json/wp/v2/users/me')) return usersMe;
    return { status: 404, data: {}, headers: {} }; // plugins / version: best-effort, never fail the connection
  });
}
const connect = (siteUrl) => wordPressService.connectWordPress({
  projectId: 'p1', userId: 'u1', siteUrl, username: USER, applicationPassword: APP_PASSWORD,
});

beforeEach(() => {
  calls = [];
  logs = [];
  mock.method(console, 'log', (...a) => { logs.push(a.map(String).join(' ')); });
  delete process.env.WP_DIAGNOSTIC_HOSTS;
});
afterEach(() => mock.restoreAll());

describe('401 from users/me while an Authorization header WAS sent', () => {
  test('rest_not_logged_in -> AUTH_NOT_RECEIVED (not "invalid password"), keeps 401 and the WP code', async () => {
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'You are not currently logged in.') });
    await assert.rejects(connect('https://krishnaeyecentre.com/'), (err) => {
      assert.ok(err instanceof WordPressConnectionError);
      assert.equal(err.code, 'AUTH_NOT_RECEIVED');
      assert.equal(err.statusCode, 401);
      assert.equal(err.wpCode, 'rest_not_logged_in');
      assert.ok(!/Invalid WordPress username/.test(err.message));
      return true;
    });
    assert.deepEqual(calls.map((c) => c.hasAuth), [false, true]); // root is unauthenticated, users/me is authenticated
  });

  for (const wpCode of ['incorrect_password', 'invalid_username']) {
    test(`${wpCode} -> INVALID_CREDENTIALS exactly as before`, async () => {
      stubSite({ usersMe: unauthorized(wpCode, 'nope') });
      await assert.rejects(connect('https://krishnaeyecentre.com'), (err) => {
        assert.equal(err.code, 'INVALID_CREDENTIALS');
        assert.equal(err.message, 'Invalid WordPress username or Application Password.');
        assert.equal(err.statusCode, 401);
        assert.equal(err.wpCode, wpCode);
        return true;
      });
    });
  }

  test('a 401 with a non-WordPress body stays INVALID_CREDENTIALS, with no wpCode', async () => {
    stubSite({ usersMe: { status: 401, data: '<html>denied</html>', headers: {} } });
    await assert.rejects(connect('https://krishnaeyecentre.com'), (err) => {
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      assert.equal(err.wpCode, null);
      return true;
    });
  });

  test('a hostile WP error code is never carried through', async () => {
    stubSite({ usersMe: unauthorized('<script>alert(1)</script>', 'x') });
    await assert.rejects(connect('https://krishnaeyecentre.com'), (err) => {
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      assert.equal(err.wpCode, null);
      return true;
    });
  });
});

describe('a connection is only marked successful when users/me returns 200', () => {
  test('200 -> persisted as connected; nothing is saved on any 401', async () => {
    const save = mock.method(WordPressConnection, 'findOneAndUpdate', async (_q, update) => ({ ...update.$set }));
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'x') });
    await assert.rejects(connect('https://krishnaeyecentre.com'));
    assert.equal(save.mock.callCount(), 0);

    mock.restoreAll();
    mock.method(console, 'log', () => {});
    const saved = mock.method(WordPressConnection, 'findOneAndUpdate', async (_q, update) => ({ ...update.$set }));
    stubSite({ usersMe: { status: 200, data: { id: 7 }, headers: {} } });
    const status = await connect('https://krishnaeyecentre.com');
    assert.equal(status.connected, true);
    assert.equal(saved.mock.callCount(), 1);
  });
});

describe('temporary per-domain diagnostics', () => {
  test('logs requested/final URL, status, WP error and an Authorization boolean for krishnaeyecentre.com', async () => {
    stubSite({ usersMe: unauthorized('rest_not_logged_in', '<strong>Error:</strong> You are not currently logged in.') });
    await assert.rejects(connect('https://krishnaeyecentre.com'));
    const diag = logs.filter((l) => l.startsWith('[WORDPRESS-DIAG]')).map((l) => JSON.parse(l.slice('[WORDPRESS-DIAG] '.length)));
    assert.deepEqual(diag.map((d) => d.step), ['root-check', 'verify-credentials']);
    const auth = diag[1];
    assert.equal(auth.requestedUrl, 'https://krishnaeyecentre.com/wp-json/wp/v2/users/me');
    assert.equal(auth.finalUrl, auth.requestedUrl);
    assert.equal(auth.status, 401);
    assert.equal(auth.wpErrorCode, 'rest_not_logged_in');
    assert.equal(auth.wpErrorMessage, 'Error: You are not currently logged in.'); // tags stripped
    assert.equal(auth.authorizationAttached, true);
    assert.equal(diag[0].authorizationAttached, false);
  });

  test('never logs credentials, the Base64 token, the header, or cookies', async () => {
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'x') });
    await assert.rejects(connect('https://krishnaeyecentre.com'));
    const all = logs.join('\n');
    assert.ok(all.includes('[WORDPRESS-DIAG]'));
    for (const secret of [USER, APP_PASSWORD, APP_PASSWORD.replace(/ /g, ''), BASIC, BASIC.slice(6), 'Authorization: Basic', 'Basic ']) {
      assert.ok(!all.includes(secret), `log must not contain ${secret}`);
    }
  });

  test('a URL with userinfo/query never leaks them into the log', async () => {
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'x') });
    await assert.rejects(connect('https://bob:hunter2@krishnaeyecentre.com/?token=abc'));
    const all = logs.join('\n');
    assert.ok(!all.includes('hunter2') && !all.includes('token=abc'));
  });

  test('www. is treated as the same domain', async () => {
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'x') });
    await assert.rejects(connect('https://www.krishnaeyecentre.com'));
    assert.ok(logs.some((l) => l.startsWith('[WORDPRESS-DIAG]')));
  });

  test('other sites log nothing', async () => {
    stubSite({ usersMe: unauthorized('incorrect_password', 'x') });
    await assert.rejects(connect('https://some-other-site.com'));
    assert.equal(logs.filter((l) => l.includes('WORDPRESS-DIAG')).length, 0);
  });

  test('WP_DIAGNOSTIC_HOSTS overrides the domain list (empty disables)', async () => {
    process.env.WP_DIAGNOSTIC_HOSTS = ' ';
    stubSite({ usersMe: unauthorized('rest_not_logged_in', 'x') });
    await assert.rejects(connect('https://krishnaeyecentre.com'));
    assert.equal(logs.filter((l) => l.includes('WORDPRESS-DIAG')).length, 0);
  });

  test('a redirect is logged by host/path only and still surfaces as SITE_REDIRECTS', async () => {
    mock.method(axios, 'get', async () => ({ status: 301, data: '', headers: { location: 'https://www.krishnaeyecentre.com/wp-json/?x=1' } }));
    await assert.rejects(connect('https://krishnaeyecentre.com'), (err) => err.code === 'SITE_REDIRECTS');
    const d = JSON.parse(logs.find((l) => l.startsWith('[WORDPRESS-DIAG]')).slice('[WORDPRESS-DIAG] '.length));
    assert.equal(d.status, 301);
    assert.equal(d.redirectTo, 'https://www.krishnaeyecentre.com/wp-json/');
  });
});
