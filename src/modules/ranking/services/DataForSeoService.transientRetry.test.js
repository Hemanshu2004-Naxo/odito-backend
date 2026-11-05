import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DataForSeoService } from './DataForSeoService.js';
import { scanKeywordDevices, buildDeviceResult } from './deviceSerpScan.js';

/**
 * Transient provider failures (task-level 40101 "Internal SE Server Error") are retried with backoff; permanent ones and
 * successes are never repeated. axios is mocked: no network, no paid calls.
 * Run from backend/:  node --test src/modules/ranking/services/DataForSeoService.transientRetry.test.js
 */

const organic = (rank, domain) => ({ type: 'organic', rank_group: rank, rank_absolute: rank, domain, url: `https://${domain}/p${rank}` });
const ok = (...items) => ({ data: { status_code: 20000, tasks: [{ id: 't-ok', status_code: 20000, result: [{ items }] }] } });
const task40101 = () => ({ data: { status_code: 20000, tasks: [{ id: 't-bad', status_code: 40101, status_message: 'Internal SE Server Error.', result: null }] } });

afterEach(() => { mock.restoreAll(); delete process.env.DATAFORSEO_MAX_ATTEMPTS; });

/** Drive backoff sleeps with fake timers instead of waiting. */
async function settle(promise) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let done = false, out;
    promise.then((v) => { done = true; out = v; }, (e) => { done = true; out = e; });
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(10_000);
    }
    await new Promise((r) => setImmediate(r));
    return out;
  } finally {
    mock.timers.reset();
  }
}

describe('task-level 40101 handling', () => {
  test('a 40101 that clears on the next attempt succeeds, uses exactly 2 requests and reports its attempts', async () => {
    let n = 0;
    const post = mock.method(axios, 'post', async () => (++n === 1 ? task40101() : ok(organic(4, 'site.com'))));
    const data = await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'desktop' }));
    assert.equal(post.mock.callCount(), 2);
    assert.equal(data.dfsAttempts, 2);
    assert.equal(data.tasks[0].status_code, 20000);
  });

  test('retry exhaustion: persistent 40101 stops at the attempt limit and surfaces the provider error with attempts', async () => {
    const post = mock.method(axios, 'post', async () => task40101());
    const err = await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' }));
    assert.equal(post.mock.callCount(), 3);
    assert.match(err.message, /Internal SE Server Error/);
    assert.equal(err.taskStatusCode, 40101);
    assert.equal(err.attempts, 3);
    assert.equal(err.retryExhausted, true);
  });

  test('DATAFORSEO_MAX_ATTEMPTS lowers the attempt limit', async () => {
    process.env.DATAFORSEO_MAX_ATTEMPTS = '2';
    const post = mock.method(axios, 'post', async () => task40101());
    const err = await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en'));
    assert.equal(post.mock.callCount(), 2);
    assert.equal(err.attempts, 2);
  });

  test('a successful request is never repeated', async () => {
    const post = mock.method(axios, 'post', async () => ok(organic(1, 'site.com')));
    await DataForSeoService.getSerpOrganic('kw', 2840, 'en');
    assert.equal(post.mock.callCount(), 1);
  });

  test('a permanent task error (invalid field) and an HTML gateway page are classified correctly', async () => {
    const perm = mock.method(axios, 'post', async () => ({ data: { status_code: 20000, tasks: [{ status_code: 40501, status_message: 'Invalid Field: depth', result: null }] } }));
    await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en'));
    assert.equal(perm.mock.callCount(), 1);
    mock.restoreAll();

    let n = 0;
    const html = mock.method(axios, 'post', async () => (++n === 1 ? { data: '<html>502 Bad Gateway</html>' } : ok(organic(2, 'site.com'))));
    const data = await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en'));
    assert.equal(html.mock.callCount(), 2, 'a non-JSON body is a malformed (transient) response and is retried once');
    assert.equal(data.dfsAttempts, 2);
  });

  test('the Maps endpoint gets the same retry treatment', async () => {
    let n = 0;
    const post = mock.method(axios, 'post', async () => (++n === 1 ? task40101() : ok({ type: 'maps_search', title: 'x' })));
    const data = await settle(DataForSeoService.getMapsResults('kw', 2840, 'en'));
    assert.equal(post.mock.callCount(), 2);
    assert.equal(data.dfsAttempts, 2);
  });
});

describe('desktop / mobile independence under 40101', () => {
  const scan = () => scanKeywordDevices({ keyword: 'kw', locationCode: 2840, languageCode: 'en', mobileEnabled: true });

  test('desktop 40101 (persistent) while mobile succeeds: mobile result intact, desktop carries the error and attempts', async () => {
    const perDevice = { desktop: 0, mobile: 0 };
    mock.method(axios, 'post', async (_u, body) => {
      perDevice[body[0].device]++;
      return body[0].device === 'desktop' ? task40101() : ok(organic(9, 'site.com'));
    });
    const { desktop, mobile } = await settle(scan());
    assert.equal(perDevice.mobile, 1, 'the successful device is requested once and never re-requested');
    assert.equal(perDevice.desktop, 3);
    const d = buildDeviceResult(desktop, 'site.com'), m = buildDeviceResult(mobile, 'site.com');
    assert.match(d.scan_error, /Internal SE Server Error/);
    assert.equal(d.attempts, 3);
    assert.equal(m.scan_error, null);
    assert.equal(m.best_rank, 9);
    assert.equal(m.attempts, 1);
  });

  test('mobile 40101 (persistent) while desktop succeeds', async () => {
    mock.method(axios, 'post', async (_u, body) => (body[0].device === 'mobile' ? task40101() : ok(organic(3, 'site.com'))));
    const { desktop, mobile } = await settle(scan());
    assert.equal(buildDeviceResult(desktop, 'site.com').best_rank, 3);
    assert.match(buildDeviceResult(mobile, 'site.com').scan_error, /Internal SE Server Error/);
  });

  test('both devices failing is two independent errors, not a thrown exception', async () => {
    mock.method(axios, 'post', async () => task40101());
    const { desktop, mobile } = await settle(scan());
    assert.ok(desktop.serpError && mobile.serpError);
    assert.equal(desktop.serpData, null);
    assert.equal(mobile.serpData, null);
  });
});
