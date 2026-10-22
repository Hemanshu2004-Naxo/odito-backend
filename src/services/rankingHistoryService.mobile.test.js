import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import {
  appendHistory,
  saveCanonicalRanking,
  mergeSingleKeywordRescan,
  addKeyword,
  deriveHistoricalRanks,
  deriveMobileStatus,
  withDeviceStatuses,
} from './rankingHistoryService.js';

/**
 * Desktop + mobile ranking persistence and history.
 *
 * Real MongoDB (same convention as rankingHistoryService.test.js) — auto-skips
 * when unreachable. Run against an isolated database, never a shared one:
 *
 *   MONGO_URI=mongodb://localhost:27017/odito_ranking_it \
 *     node --test --test-concurrency=1 src/services/rankingHistoryService.mobile.test.js
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

const urls = (rank) => (rank == null ? [] : [{ rank, url: `https://site.com/p${rank}`, type: 'internal_page' }]);
const mobileOk = (rank, extra = {}) => ({ ranking_urls: urls(rank), best_rank: rank, tracked_depth: 100, scan_error: null, ...extra });
const mobileFail = (msg = 'timeout', extra = {}) => ({ ranking_urls: [], best_rank: null, tracked_depth: null, scan_error: msg, ...extra });
const result = (keyword, desktopRank, mobile, extra = {}) => ({
  keyword, ranking_urls: urls(desktopRank), maps_rank: null, scan_error: null, ...(mobile ? { mobile } : {}), ...extra,
});

const getKw = async (projectId, keyword) => {
  const doc = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();
  return doc.keywords.find(k => k.keyword === keyword);
};
const hist = (projectId, keyword, device) => KeywordRankingHistory.find({
  project_id: projectId, keyword_normalized: keyword.toLowerCase(),
  ...(device === 'mobile' ? { device: 'mobile' } : { device: { $ne: 'mobile' } }),
}).sort({ scanned_at: 1 }).lean();

describe('desktop + mobile ranking persistence', () => {
  let projectId, userId;
  const base = () => ({ projectId, userId, domain: 'site.com', location: null, locationCode: 2840, country: 'US', language: 'en', seoScope: 'national' });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('legacy desktop-only keywords stay valid and read as mobile "not_collected" (no defaulted mobile data)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8)], scanSource: 'onboarding' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.mobile, undefined);
    assert.equal(deriveMobileStatus(kw.mobile), 'not_collected');
    assert.deepEqual(withDeviceStatuses(kw).mobile, { status: 'not_collected' });
    assert.equal(withDeviceStatuses(kw).status, 'ranked');
  });

  test('first mobile scan stores independent desktop/mobile ranks and fabricates no previous values', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.prev_scan_rank, null);
    assert.equal(kw.mobile.prev_week_rank, null);
    assert.equal(kw.mobile.prev_month_rank, null);
    assert.equal(kw.mobile.benchmark_rank, 11);
    assert.equal(kw.mobile.tracked_depth, 100);
    assert.equal(kw.mobile.last_scan_status, 'ok');
    assert.equal(deriveMobileStatus(kw.mobile), 'ranked');
  });

  test('history rows are tagged by device; desktop and mobile histories are separate', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });

    const d = await hist(projectId, 'alpha', 'desktop');
    const m = await hist(projectId, 'alpha', 'mobile');
    assert.equal(d.length, 1);
    assert.equal(d[0].device, 'desktop');
    assert.equal(d[0].current_rank, 8);
    assert.equal(m.length, 1);
    assert.equal(m[0].device, 'mobile');
    assert.equal(m[0].current_rank, 11);
  });

  test('legacy history rows with no device are read as desktop and never leak into mobile comparisons', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await KeywordRankingHistory.collection.insertOne({
      project_id: projectId, user_id: userId, domain: 'site.com', keyword: 'alpha', keyword_normalized: 'alpha',
      scanned_at: longAgo, current_rank: 3, maps_rank: null, scan_source: 'onboarding', ranking_urls: [],
    });

    const desktop = await deriveHistoricalRanks(projectId, 'alpha', 'desktop');
    const mobile = await deriveHistoricalRanks(projectId, 'alpha', 'mobile');
    assert.equal(desktop.prev_week_rank, 3);
    assert.equal(desktop.prev_month_rank, 3);
    assert.equal(mobile.prev_week_rank, null);
    assert.equal(mobile.prev_month_rank, null);
  });

  test('mobile previous-week/month come from mobile history only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await KeywordRankingHistory.create([
      { project_id: projectId, user_id: userId, domain: 'site.com', keyword: 'alpha', keyword_normalized: 'alpha', device: 'mobile', scanned_at: old, current_rank: 15, ranking_urls: [] },
      { project_id: projectId, user_id: userId, domain: 'site.com', keyword: 'alpha', keyword_normalized: 'alpha', device: 'desktop', scanned_at: old, current_rank: 4, ranking_urls: [] },
    ]);
    const m = await deriveHistoricalRanks(projectId, 'alpha', 'mobile');
    const d = await deriveHistoricalRanks(projectId, 'alpha', 'desktop');
    assert.equal(m.prev_week_rank, 15);
    assert.equal(d.prev_week_rank, 4);
  });

  test('rescan: each device computes its own previous scan rank and change inputs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 5, mobileOk(9)), scanSource: 'manual_rescan' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 5);
    assert.equal(kw.prev_scan_rank, 8);
    assert.equal(kw.mobile.current_rank, 9);
    assert.equal(kw.mobile.prev_scan_rank, 11);
    assert.equal(kw.mobile.best_rank, 9);
    assert.equal(kw.mobile.scan_count, 2);
  });

  test('a mobile failure never overwrites a valid mobile rank or desktop rank, and adds no mobile history row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 7, mobileFail('timeout')), scanSource: 'manual_rescan' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 7, 'desktop updated');
    assert.equal(kw.last_scan_status, 'ok');
    assert.equal(kw.mobile.current_rank, 11, 'last known mobile rank preserved');
    assert.equal(kw.mobile.last_scan_status, 'error');
    assert.ok(kw.mobile.last_scan_error);
    assert.equal(deriveMobileStatus(kw.mobile), 'scan_error');
    assert.equal((await hist(projectId, 'alpha', 'mobile')).length, 1, 'failed scan is not an observation');
  });

  test('a desktop failure never overwrites a valid desktop rank, and mobile still updates', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await mergeSingleKeywordRescan({
      projectId, userId, domain: 'site.com',
      keywordResult: result('alpha', null, mobileOk(6), { scan_error: 'boom' }), scanSource: 'manual_rescan',
    });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 8, 'desktop rank preserved');
    assert.equal(kw.last_scan_status, 'error');
    assert.equal(kw.mobile.current_rank, 6);
    assert.equal(kw.mobile.last_scan_status, 'ok');
  });

  test('first-ever mobile scan failing is "scan_error" with no rank — not "not_ranked" and not "ranked"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileFail('timeout'))], scanSource: 'onboarding' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.mobile.current_rank, null);
    assert.equal(deriveMobileStatus(kw.mobile), 'scan_error');
    assert.equal((await hist(projectId, 'alpha', 'mobile')).length, 0);
  });

  test('a successful mobile scan with no ranking is "not_ranked" with the verified depth and is recorded in history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(null, { tracked_depth: 94 }))], scanSource: 'onboarding' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.mobile.current_rank, null);
    assert.equal(kw.mobile.last_scan_status, 'ok');
    assert.equal(kw.mobile.tracked_depth, 94);
    assert.equal(deriveMobileStatus(kw.mobile), 'not_ranked');
    const m = await hist(projectId, 'alpha', 'mobile');
    assert.equal(m.length, 1);
    assert.equal(m[0].current_rank, null);
  });

  test('a rescan with mobile switched off keeps existing mobile data untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 6), scanSource: 'manual_rescan' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 6);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.scan_count, 1);
  });

  test('a later full save without mobile data does not drop previously stored mobile data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 7)], scanSource: 'scheduled' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 7);
    assert.equal(kw.mobile.current_rank, 11);
  });

  test('concurrent rescans of different keywords do not erase each other', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11)), result('beta', 20, mobileOk(25))], scanSource: 'onboarding' });
    await Promise.all([
      mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 2, mobileOk(3)), scanSource: 'manual_rescan' }),
      mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('beta', 12, mobileOk(14)), scanSource: 'manual_rescan' }),
    ]);

    const a = await getKw(projectId, 'alpha');
    const b = await getKw(projectId, 'beta');
    assert.equal(a.current_rank, 2);
    assert.equal(a.mobile.current_rank, 3);
    assert.equal(b.current_rank, 12);
    assert.equal(b.mobile.current_rank, 14);
  });

  test('concurrent rescans of the same keyword where each only has one good device keep both good results', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    await Promise.all([
      mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 4, mobileFail()), scanSource: 'manual_rescan' }),
      mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', null, mobileOk(5), { scan_error: 'boom' }), scanSource: 'manual_rescan' }),
    ]);

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 4, 'desktop result from the scan where desktop succeeded');
    assert.equal(kw.mobile.current_rank, 5, 'mobile result from the scan where mobile succeeded');
  });

  test('an older result cannot overwrite a newer one (ordering rule)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    const newer = new Date(Date.now() + 60_000);
    const older = new Date(Date.now() + 30_000);
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 3, mobileOk(4, { scanned_at: newer }), { scanned_at: newer }), scanSource: 'manual_rescan' });
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: result('alpha', 30, mobileOk(40, { scanned_at: older }), { scanned_at: older }), scanSource: 'manual_rescan' });

    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.current_rank, 3);
    assert.equal(kw.mobile.current_rank, 4);
  });

  test('a duplicate delivery of the same result does not add duplicate history rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8, mobileOk(11))], scanSource: 'onboarding' });
    const again = result('alpha', 8, mobileOk(11));
    await mergeSingleKeywordRescan({ projectId, userId, domain: 'site.com', keywordResult: again, scanSource: 'onboarding' });

    assert.equal((await hist(projectId, 'alpha', 'desktop')).length, 1);
    assert.equal((await hist(projectId, 'alpha', 'mobile')).length, 1);
  });

  test('the duplicate check only compares with the LATEST entry: 5 -> 6 -> 5 within a minute records all three changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const args = { projectId, userId, domain: 'site.com', keyword: 'alpha', mapsRank: null, rankingUrls: [], scanSource: 'manual_rescan' };
    for (const rank of [5, 5, 6, 5]) await appendHistory({ ...args, currentRank: rank, device: 'mobile' });
    const rows = await hist(projectId, 'alpha', 'mobile');
    assert.deepEqual(rows.map(r => r.current_rank), [5, 6, 5]);
  });

  test('the duplicate check is per device: identical desktop and mobile results both record', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const args = { projectId, userId, domain: 'site.com', keyword: 'alpha', currentRank: 7, mapsRank: null, rankingUrls: [], scanSource: 'manual_rescan' };
    await appendHistory({ ...args, device: 'desktop' });
    await appendHistory({ ...args, device: 'mobile' });
    assert.equal((await hist(projectId, 'alpha', 'desktop')).length, 1);
    assert.equal((await hist(projectId, 'alpha', 'mobile')).length, 1);
  });

  test('a repeat of the same result outside the window is a legitimate new observation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await KeywordRankingHistory.create({ project_id: projectId, user_id: userId, domain: 'site.com', keyword: 'alpha', keyword_normalized: 'alpha', device: 'mobile', scanned_at: old, current_rank: 7, scan_source: 'manual_rescan', ranking_urls: [] });
    await appendHistory({ projectId, userId, domain: 'site.com', keyword: 'alpha', currentRank: 7, mapsRank: null, rankingUrls: [], scanSource: 'manual_rescan', device: 'mobile' });
    assert.equal((await hist(projectId, 'alpha', 'mobile')).length, 2);
  });

  test('a Maps position beyond 20 (Maps is requested at depth 100) is stored in current state AND history, not dropped', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', null, null, { maps_rank: 23 })], scanSource: 'onboarding' });
    assert.equal((await getKw(projectId, 'alpha')).maps_rank, 23);
    const rows = await hist(projectId, 'alpha', 'desktop');
    assert.equal(rows.length, 1, 'desktop history row must be written even when maps_rank > 20');
    assert.equal(rows[0].maps_rank, 23);
  });

  test('addKeyword stores the mobile result alongside desktop', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({ ...base(), keywords: [result('alpha', 8)], scanSource: 'onboarding' });
    await addKeyword({ projectId, userId, domain: 'site.com', keywordResult: result('gamma', 9, mobileOk(12)), planId: 'premium' });

    const kw = await getKw(projectId, 'gamma');
    assert.equal(kw.current_rank, 9);
    assert.equal(kw.mobile.current_rank, 12);
    assert.equal((await hist(projectId, 'gamma', 'mobile')).length, 1);
  });

  test('client-supplied mobile data is sanitised (out-of-range ranks and depth are dropped/clamped)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await saveCanonicalRanking({
      ...base(),
      keywords: [result('alpha', 8, { ranking_urls: [{ rank: 500, url: 'https://site.com/x' }, { rank: 14, url: 'https://site.com/y' }], tracked_depth: 9999, scan_error: null })],
      scanSource: 'onboarding',
    });
    const kw = await getKw(projectId, 'alpha');
    assert.equal(kw.mobile.current_rank, 14);
    assert.equal(kw.mobile.tracked_depth, 100);
  });
});

describe('deriveMobileStatus / withDeviceStatuses (API payload shape)', () => {
  test('four distinct states', () => {
    assert.equal(deriveMobileStatus(undefined), 'not_collected');
    assert.equal(deriveMobileStatus({}), 'not_collected');
    assert.equal(deriveMobileStatus({ last_scan_status: 'error', current_rank: 9 }), 'scan_error');
    assert.equal(deriveMobileStatus({ last_scan_status: 'ok', current_rank: 9 }), 'ranked');
    assert.equal(deriveMobileStatus({ last_scan_status: 'ok', current_rank: null }), 'not_ranked');
  });

  test('legacy desktop fields are preserved untouched and a missing mobile object never becomes desktop data', () => {
    const out = withDeviceStatuses({ keyword: 'a', current_rank: 4, prev_week_rank: 6, last_scan_status: 'ok' });
    assert.equal(out.current_rank, 4);
    assert.equal(out.prev_week_rank, 6);
    assert.equal(out.status, 'ranked');
    assert.deepEqual(out.mobile, { status: 'not_collected' });
  });

  test('both objects are populated independently when both were collected', () => {
    const out = withDeviceStatuses({
      keyword: 'a', current_rank: 8, last_scan_status: 'ok',
      mobile: { current_rank: 11, prev_scan_rank: 13, last_scan_status: 'ok', tracked_depth: 100 },
    });
    assert.equal(out.current_rank, 8);
    assert.equal(out.mobile.current_rank, 11);
    assert.equal(out.mobile.status, 'ranked');
  });
});
