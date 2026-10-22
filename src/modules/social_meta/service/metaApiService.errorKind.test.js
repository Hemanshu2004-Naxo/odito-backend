import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import metaApiService from './metaApiService.js';
import { classifyMetaFailure } from './metaErrorClassifier.js';

/**
 * REAL network behavior, no stubs: a local HTTP server misbehaves in the
 * ways a flaky Meta connection does, and requestAbsolute() must label each
 * failure so the publishing code can tell a DEFINITE failure ("Meta answered
 * with an error", "the request never left") from an UNKNOWN outcome ("the
 * request was sent but no usable answer came back") — the distinction that
 * prevents a lost-response publish from being re-sent as a duplicate post.
 */

let server;
let baseUrl;
let mode = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    if (mode === 'hang') return; // never answers -> client timeout
    if (mode === 'reset') { req.socket.destroy(); return; } // connection reset mid-request
    if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (mode === '400-190') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'OAuthException', code: 190, message: 'Error validating access token', fbtrace_id: 'T1' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: '123' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/x`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('metaApiService failure kinds (real sockets)', () => {
  test('a normal response is success (no kind needed)', async () => {
    mode = 'ok';
    const r = await metaApiService.requestAbsolute({ url: baseUrl });
    assert.equal(r.success, true);
  });

  test('Meta answering with an error is kind:"http" and keeps status + body (HTTP 400 code 190)', async () => {
    mode = '400-190';
    const r = await metaApiService.requestAbsolute({ url: baseUrl });
    assert.equal(r.success, false);
    assert.equal(r.kind, 'http');
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 190);
    // ... and the shared classifier turns exactly that into an expired token.
    assert.equal(classifyMetaFailure(r, { platform: 'facebook', finalPublishStep: true }).code, 'FACEBOOK_TOKEN_INVALID');
  });

  test('a 5xx is kind:"http"', async () => {
    mode = '500';
    const r = await metaApiService.requestAbsolute({ url: baseUrl });
    assert.equal(r.kind, 'http');
    assert.equal(r.status, 500);
  });

  test('a timeout (request sent, no answer) is kind:"timeout" => UNKNOWN outcome on the final publish call', async () => {
    mode = 'hang';
    const r = await metaApiService.requestAbsolute({ url: baseUrl, timeoutMs: 150 });
    assert.equal(r.success, false);
    assert.equal(r.kind, 'timeout');
    assert.equal(classifyMetaFailure(r, { platform: 'facebook', finalPublishStep: true }).outcome, 'unknown');
    assert.equal(classifyMetaFailure(r, { platform: 'facebook', finalPublishStep: false }).outcome, 'not_published');
  });

  test('a connection reset after the request was sent is kind:"network_unknown" => UNKNOWN outcome', async () => {
    mode = 'reset';
    const r = await metaApiService.requestAbsolute({ url: baseUrl });
    assert.equal(r.success, false);
    assert.equal(r.kind, 'network_unknown');
    assert.equal(classifyMetaFailure(r, { platform: 'instagram', finalPublishStep: true }).outcome, 'unknown');
  });

  test('connection refused (nothing listening) provably never reached Meta: kind:"network_unsent" => definite, retryable', async () => {
    // Grab a free port, then close it so nothing is listening there.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));

    const r = await metaApiService.requestAbsolute({ url: `http://127.0.0.1:${port}/x`, timeoutMs: 2000 });
    assert.equal(r.success, false);
    assert.equal(r.kind, 'network_unsent');
    const c = classifyMetaFailure(r, { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.outcome, 'not_published');
    assert.equal(c.retryable, true);
  });
});
