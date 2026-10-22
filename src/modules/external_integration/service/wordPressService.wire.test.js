import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import wordPressService, { WordPressConnectionError } from './wordPressService.js';

/**
 * Wire-level proof of what Odito actually puts on the network. Real axios, real
 * HTTP, against local fake WordPress servers (127.0.0.1 is reachable here only
 * because wpRequest(), the shared authenticated helper that verifyCredentials()
 * mirrors — same buildAuthHeader, same maxRedirects:0, same validateStatus —
 * never re-validates the stored site URL; connectWordPress() still rejects
 * local addresses through validateUrl()).
 */

const USER = 'clinic-admin';
const APP_PASSWORD = 'AbCd EfGh IjKl MnOp QrSt UvWx';
const EXPECTED = `Basic ${Buffer.from(`${USER}:${APP_PASSWORD}`).toString('base64')}`;

const servers = [];
const seen = { good: [], strip: [], redirecting: [], attacker: [] };

function listen(name, handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen[name].push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

let good; let strip; let redirecting; let attacker;
before(async () => {
  // Healthy WordPress: Application Password auth works when the header arrives.
  good = await listen('good', (req, res) => {
    if (req.headers.authorization === EXPECTED) return json(res, 200, { id: 7, name: USER });
    return json(res, 401, { code: 'incorrect_password', message: 'bad', data: { status: 401 } });
  });
  // Host that drops Authorization before PHP (what rest_not_logged_in means): answers as if no header was sent.
  strip = await listen('strip', (req, res) => json(res, 401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.', data: { status: 401 } }));
  attacker = await listen('attacker', (req, res) => json(res, 200, { id: 1 }));
  redirecting = await listen('redirecting', (req, res) => json(res, 301, {}, { Location: `${attacker}/wp-json/wp/v2/users/me` }));
});
after(() => servers.forEach((s) => s.close()));

const conn = (site_url) => ({ site_url, username: USER, application_password: APP_PASSWORD });

describe('what Odito sends for the credential check', () => {
  test('GET /wp-json/wp/v2/users/me with exactly "Basic base64(user:applicationPassword)" (spaces preserved)', async () => {
    const r = await wordPressService.wpRequest(conn(good), { path: '/wp-json/wp/v2/users/me' });
    assert.equal(r.status, 200);
    const req = seen.good.at(-1);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/wp-json/wp/v2/users/me');
    assert.equal(req.authorization, EXPECTED);
  });

  test('a host that delivers the header authenticates; the same request to a host that drops it gets rest_not_logged_in', async () => {
    assert.equal((await wordPressService.wpRequest(conn(good), { path: '/wp-json/wp/v2/users/me' })).status, 200);

    const r = await wordPressService.wpRequest(conn(strip), { path: '/wp-json/wp/v2/users/me', skipErrorClassification: true });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'rest_not_logged_in');
    // ...even though the header WAS on the wire — so the request itself was correctly formed.
    assert.equal(seen.strip.at(-1).authorization, EXPECTED);
  });
});

describe('redirects never carry credentials to another origin', () => {
  test('a 301 to a different host is not followed and the other host never sees an Authorization header', async () => {
    await assert.rejects(
      wordPressService.wpRequest(conn(redirecting), { path: '/wp-json/wp/v2/users/me' }),
      (err) => err instanceof WordPressConnectionError && err.code === 'SITE_REDIRECTS'
    );
    assert.equal(seen.redirecting.at(-1).authorization, EXPECTED); // sent only to the origin the user entered
    assert.equal(seen.attacker.length, 0); // redirect target was never contacted
  });
});
