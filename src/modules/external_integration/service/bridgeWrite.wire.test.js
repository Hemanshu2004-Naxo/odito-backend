import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import { WordPressConnectionError } from './wordPressService.js';

/**
 * Wire-level proof for the WRITE routes added for the reliability work (conditional alt text, Organization settings): real axios, real
 * HTTP against local fake servers. 127.0.0.1 is reachable here only because wpRequest never re-validates a stored site URL
 * (connect-time validation rejects local addresses; see wordPressService.wire.test.js).
 *
 * What is proven: a redirecting site is never followed (so neither the Application Password nor the request body reaches another host),
 * an attachment id can only ever be an integer path segment, and the alt-text request names no field.
 */

const USER = 'clinic-admin';
const APP_PASSWORD = 'AbCd EfGh IjKl MnOp QrSt UvWx';
const servers = [];
const seen = { origin: [], attacker: [] };

const listen = (name, handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen[name].push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
});

let attacker; let redirector; let ok;
before(async () => {
  attacker = await listen('attacker', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  // A site (or something in front of it) answering every write with a redirect — to another host, and to the cloud metadata address.
  let n = 0;
  redirector = await listen('origin', (req, res) => {
    n += 1;
    const location = n % 2 ? `${attacker}/wp-json/odito/v1/media/7/alt` : 'http://169.254.169.254/latest/meta-data/';
    res.writeHead([301, 302, 307, 308][n % 4], { Location: location });
    res.end();
  });
  ok = await listen('origin', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 7, alt: 'x', file: '2026/10/a.png', operation: { id: 'op-1', atomic: true } }));
  });
});
after(() => servers.forEach((s) => s.close()));

const conn = (site_url) => ({ site_url, username: USER, application_password: APP_PASSWORD });
const reset = () => { seen.origin.length = 0; seen.attacker.length = 0; };

describe('redirects on the write routes', () => {
  test('a redirected conditional alt write is not followed: no second request, the other host never hears of it, no credentials leave', async () => {
    reset();
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(
        oditoSeoBridgeService.swapMediaAlt(conn(redirector), 7, { value: 'Alt text', expected: '', expectedFile: '2026/10/a.png' }),
        (e) => e instanceof WordPressConnectionError && ['UNKNOWN_ERROR', 'WRITE_FAILED', 'SITE_REDIRECTS'].includes(e.code),
      );
    }
    assert.equal(seen.attacker.length, 0, 'the redirect target was never contacted');
    assert.equal(seen.origin.length, 4, 'exactly one request per attempt, none follow-up');
    assert.ok(seen.origin.every((r) => r.method === 'PUT'));
  });

  test('a redirected Organization write is not followed either', async () => {
    reset();
    await assert.rejects(oditoSeoBridgeService.updateSiteSchemaField(conn(redirector), 'organization', 'name', 'Clinic', null, { expected: '' }), WordPressConnectionError);
    assert.equal(seen.attacker.length, 0);
    assert.equal(seen.origin.length, 1);
  });

  test('a redirect is never mistaken for a conflict, so it cannot trigger a "reconcile and retry"', async () => {
    reset();
    const e = await oditoSeoBridgeService.swapMediaAlt(conn(redirector), 7, { value: 'Alt', expected: '', expectedFile: 'f' }).catch((x) => x);
    assert.notEqual(e.code, 'CONFLICT');
  });
});

describe('what an alt-text write puts on the wire', () => {
  test('PUT /wp-json/odito/v1/media/<integer>/alt with a body of exactly value, expected and expectedFile', async () => {
    reset();
    const r = await oditoSeoBridgeService.swapMediaAlt(conn(ok), 7, { value: 'A clinic reception desk', expected: '', expectedFile: '2026/10/a.png' });
    assert.equal(r.operation.id, 'op-1');
    const req = seen.origin[0];
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/wp-json/odito/v1/media/7/alt');
    assert.deepEqual(Object.keys(JSON.parse(req.body)).sort(), ['expected', 'expectedFile', 'value']);
    assert.equal(req.authorization, `Basic ${Buffer.from(`${USER}:${APP_PASSWORD}`).toString('base64')}`);
  });

  test('an attachment id that is not a positive integer never becomes a request path (no traversal, no extra segments)', async () => {
    reset();
    for (const bad of ['7/../../users/me', '../7', '7?x=1', '7#a', 'abc', '', null, undefined, {}, [], -7, 0, 7.5, Infinity, NaN]) {
      await assert.rejects(oditoSeoBridgeService.swapMediaAlt(conn(ok), bad, { value: 'x', expected: '', expectedFile: 'f' }), WordPressConnectionError, String(bad));
      await assert.rejects(oditoSeoBridgeService.readMediaAlt(conn(ok), bad), WordPressConnectionError, String(bad));
    }
    assert.equal(seen.origin.length, 0, 'nothing was sent for any of them');
  });
});

describe('Odito never fetches an image URL on these paths', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    '../mediaFix/altFixService.js', '../mediaFix/altFixPlan.js', '../mediaFix/altTargetRollup.js', '../mediaFix/imageIdentity.js', '../mediaFix/imageIdentityResolver.js',
    '../schemaFix/organizationFixService.js', '../schemaFix/organizationFixPlan.js', '../ledger/fixLedger.js', '../ledger/siteScope.js',
  ];
  test('the alt/Organization fix code contains no HTTP client of its own (all traffic goes through the audited wpRequest helper)', () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(here, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(src, /\bfetch\s*\(|from ['"]axios['"]|from ['"]node-fetch['"]|from ['"]got['"]|require\(['"]https?['"]\)|from ['"]node:https?['"]|\bhttps?\.request\s*\(/, f);
    }
  });
});
