import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { saveCanonicalRanking, mergeSingleKeywordRescan, nextChannelScan } from './rankingHistoryService.js';
import { buildDeviceResult } from '../modules/ranking/services/deviceSerpScan.js';
import { serpResponse, organicItems } from '../modules/ranking/services/fixtures/organicSerpFixtures.js';

/**
 * Persistence of DataForSEO partial (40106) organic results: partial_success status, requested depth vs returned
 * results, and last-good-rank preservation when a partial response has no usable data.
 * Real MongoDB, auto-skips when unreachable:
 *   MONGO_URI=mongodb://localhost:27017/odito_ranking_it \
 *     node --test --test-concurrency=1 src/services/rankingHistoryService.partialResults.test.js
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const SITE = 'site.com';
const at = (ms) => new Date(Date.now() + ms);
const meta = (outcome, code, returned) => ({ outcome, provider_code: code, requested_depth: 100, returned_results: returned });

/** A device result exactly as buildDeviceResult produces it from a fixture response. */
function device(name, resp, serpMeta, scannedAt) {
  return buildDeviceResult({ device: name, serpData: resp.data, serpError: null, attempts: 1, serpMeta, scanned_at: scannedAt }, SITE);
}
function failedDevice(name, error, scannedAt, attempts = 3) {
  return buildDeviceResult({ device: name, serpData: null, serpError: error, attempts, serpMeta: null, scanned_at: scannedAt }, SITE);
}
/** Keyword result in the processKeyword shape (desktop fields at top level, mobile nested). */
function keywordResult(keyword, d, m) {
  return {
    keyword, ranking_urls: d.ranking_urls, maps_rank: null, maps_listing: null, scan_error: d.scan_error,
    attempts: d.attempts, scanned_at: d.scanned_at, ...(d.serp ? { serp: d.serp } : {}), mobile: m,
  };
}

describe('nextChannelScan with provider outcome (pure)', () => {
  const t0 = new Date('2026-11-03T00:00:00Z');
  test('partial_success records the rank and the requested/returned counts', () => {
    const s = nextChannelScan({ existingScan: undefined, existingRank: null, status: 'partial_success', attempts: 3, observedRank: 9, at: t0, serp: meta('partial', 40106, 60) });
    assert.equal(s.status, 'partial_success');
    assert.equal(s.current_rank, 9);
    assert.equal(s.last_successful_scan_at, t0);
    assert.deepEqual([s.serp_outcome, s.provider_code, s.requested_depth, s.returned_results], ['partial', 40106, 100, 60]);
  });
  test('without serp the shape is unchanged (Maps, legacy callers)', () => {
    const s = nextChannelScan({ existingScan: undefined, existingRank: null, status: 'success', attempts: 1, observedRank: 2, at: t0 });
    assert.equal('serp_outcome' in s, false);
  });
});

describe('rankingHistoryService — partial results persistence', () => {
  let projectId, userId;
  const base = () => ({ projectId, userId, domain: SITE, location: 'Mumbai', locationCode: 1007785, country: 'IN', language: 'en', seoScope: 'national' });
  const seed = (kw) => saveCanonicalRanking({ ...base(), keywords: [kw], scanSource: 'onboarding' });
  const rescan = (kw) => mergeSingleKeywordRescan({ projectId, userId, domain: SITE, keywordResult: kw, scanSource: 'manual_rescan' });
  const getKw = async (keyword) => (await SeoRankingCurrent.findOne({ project_id: projectId }).lean()).keywords.find(k => k.keyword === keyword);

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('9. desktop partial success + mobile failure: desktop rank written as partial_success, mobile keeps its last rank', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const t0 = at(-60_000), t1 = at(5_000);
    await seed(keywordResult('kw',
      device('desktop', serpResponse({ items: organicItems(100, { 20: SITE }) }), meta('complete', 20000, 100), t0),
      device('mobile', serpResponse({ items: organicItems(100, { 11: SITE }), device: 'mobile' }), meta('complete', 20000, 100), t0)));

    await rescan(keywordResult('kw',
      device('desktop', serpResponse({ code: 40106, items: organicItems(80, { 6: SITE }) }), meta('partial', 40106, 80), t1),
      failedDevice('mobile', 'DataForSEO task error: Internal SE Server Error. (code 40101)', t1)));

    const kw = await getKw('kw');
    assert.equal(kw.current_rank, 6);
    assert.equal(kw.prev_scan_rank, 20);
    assert.equal(kw.last_scan_status, 'ok');
    assert.equal(kw.desktop_scan.status, 'partial_success');
    assert.equal(kw.desktop_scan.requested_depth, 100);
    assert.equal(kw.desktop_scan.returned_results, 80);
    assert.equal(kw.desktop_scan.provider_code, 40106);
    assert.equal(kw.mobile.current_rank, 11, 'mobile failure does not touch the mobile rank');
    assert.equal(kw.mobile.scan.status, 'scan_error');
    assert.equal(kw.mobile.scan.current_rank, 11);
  });

  test('10. mobile success + desktop failure: desktop keeps its last rank, mobile updates', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const t0 = at(-60_000), t1 = at(5_000);
    await seed(keywordResult('kw',
      device('desktop', serpResponse({ items: organicItems(100, { 8: SITE }) }), meta('complete', 20000, 100), t0),
      device('mobile', serpResponse({ items: organicItems(100, { 11: SITE }), device: 'mobile' }), meta('complete', 20000, 100), t0)));

    await rescan(keywordResult('kw',
      failedDevice('desktop', 'DataForSEO task error: Internal SE Server Error. (code 40101)', t1),
      device('mobile', serpResponse({ items: organicItems(100, { 4: SITE }), device: 'mobile' }), meta('complete', 20000, 100), t1)));

    const kw = await getKw('kw');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.desktop_scan.status, 'scan_error');
    assert.equal(kw.mobile.current_rank, 4);
    assert.equal(kw.mobile.scan.status, 'success');
    assert.equal(kw.mobile.scan.serp_outcome, 'complete');
  });

  test('11. no usable data (40106 without results, and 40106 without the site): the previous rank is preserved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(keywordResult('kw',
      device('desktop', serpResponse({ items: organicItems(100, { 8: SITE }) }), meta('complete', 20000, 100), at(-120_000)),
      device('mobile', serpResponse({ items: organicItems(100, { 11: SITE }), device: 'mobile' }), meta('complete', 20000, 100), at(-120_000))));

    // 40106 that returned 20 results without the site (the site may be on a page that was not returned).
    await rescan(keywordResult('kw',
      device('desktop', serpResponse({ code: 40106, items: organicItems(20) }), meta('partial', 40106, 20), at(5_000)),
      buildDeviceResult({ device: 'mobile', serpData: null, attempts: 1, scanned_at: at(5_000),
        serpError: 'DataForSEO task error: partial results with no organic items returned (code 40106)',
        serpMeta: meta('partial_without_results', 40106, 0) }, SITE)));

    const kw = await getKw('kw');
    assert.equal(kw.current_rank, 8, 'desktop rank not replaced by an unknown');
    assert.equal(kw.best_rank, 8);
    assert.equal(kw.last_scan_status, 'error');
    assert.match(kw.last_scan_error, /incomplete results/);
    assert.equal(kw.desktop_scan.status, 'scan_error');
    assert.equal(kw.desktop_scan.current_rank, 8);
    assert.equal(kw.desktop_scan.returned_results, 20);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.scan.status, 'scan_error');
    assert.equal(kw.mobile.scan.serp_outcome, 'partial_without_results');
  });

  test('40102 no search results is a completed "not found" check', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(keywordResult('kw',
      device('desktop', serpResponse({ code: 40102, items: null }), meta('no_results', 40102, 0), at(0)),
      device('mobile', serpResponse({ code: 40102, items: null, device: 'mobile' }), meta('no_results', 40102, 0), at(0))));
    const kw = await getKw('kw');
    assert.equal(kw.current_rank, null);
    assert.equal(kw.desktop_scan.status, 'not_found');
    assert.equal(kw.desktop_scan.serp_outcome, 'no_results');
    assert.equal(kw.mobile.scan.status, 'not_found');
  });
});
