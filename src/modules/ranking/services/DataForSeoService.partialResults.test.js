import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DataForSeoService, buildSerpOrganicPayload } from './DataForSeoService.js';
import { scanKeywordDevices, buildDeviceResult } from './deviceSerpScan.js';
import { classifyDataForSeoError } from './dataForSeoRetry.js';
import { resolveSerpDepth } from './serpDevices.js';
import { summarizeOrganicResponse, assessOrganicOutcome } from './serpResponseOutcome.js';
import {
  serpResponse, organicItems, organicItem, localPack, mapsSearch, peopleAlsoAsk, aiOverview,
} from './fixtures/organicSerpFixtures.js';

/**
 * DataForSEO organic task outcomes end to end through the real client (axios mocked: no network, no paid calls):
 * 20000 / 40106 partial / 40102 no results / 40101 retry, organic extraction from mixed SERPs, per-device independence.
 * Run from odito_backend/:  node --test src/modules/ranking/services/DataForSeoService.partialResults.test.js
 */

const SITE = 'krishnaeyecentre.com';

afterEach(() => { mock.restoreAll(); delete process.env.DATAFORSEO_SERP_DEPTH; });

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

/** Scan desktop + mobile with axios answering per device from a script: { desktop: [resp...], mobile: [resp...] }. */
async function scanBoth(script) {
  const calls = { desktop: 0, mobile: 0 };
  mock.method(axios, 'post', async (_url, payload) => {
    const device = payload[0].device;
    const list = script[device];
    const resp = list[Math.min(calls[device]++, list.length - 1)];
    return typeof resp === 'function' ? resp() : resp;
  });
  const scans = await settle(scanKeywordDevices({ keyword: 'an asg eye center near me', locationCode: 1007785, languageCode: 'en', mobileEnabled: true }));
  return { calls, desktop: buildDeviceResult(scans.desktop, SITE), mobile: buildDeviceResult(scans.mobile, SITE) };
}

describe('organic task outcomes', () => {
  test('1. 20000 with full results: ranked, outcome complete, depth and returned count recorded', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ items: organicItems(100, { 7: SITE }) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 1);
    assert.equal(desktop.scan_error, null);
    assert.equal(desktop.best_rank, 7);
    assert.deepEqual(desktop.serp, { outcome: 'complete', provider_code: 20000, requested_depth: 100, returned_results: 100 });
    assert.equal(desktop.tracked_depth, 100);
  });

  test('2. 40106 with 80 returned results and the site at 34: rank kept, outcome partial, never resubmitted', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: organicItems(80, { 34: SITE }) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 1, 'a completed 40106 task is not resubmitted');
    assert.equal(desktop.scan_error, null);
    assert.equal(desktop.best_rank, 34);
    assert.deepEqual(desktop.serp, { outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: 80 });
    assert.equal(desktop.tracked_depth, 80, 'tracked depth is what came back, not what was asked for');
  });

  test('3. 40106 with 20 returned results and the site absent: scan_error (rank unknown), not "not ranked"', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: organicItems(20) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 1);
    assert.match(desktop.scan_error, /partial results \(code 40106\)/);
    assert.equal(desktop.best_rank, null);
    assert.deepEqual(desktop.ranking_urls, []);
    assert.equal(desktop.serp.returned_results, 20);
  });

  test('3b. 40106 with 20 returned results and the site at 3: rank recorded from the partial page', async () => {
    const { desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: organicItems(20, { 3: SITE }) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(desktop.scan_error, null);
    assert.equal(desktop.best_rank, 3);
    assert.equal(desktop.serp.outcome, 'partial');
  });

  test('4. 40106 with an empty result array: scan_error, outcome partial_without_results, one request only', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: [] })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 1);
    assert.match(desktop.scan_error, /no organic items/);
    assert.equal(desktop.attempts, 1);
    assert.deepEqual(desktop.serp, { outcome: 'partial_without_results', provider_code: 40106, requested_depth: 100, returned_results: 0 });
  });

  test('4b. 40106 with result: null is the same failed scan', async () => {
    const { desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: null })],
      mobile:  [serpResponse({ items: organicItems(10), device: 'mobile' })],
    });
    assert.match(desktop.scan_error, /no organic items/);
  });

  test('5. 40101 then 20000: retried once, the second task is used', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40101, items: null }), serpResponse({ items: organicItems(100, { 12: SITE }) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 2);
    assert.equal(desktop.attempts, 2);
    assert.equal(desktop.best_rank, 12);
  });

  test('5b. 40101, 40101, then 40106 with data (the production sequence): the partial data is used', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40101, items: null }), serpResponse({ code: 40101, items: null }),
                serpResponse({ code: 40106, items: organicItems(60, { 9: SITE }) })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 3);
    assert.equal(desktop.scan_error, null);
    assert.equal(desktop.best_rank, 9);
    assert.equal(desktop.attempts, 3);
  });

  test('6. three consecutive 40101: retries exhausted, scan_error, no fourth request', async () => {
    const { calls, mobile } = await scanBoth({
      desktop: [serpResponse({ items: organicItems(100) })],
      mobile:  [serpResponse({ code: 40101, items: null, device: 'mobile' })],
    });
    assert.equal(calls.mobile, 3);
    assert.match(mobile.scan_error, /Internal SE Server Error/);
    assert.equal(mobile.attempts, 3);
    assert.equal(mobile.serp, undefined, 'no provider outcome is invented for a failed request');
  });

  test('7. 40102 no search results: a completed check, not found, never retried', async () => {
    const { calls, desktop } = await scanBoth({
      desktop: [serpResponse({ code: 40102, items: null })],
      mobile:  [serpResponse({ items: organicItems(100), device: 'mobile' })],
    });
    assert.equal(calls.desktop, 1);
    assert.equal(desktop.scan_error, null);
    assert.equal(desktop.best_rank, null);
    assert.equal(desktop.tracked_depth, null, 'no range can be claimed when nothing came back');
    assert.equal(desktop.serp.outcome, 'no_results');
  });
});

describe('organic extraction', () => {
  test('8. mixed SERP item types: only organic items rank; maps_search / local pack / PAA / AI overview are excluded', async () => {
    const items = [
      aiOverview(1), localPack(2, SITE), mapsSearch(3, SITE), peopleAlsoAsk(4),
      organicItem(1, 'a.example'), organicItem(2, 'b.example'), organicItem(3, `www.${SITE}`, '/cataract'),
      organicItem(4, 'c.example'),
    ];
    const { desktop } = await scanBoth({ desktop: [serpResponse({ items })], mobile: [serpResponse({ items: organicItems(5), device: 'mobile' })] });
    assert.equal(desktop.best_rank, 3, 'rank_group (organic position), not rank_absolute');
    assert.deepEqual(desktop.ranking_urls.map(u => u.url), [`https://www.${SITE}/cataract`]);
    assert.equal(desktop.maps_rank, 1, 'local pack rank (position inside the pack) is still extracted separately');
    assert.equal(desktop.serp.returned_results, 4);
  });

  test('missing URLs and duplicate URLs: a URL-less item is not stored, a duplicate URL keeps its best rank', async () => {
    const dup = organicItem(5, SITE, '/x');
    const items = [organicItem(1, 'a.example'), { ...organicItem(2, SITE), url: undefined }, dup, { ...dup, rank_group: 9 }, organicItem(7, SITE, '/y')];
    const { desktop } = await scanBoth({ desktop: [serpResponse({ items })], mobile: [serpResponse({ items: [], device: 'mobile' })] });
    const urls = desktop.ranking_urls.filter(u => u.url);
    assert.deepEqual(urls.map(u => [u.rank, u.url]), [[5, `https://${SITE}/x`], [7, `https://${SITE}/y`]]);
  });

  test('12. ranking from partial results across several result pages (nested result[] structure)', () => {
    const resp = serpResponse({ code: 40106, items: organicItems(10) }).data;
    resp.tasks[0].result.push({ ...resp.tasks[0].result[0], items: organicItems(30).slice(20, 30).map((i) => (i.rank_group === 26 ? organicItem(26, SITE) : i)) });
    const summary = summarizeOrganicResponse(resp, { httpStatus: 200, requestedDepth: 100 });
    assert.equal(assessOrganicOutcome(summary), 'partial');
    assert.equal(summary.resultLength, 2);
    assert.equal(summary.organicCount, 20);
    assert.equal(summary.deepestOrganicRank, 30);
    const scan = { device: 'desktop', serpData: resp, serpError: null, attempts: 1, scanned_at: new Date(),
      serpMeta: { outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: 20 } };
    const out = buildDeviceResult(scan, SITE);
    assert.equal(out.best_rank, 26, 'the observed position, nothing interpolated for the missing page');
  });
});

describe('device independence', () => {
  test('9. desktop partial success + mobile failure: each device keeps its own outcome', async () => {
    const { desktop, mobile } = await scanBoth({
      desktop: [serpResponse({ code: 40106, items: organicItems(50, { 4: SITE }) })],
      mobile:  [serpResponse({ code: 40101, items: null, device: 'mobile' })],
    });
    assert.equal(desktop.best_rank, 4);
    assert.equal(desktop.serp.outcome, 'partial');
    assert.ok(mobile.scan_error);
    assert.equal(mobile.best_rank, null);
  });

  test('10. mobile success + desktop failure', async () => {
    const { desktop, mobile } = await scanBoth({
      desktop: [serpResponse({ code: 40101, items: null })],
      mobile:  [serpResponse({ items: organicItems(100, { 15: SITE }), device: 'mobile' })],
    });
    assert.ok(desktop.scan_error);
    assert.equal(mobile.scan_error, null);
    assert.equal(mobile.best_rank, 15);
    assert.equal(mobile.serp.outcome, 'complete');
  });
});

describe('classification and configuration', () => {
  const taskErr = (code, msg) => ({ isApiError: true, isTaskError: true, taskStatusCode: code, taskStatusMessage: msg, message: msg });

  test('task codes: 40101 / 40103 retry, 40102 / 40106 never retry, auth and invalid-field never retry', () => {
    assert.deepEqual([classifyDataForSeoError(taskErr(40101, 'Internal SE Server Error.')).retryable], [true]);
    const c40103 = classifyDataForSeoError(taskErr(40103, 'Task execution failed, please try to resubmit the task.'));
    assert.deepEqual([c40103.retryable, c40103.kind], [true, 'provider_transient']);
    const c40102 = classifyDataForSeoError(taskErr(40102, 'No Search Results.'));
    assert.deepEqual([c40102.retryable, c40102.kind], [false, 'no_results']);
    const c40106 = classifyDataForSeoError(taskErr(40106, 'Task completed with partial results. Some pages could not be retrieved after several retry attempts.'));
    assert.deepEqual([c40106.retryable, c40106.kind], [false, 'partial_results']);
    assert.equal(classifyDataForSeoError(taskErr(40501, 'Invalid Field: depth')).retryable, false);
    assert.equal(classifyDataForSeoError({ response: { status: 401 } }).kind, 'auth');
    assert.equal(classifyDataForSeoError({ isApiError: true, apiStatusCode: 40200, apiStatusMessage: 'Payment Required.', message: 'x' }).retryable, false);
  });

  test('other DataForSEO callers still treat 40106 as an error (opt-in only for organic rankings)', async () => {
    mock.method(axios, 'post', async () => serpResponse({ code: 40106, items: organicItems(5) }));
    await assert.rejects(() => DataForSeoService.postGoogleOrganicLiveAdvanced({ keyword: 'q' }), (e) => e.taskStatusCode === 40106);
  });

  test('depth is configurable (10..100) and defaults to 100', () => {
    assert.equal(resolveSerpDepth({}), 100);
    assert.equal(resolveSerpDepth({ DATAFORSEO_SERP_DEPTH: '50' }), 50);
    assert.equal(resolveSerpDepth({ DATAFORSEO_SERP_DEPTH: '500' }), 100);
    assert.equal(resolveSerpDepth({ DATAFORSEO_SERP_DEPTH: 'abc' }), 100);
    process.env.DATAFORSEO_SERP_DEPTH = '20';
    assert.equal(buildSerpOrganicPayload('kw', 1, 'en', 'mobile')[0].depth, 20);
  });
});
