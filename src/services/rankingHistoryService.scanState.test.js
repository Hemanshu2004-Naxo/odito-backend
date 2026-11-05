import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { saveCanonicalRanking, mergeSingleKeywordRescan, addKeyword, nextChannelScan } from './rankingHistoryService.js';

/**
 * Independent desktop / mobile / Maps scan state: statuses, last-good preservation, retry counts, ordering.
 * Real MongoDB (same convention as rankingHistoryService.mobile.test.js) — auto-skips when unreachable.
 *
 *   MONGO_URI=mongodb://localhost:27017/odito_ranking_it \
 *     node --test --test-concurrency=1 src/services/rankingHistoryService.scanState.test.js
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const urls = (rank) => (rank == null ? [] : [{ rank, url: `https://site.com/p${rank}`, type: 'internal_page' }]);
const mobileOk = (rank, extra = {}) => ({ ranking_urls: urls(rank), best_rank: rank, tracked_depth: 100, scan_error: null, attempts: 1, ...extra });
const mobileFail = (extra = {}) => ({ ranking_urls: [], best_rank: null, tracked_depth: null, scan_error: 'Internal SE Server Error (code 40101)', attempts: 3, ...extra });
const mapsOf = (status, extra = {}) => ({ status, error: null, attempts: 1, match_level: 'branch', match_confidence: 90, scanned_at: new Date(), ...extra });
const result = (keyword, desktopRank, extra = {}) => ({ keyword, ranking_urls: urls(desktopRank), maps_rank: null, scan_error: null, attempts: 1, ...extra });
const at = (ms) => new Date(Date.now() + ms);

const getKw = async (projectId, keyword) => {
  const doc = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();
  return doc.keywords.find(k => k.keyword === keyword);
};

describe('nextChannelScan (pure)', () => {
  const t0 = new Date('2026-11-01T00:00:00Z'), t1 = new Date('2026-11-02T00:00:00Z');

  test('success records the previous successful rank, completion time and retries used', () => {
    const s = nextChannelScan({ existingScan: { current_rank: 7, previous_successful_rank: 9, last_successful_scan_at: t0 }, existingRank: 7, status: 'success', attempts: 3, observedRank: 4, at: t1 });
    assert.deepEqual(s, { status: 'success', last_attempt_at: t1, last_successful_scan_at: t1, error: null, retry_count: 2, current_rank: 4, previous_successful_rank: 7 });
  });

  test('scan_error changes nothing about the last good rank or the last-success time', () => {
    const s = nextChannelScan({ existingScan: { current_rank: 7, previous_successful_rank: 9, last_successful_scan_at: t0 }, existingRank: 7, status: 'scan_error', error: 'Internal SE Server Error', attempts: 3, observedRank: 99, at: t1 });
    assert.equal(s.status, 'scan_error');
    assert.equal(s.current_rank, 7);
    assert.equal(s.previous_successful_rank, 9);
    assert.equal(s.last_successful_scan_at, t0);
    assert.equal(s.last_attempt_at, t1);
    assert.equal(s.retry_count, 2);
    assert.ok(s.error && !/Internal SE|DataForSEO/i.test(s.error), 'stored error is customer-safe');
  });

  test('a legacy keyword (no scan state) is seeded from its stored rank; a first failure fabricates no success time', () => {
    const s = nextChannelScan({ existingScan: undefined, existingRank: 12, status: 'scan_error', error: 'x', attempts: 1, at: t1 });
    assert.equal(s.current_rank, 12);
    assert.equal(s.last_successful_scan_at, null);
  });

  test('not_found is a completed check: rank cleared, previous keeps the last rank', () => {
    const s = nextChannelScan({ existingScan: { current_rank: 5 }, existingRank: 5, status: 'not_found', attempts: 1, at: t1 });
    assert.equal(s.current_rank, null);
    assert.equal(s.previous_successful_rank, 5);
    assert.equal(s.last_successful_scan_at, t1);
  });
});

describe('per-channel scan state persistence', () => {
  let projectId, userId;
  const base = () => ({ projectId, userId, domain: 'site.com', location: null, locationCode: 2840, country: 'US', language: 'en', seoScope: 'local' });
  const seed = (kwResult) => saveCanonicalRanking({ ...base(), keywords: [kwResult], scanSource: 'onboarding' });
  const rescan = (kwResult) => mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: kwResult, scanSource: 'manual_rescan' });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('all three channels succeed: each gets its own success state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(result('alpha', 8, { maps_rank: 3, maps_listing: { title: 'Biz', rating: 4.5, reviews: 10, address: 'x' }, maps: mapsOf('success'), mobile: mobileOk(11) }));
    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.desktop_scan.status, 'success');
    assert.equal(kw.desktop_scan.current_rank, 8);
    assert.equal(kw.mobile.scan.status, 'success');
    assert.equal(kw.mobile.scan.current_rank, 11);
    assert.equal(kw.maps_scan.status, 'success');
    assert.equal(kw.maps_scan.current_rank, 3);
    assert.equal(kw.maps_scan.match_level, 'branch');
    assert.equal(kw.maps_rank, 3);
  });

  test('all three fail on an existing keyword: every last good rank survives, every channel reports scan_error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const firstAt = at(-60_000);
    await seed(result('alpha', 8, { scanned_at: firstAt, maps_rank: 3, maps_listing: { title: 'Biz', rating: 4.5, reviews: 10, address: 'x' }, maps: mapsOf('success', { scanned_at: firstAt }), mobile: mobileOk(11, { scanned_at: firstAt }) }));

    await rescan(result('alpha', null, {
      scan_error: 'Internal SE Server Error (code 40101)', attempts: 3, scanned_at: at(0),
      maps_rank: null, maps_listing: null, maps: mapsOf('scan_error', { error: 'DataForSEO task error: Internal SE Server Error (code 40101)', attempts: 3, scanned_at: at(0) }),
      mobile: mobileFail({ scanned_at: at(0) }),
    }));

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.maps_rank, 3);
    assert.equal(kw.maps_listing.title, 'Biz');
    assert.equal(kw.mobile.current_rank, 11);
    for (const s of [kw.desktop_scan, kw.mobile.scan, kw.maps_scan]) {
      assert.equal(s.status, 'scan_error');
      assert.equal(s.retry_count, 2);
      assert.ok(s.last_successful_scan_at, 'last successful scan time is kept');
      assert.ok(s.error);
    }
    assert.equal(kw.desktop_scan.current_rank, 8);
    assert.equal(kw.mobile.scan.current_rank, 11);
    assert.equal(kw.maps_scan.current_rank, 3);
    assert.equal(kw.last_scan_status, 'error'); // legacy field still driven
  });

  test('desktop fails while mobile and Maps succeed: partial success persists, desktop keeps its last rank', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const firstAt = at(-60_000);
    await seed(result('alpha', 8, { scanned_at: firstAt, maps_rank: 3, maps: mapsOf('success', { scanned_at: firstAt }), mobile: mobileOk(11, { scanned_at: firstAt }) }));

    await rescan(result('alpha', null, { scan_error: 'timeout', attempts: 3, scanned_at: at(0), maps_rank: 2, maps: mapsOf('success', { scanned_at: at(0) }), mobile: mobileOk(6, { scanned_at: at(0) }) }));

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.desktop_scan.status, 'scan_error');
    assert.equal(kw.mobile.current_rank, 6);
    assert.equal(kw.mobile.scan.status, 'success');
    assert.equal(kw.mobile.scan.previous_successful_rank, 11);
    assert.equal(kw.maps_rank, 2);
    assert.equal(kw.maps_scan.previous_successful_rank, 3);
  });

  test('mobile fails while desktop succeeds', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const firstAt = at(-60_000);
    await seed(result('alpha', 8, { scanned_at: firstAt, mobile: mobileOk(11, { scanned_at: firstAt }) }));
    await rescan(result('alpha', 5, { scanned_at: at(0), mobile: mobileFail({ scanned_at: at(0) }) }));

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 5);
    assert.equal(kw.desktop_scan.status, 'success');
    assert.equal(kw.desktop_scan.previous_successful_rank, 8);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.scan.status, 'scan_error');
  });

  test('Maps not_found (request worked, business absent) clears the rank; Maps scan_error never does', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const firstAt = at(-120_000);
    await seed(result('alpha', 8, { scanned_at: firstAt, maps_rank: 3, maps_listing: { title: 'Biz', rating: 4, reviews: 1, address: 'x' }, maps: mapsOf('success', { scanned_at: firstAt }) }));

    await rescan(result('alpha', 8, { scanned_at: at(-60_000), maps: mapsOf('scan_error', { error: 'x', scanned_at: at(-60_000) }) }));
    let kw = await getKw(projectId, 'alpha');
    assert.equal(kw.maps_rank, 3);
    assert.equal(kw.maps_scan.status, 'scan_error');

    await rescan(result('alpha', 8, { scanned_at: at(-30_000), maps: mapsOf('not_found', { match_level: null, match_confidence: null, scanned_at: at(-30_000) }) }));
    kw = await getKw(projectId, 'alpha');
    assert.equal(kw.maps_rank, null);
    assert.equal(kw.maps_scan.status, 'not_found');
    assert.equal(kw.maps_scan.previous_successful_rank, 3);
  });

  test('an older Maps result cannot overwrite a newer one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(result('alpha', 8, { scanned_at: at(-120_000), maps_rank: 9, maps: mapsOf('success', { scanned_at: at(-120_000) }) }));
    await rescan(result('alpha', 8, { scanned_at: at(-10_000), maps_rank: 2, maps: mapsOf('success', { scanned_at: at(-10_000) }) }));
    // A slower, older request finishes last:
    await rescan(result('alpha', 8, { scanned_at: at(-90_000), maps_rank: 15, maps: mapsOf('success', { scanned_at: at(-90_000) }) }));

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.maps_rank, 2);
    assert.equal(kw.maps_scan.current_rank, 2);
  });

  test('legacy keyword (no scan state, no maps outcome) keeps the legacy maps behaviour and gains desktop state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(result('alpha', 8, { maps_rank: 4 }));
    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.maps_rank, 4);
    assert.equal(kw.maps_scan, undefined);
    assert.equal(kw.desktop_scan.status, 'success');
  });

  test('addKeyword with every channel failing stores a scan_error keyword with no fabricated ranks or success times', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SeoRankingCurrent.create({ project_id: projectId, user_id: userId, domain: 'site.com', keywords: [] });
    await addKeyword({
      projectId, userId, domain: 'site.com', planId: 'premium', scanSource: 'manual_add',
      keywordResult: result('new kw', null, { scan_error: 'Internal SE Server Error', attempts: 3, maps: mapsOf('scan_error', { error: 'x', attempts: 3 }), mobile: mobileFail() }),
    });
    const kw = await getKw(projectId, 'new kw');
    assert.equal(kw.current_rank, null);
    assert.equal(kw.maps_rank, null);
    assert.equal(kw.desktop_scan.status, 'scan_error');
    assert.equal(kw.desktop_scan.last_successful_scan_at, null);
    assert.equal(kw.mobile.scan.status, 'scan_error');
    assert.equal(kw.maps_scan.status, 'scan_error');
    assert.equal(kw.maps_scan.last_successful_scan_at, null);
  });
});
