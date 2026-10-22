import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DataForSeoService, buildSerpOrganicPayload } from './DataForSeoService.js';
import { SERP_DEVICES, isMobileRankingEnabled, createLimiter } from './serpDevices.js';

/**
 * Device handling for the organic SERP request. axios is mocked: no network
 * and no paid DataForSEO calls.
 *
 * Run from backend/:  node --test src/modules/ranking/services/DataForSeoService.test.js
 */

const okResponse = (items = []) => ({
  data: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items }] }] },
});

afterEach(() => mock.restoreAll());

describe('buildSerpOrganicPayload', () => {
  test('defaults to the original desktop configuration', () => {
    const [p] = buildSerpOrganicPayload('seo tools', 2840, 'en');
    assert.deepEqual(p, {
      keyword: 'seo tools', location_code: 2840, language_code: 'en',
      depth: 100, device: 'desktop', os: 'windows',
    });
  });

  test('mobile sends device=mobile with a mobile os and the same keyword/location/language/depth', () => {
    const [d] = buildSerpOrganicPayload('seo tools', 2840, 'en', 'desktop');
    const [m] = buildSerpOrganicPayload('seo tools', 2840, 'en', 'mobile');
    assert.equal(m.device, 'mobile');
    assert.equal(m.os, 'android');
    for (const k of ['keyword', 'location_code', 'language_code', 'depth']) assert.equal(m[k], d[k]);
  });

  test('rejects unsupported devices', () => {
    for (const bad of ['tablet', 'Mobile', '', null, 5, {}]) {
      assert.throws(() => buildSerpOrganicPayload('k', 1, 'en', bad), { code: 'UNSUPPORTED_SERP_DEVICE' });
    }
  });

  test('device table only contains provider-documented device/os pairs', () => {
    assert.deepEqual(SERP_DEVICES.desktop, { device: 'desktop', os: 'windows' });
    assert.deepEqual(SERP_DEVICES.mobile, { device: 'mobile', os: 'android' });
  });
});

describe('DataForSeoService.getSerpOrganic', () => {
  test('a caller that passes no device still sends the desktop request', async () => {
    const post = mock.method(axios, 'post', async () => okResponse());
    await DataForSeoService.getSerpOrganic('kw', 2840, 'en');
    const [url, body] = post.mock.calls[0].arguments;
    assert.match(url, /serp\/google\/organic\/live\/advanced$/);
    assert.equal(body[0].device, 'desktop');
    assert.equal(body[0].os, 'windows');
  });

  test('device: mobile sends the mobile configuration', async () => {
    const post = mock.method(axios, 'post', async () => okResponse());
    await DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' });
    const body = post.mock.calls[0].arguments[1];
    assert.equal(body[0].device, 'mobile');
    assert.equal(body[0].os, 'android');
    assert.equal(body[0].depth, 100);
  });

  test('an unsupported device is rejected before any request is sent', async () => {
    const post = mock.method(axios, 'post', async () => okResponse());
    await assert.rejects(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'tablet' }), { code: 'UNSUPPORTED_SERP_DEVICE' });
    assert.equal(post.mock.callCount(), 0);
  });

  test('a task-level provider failure is propagated, not turned into an empty result', async () => {
    mock.method(axios, 'post', async () => ({
      data: { status_code: 20000, tasks: [{ status_code: 40201, status_message: 'paused', result: null }] },
    }));
    await assert.rejects(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' }), /task error/);
  });

  test('an HTTP 4xx failure is propagated', async () => {
    mock.method(axios, 'post', async () => { throw Object.assign(new Error('bad request'), { response: { status: 400 } }); });
    await assert.rejects(DataForSeoService.getSerpOrganic('kw', 2840, 'en'), /bad request/);
  });

  test('does not put credentials in the request body', async () => {
    const post = mock.method(axios, 'post', async () => okResponse());
    await DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' });
    assert.ok(!JSON.stringify(post.mock.calls[0].arguments[1]).toLowerCase().includes('password'));
  });
});

describe('rollout flag and limiter', () => {
  test('mobile tracking is on by default and "false" turns it off', () => {
    assert.equal(isMobileRankingEnabled({}), true);
    assert.equal(isMobileRankingEnabled({ KEYWORD_MOBILE_RANKING_ENABLED: 'true' }), true);
    assert.equal(isMobileRankingEnabled({ KEYWORD_MOBILE_RANKING_ENABLED: 'false' }), false);
  });

  test('every common "off" spelling disables mobile; the kill-switch must not fail open on them', () => {
    for (const v of ['false', 'FALSE', ' False ', '0', 'off', 'OFF', 'no', 'disabled']) {
      assert.equal(isMobileRankingEnabled({ KEYWORD_MOBILE_RANKING_ENABLED: v }), false, `"${v}" should disable`);
    }
  });

  test('unset, empty and "on" spellings keep it enabled (default on)', () => {
    for (const v of [undefined, '', 'true', '1', 'on', 'yes']) {
      assert.equal(isMobileRankingEnabled({ KEYWORD_MOBILE_RANKING_ENABLED: v }), true, `"${v}" should enable`);
    }
  });

  test('limiter never runs more than max tasks at once and runs them all', async () => {
    const limit = createLimiter(2);
    let active = 0, peak = 0;
    const task = () => limit(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return 1;
    });
    const results = await Promise.all(Array.from({ length: 8 }, task));
    assert.equal(results.length, 8);
    assert.equal(peak, 2);
  });
});

describe('retry behaviour — bounds the provider requests one scan can generate', () => {
  /** Drive the 8s retry sleeps with fake timers instead of waiting real time. */
  async function settle(promise) {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let done = false, out;
      promise.then((v) => { done = true; out = v; }, (e) => { done = true; out = e; });
      for (let i = 0; i < 20 && !done; i++) {
        await new Promise((r) => setImmediate(r));
        mock.timers.tick(8000);
      }
      await new Promise((r) => setImmediate(r));
      return out;
    } finally {
      mock.timers.reset();
    }
  }

  test('a persistent 5xx is tried at most 3 times per device request', async () => {
    const post = mock.method(axios, 'post', async () => { throw Object.assign(new Error('server error'), { response: { status: 503 } }); });
    const err = await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' }));
    assert.match(err.message, /failed after 3 attempts/);
    assert.equal(post.mock.callCount(), 3);
  });

  test('a timeout/network error (no HTTP response) is also tried at most 3 times', async () => {
    const post = mock.method(axios, 'post', async () => { throw Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' }); });
    await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en'));
    assert.equal(post.mock.callCount(), 3);
  });

  test('4xx, auth, credit and provider task errors are never retried', async () => {
    for (const make of [
      () => { throw Object.assign(new Error('bad'), { response: { status: 400 } }); },
      () => { throw Object.assign(new Error('unauth'), { response: { status: 401 } }); },
      () => { throw Object.assign(new Error('credits'), { response: { status: 402 } }); },
      () => ({ data: { status_code: 20000, tasks: [{ status_code: 40501, status_message: 'invalid field', result: null }] } }),
    ]) {
      const post = mock.method(axios, 'post', async () => make());
      await settle(DataForSeoService.getSerpOrganic('kw', 2840, 'en', { device: 'mobile' }));
      assert.equal(post.mock.callCount(), 1);
      mock.restoreAll();
    }
  });

  test('worst case for one keyword scan is 3 attempts x 2 devices = 6 organic requests; a failed mobile device never re-triggers desktop', async () => {
    const { scanKeywordDevices } = await import('./deviceSerpScan.js');
    const perDevice = { desktop: 0, mobile: 0 };
    mock.method(axios, 'post', async (_u, payload) => {
      perDevice[payload[0].device]++;
      if (payload[0].device === 'mobile') throw Object.assign(new Error('server error'), { response: { status: 503 } });
      return okResponse();
    });
    const res = await settle(scanKeywordDevices({ keyword: 'kw', locationCode: 2840, languageCode: 'en', mobileEnabled: true }));
    assert.equal(perDevice.desktop, 1);
    assert.equal(perDevice.mobile, 3);
    assert.equal(res.desktop.serpError, null);
    assert.match(res.mobile.serpError, /failed after 3 attempts/);
  });
});
