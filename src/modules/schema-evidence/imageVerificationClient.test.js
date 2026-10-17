import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetImageProbeCache, verifyImageUrls } from './imageVerificationClient.js';
import { probe404, probeOk } from './__fixtures__/clinicSite.js';

const WORKER = 'http://worker.test:8000';
const URL_A = 'https://clinic.example/a.png';
const URL_B = 'https://clinic.example/b.png';

const okPost = (calls) => async (endpoint, body, options) => {
  calls.push({ endpoint, body, options });
  return { data: { success: true, data: { results: body.urls.map((u) => (u.endsWith('b.png') ? probe404(u) : probeOk(u))) } } };
};

describe('verifyImageUrls', () => {
  beforeEach(() => resetImageProbeCache());

  test('batches distinct URLs into ONE worker call, preserves input order, and caps at 6', async () => {
    const calls = [];
    const many = Array.from({ length: 9 }, (_, i) => `https://clinic.example/i${i}.png`);
    const out = await verifyImageUrls([URL_A, URL_A, URL_B, ...many], { post: okPost(calls), workerUrl: WORKER });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, `${WORKER}/api/verify-logo-candidates`);
    assert.equal(out.length, 6);
    assert.deepEqual(out.slice(0, 2).map((p) => p.url), [URL_A, URL_B]);
    assert.equal(out[0].ok, true);
    assert.equal(out[1].ok, false);
  });

  test('URLs that are unfetchable by construction never reach the worker', async () => {
    const unsafe = ['http://127.0.0.1/l.png', 'http://localhost/l.png', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/l.png', 'https://user:pw@clinic.example/l.png', 'https://clinic.example:8443/l.png', 'file:///etc/passwd', 'ftp://clinic.example/l.png', 'http://metadata.google.internal/x.png', 'http://[::1]/l.png', 'javascript:alert(1)', 'http://intranet.local/l.png'];
    for (const u of unsafe) {
      const calls = [];
      const [probe] = await verifyImageUrls([u], { post: okPost(calls), workerUrl: WORKER });
      assert.equal(calls.length, 0, u);
      assert.deepEqual([probe.ok, probe.status], [false, 'blocked'], u);
    }
  });

  test('a safe URL next to unsafe ones is still sent, alone', async () => {
    const calls = [];
    const out = await verifyImageUrls(['http://127.0.0.1/l.png', URL_A, 'http://localhost/x.png'], { post: okPost(calls), workerUrl: WORKER });
    assert.deepEqual(calls[0].body.urls, [URL_A]);
    assert.deepEqual(out.map((p) => p.status), ['blocked', 'ok', 'blocked']);
  });

  test('every blocked URL is reported inconclusive (blocked is not "broken")', async () => {
    const out = await verifyImageUrls(['http://127.0.0.1/l.png', 'https://user:pw@clinic.example/l.png'], { post: okPost([]), workerUrl: WORKER });
    for (const p of out) assert.deepEqual([p.ok, p.status, p.conclusive], [false, 'blocked', false]);
  });

  test('a conclusive answer is cached; a repeat does not call the worker again', async () => {
    const calls = [];
    const deps = { post: okPost(calls), workerUrl: WORKER, now: () => 1_000 };
    await verifyImageUrls([URL_A], deps);
    const second = await verifyImageUrls([URL_A], deps);
    assert.equal(calls.length, 1);
    assert.equal(second[0].ok, true);
  });

  test('a cached answer expires', async () => {
    const calls = [];
    let now = 1_000;
    const deps = { post: okPost(calls), workerUrl: WORKER, now: () => now };
    await verifyImageUrls([URL_A], deps);
    now += 7 * 60 * 60 * 1000;
    await verifyImageUrls([URL_A], deps);
    assert.equal(calls.length, 2);
  });

  test('an inconclusive answer (timeout) is cached only briefly so a slow site recovers', async () => {
    let n = 0;
    let now = 1_000;
    const post = async (_e, body) => { n++; return { data: { success: true, data: { results: body.urls.map((u) => ({ url: u, ok: false, status: 'timeout', conclusive: false })) } } }; };
    const deps = { post, workerUrl: WORKER, now: () => now };
    await verifyImageUrls([URL_A], deps);
    await verifyImageUrls([URL_A], deps);
    assert.equal(n, 1);
    now += 6 * 60 * 1000;
    await verifyImageUrls([URL_A], deps);
    assert.equal(n, 2);
  });

  test('worker unreachable: every candidate is reported unverified (never broken, never ok), and nothing is cached', async () => {
    let n = 0;
    const post = async () => { n++; const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
    const out = await verifyImageUrls([URL_A, URL_B], { post, workerUrl: WORKER });
    for (const p of out) assert.deepEqual([p.ok, p.status, p.conclusive], [false, 'worker_unavailable', false]);
    await verifyImageUrls([URL_A], { post, workerUrl: WORKER });
    assert.equal(n, 2);
  });

  test('no PYTHON_WORKER_URL configured: unverified, no call attempted', async () => {
    let n = 0;
    const out = await verifyImageUrls([URL_A], { post: async () => { n++; }, workerUrl: '' });
    assert.equal(n, 0);
    assert.equal(out[0].status, 'worker_unavailable');
  });

  test('a worker reporting failure is treated as unavailable', async () => {
    const post = async () => ({ data: { success: false, error: 'verification_failed' } });
    assert.equal((await verifyImageUrls([URL_A], { post, workerUrl: WORKER }))[0].status, 'worker_unavailable');
  });

  test('results for URLs the Node side did not send are ignored', async () => {
    const post = async () => ({ data: { success: true, data: { results: [probeOk('http://169.254.169.254/x.png'), probeOk(URL_A)] } } });
    const out = await verifyImageUrls([URL_A, URL_B], { post, workerUrl: WORKER });
    assert.equal(out[0].ok, true);
    assert.equal(out[1].status, 'worker_unavailable');
  });

  test('the request carries only the URLs and a bounded timeout — no credentials or cookies', async () => {
    const calls = [];
    await verifyImageUrls([URL_A], { post: okPost(calls), workerUrl: WORKER });
    assert.deepEqual(Object.keys(calls[0].body), ['urls']);
    assert.ok(calls[0].options.timeout <= 40000);
    assert.deepEqual(Object.keys(calls[0].options.headers), ['Content-Type']);
  });

  test('empty / junk input is a no-op', async () => {
    const calls = [];
    assert.deepEqual(await verifyImageUrls([], { post: okPost(calls), workerUrl: WORKER }), []);
    assert.deepEqual(await verifyImageUrls([null, 5, '', '  '], { post: okPost(calls), workerUrl: WORKER }), []);
    assert.deepEqual(await verifyImageUrls(undefined, { post: okPost(calls), workerUrl: WORKER }), []);
    assert.equal(calls.length, 0);
  });
});
