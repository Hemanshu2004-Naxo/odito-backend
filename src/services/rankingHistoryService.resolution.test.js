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
 * Persistence of redirect resolution: original_url on ranking_urls, unresolved_candidates on the channel scan, and
 * last-good-rank preservation when the scan is "unknown" because of an unresolved Google redirect.
 * Real MongoDB, auto-skips when unreachable.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const SITE = 'site.com';
const at = (ms) => new Date(Date.now() + ms);
const gotoItem = (rank, dest) => ({ type: 'organic', rank_group: rank, rank_absolute: rank + 1, domain: 'google.com', title: 'Site', url: dest ? `https://google.com/goto?url=${encodeURIComponent(dest)}` : 'https://google.com/goto?url=' });
const dev = (name, items, scannedAt, meta) => buildDeviceResult({ device: name, serpData: serpResponse({ items }).data, serpError: null, attempts: 1, serpMeta: meta ?? { outcome: 'complete', provider_code: 20000, requested_depth: 100, returned_results: items.length }, scanned_at: scannedAt }, SITE);
const kwResult = (keyword, d, m) => ({ keyword, ranking_urls: d.ranking_urls, maps_rank: null, maps_listing: null, scan_error: d.scan_error, rank_state: d.rank_state, attempts: d.attempts, scanned_at: d.scanned_at, ...(d.serp ? { serp: d.serp } : {}), mobile: m });

describe('nextChannelScan unresolved_candidates (pure)', () => {
  test('stored only when positive', () => {
    const base = { existingScan: undefined, existingRank: 8, status: 'scan_error', error: 'x', attempts: 1, at: new Date() };
    assert.equal(nextChannelScan({ ...base, serp: { outcome: 'complete', provider_code: 20000, unresolved_candidates: 2 } }).unresolved_candidates, 2);
    assert.equal('unresolved_candidates' in nextChannelScan({ ...base, serp: { outcome: 'complete', provider_code: 20000, unresolved_candidates: 0 } }), false);
  });
});

describe('redirect resolution persistence', () => {
  let projectId, userId;
  const base = () => ({ projectId, userId, domain: SITE, location: 'Mumbai', locationCode: 1007785, country: 'IN', language: 'en', seoScope: 'national' });
  const getKw = async (keyword) => (await SeoRankingCurrent.findOne({ project_id: projectId }).lean()).keywords.find((k) => k.keyword === keyword);
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId(); userId = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('a resolved /goto result is stored with the resolved url and its original_url', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const items = organicItems(10); items[4] = gotoItem(5, 'https://www.site.com/clinic');
    await saveCanonicalRanking({ ...base(), keywords: [kwResult('kw', dev('desktop', items, at(-1000)), dev('mobile', organicItems(10), at(-1000)))], scanSource: 'onboarding' });
    const kw = await getKw('kw');
    assert.equal(kw.current_rank, 5);
    assert.equal(kw.ranking_urls[0].url, 'https://www.site.com/clinic');
    assert.match(kw.ranking_urls[0].original_url, /google\.com\/goto/);
    const h = await KeywordRankingHistory.findOne({ project_id: projectId, device: 'desktop' }).lean();
    assert.equal(h.ranking_urls[0].url, 'https://www.site.com/clinic');
  });

  test('an unresolved redirect makes the rescan not_ranked_uncertain: the rank state is UPDATED (null, labelled uncertain), the previous rank is kept as previous_successful_rank, X unreadable recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const good = organicItems(20, { 8: SITE });
    await saveCanonicalRanking({ ...base(), keywords: [kwResult('kw', dev('desktop', good, at(-60000)), dev('mobile', good, at(-60000)))], scanSource: 'onboarding' });
    const uncertain = organicItems(20); uncertain[2] = gotoItem(3, null);
    await mergeSingleKeywordRescan({ projectId, userId, domain: SITE, scanSource: 'manual_rescan', keywordResult: kwResult('kw', dev('desktop', uncertain, at(5000)), dev('mobile', good, at(5000))) });
    const kw = await getKw('kw');
    assert.equal(kw.current_rank ?? null, null, 'updated: no confirmed position');
    assert.equal(kw.last_scan_status, 'ok', 'the check ran; this is not a provider failure');
    assert.equal(kw.desktop_scan.status, 'not_found_uncertain');
    assert.equal(kw.desktop_scan.current_rank ?? null, null);
    assert.equal(kw.desktop_scan.previous_successful_rank, 8);
    assert.equal(kw.desktop_scan.unresolved_candidates, 1);
    assert.equal(kw.mobile.current_rank, 8, 'mobile is independent and succeeded');
  });
});
