import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import axios from 'axios';

dotenv.config();
// Retry delays are real code paths; keep them tiny. No SERP mode is set: this is what a process that never loaded DATAFORSEO_SERP_MODE does.
process.env.DATAFORSEO_RETRY_BASE_DELAY_MS = '1';
process.env.DATAFORSEO_RETRY_MAX_DELAY_MS = '2';
delete process.env.DATAFORSEO_SERP_MODE;
delete process.env.DATAFORSEO_SERP_FALLBACK_TO_LIVE;

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { saveCanonicalRanking, mergeSingleKeywordRescan } from './rankingHistoryService.js';
import { scanKeywordDevices, buildDeviceResult } from '../modules/ranking/services/deviceSerpScan.js';
import { providerFor } from '../modules/ranking/standard/config.js';
import { resolveSerpItem } from '../modules/ranking/services/serpUrlResolver.js';
import { serpResponse, organicItems, organicItem } from '../modules/ranking/services/fixtures/organicSerpFixtures.js';

/**
 * Regression for the production incident: tracked domain krishnaeyecentre.com; desktop = 40101, 40101, 40106 (9 organic results of 100
 * requested, some of them opaque Google /goto links, one the ASG corporate site); mobile = 40101 x3. Real getSerpOrganic (Live path) with the HTTP
 * layer stubbed - no paid request is ever made - then the real parser and the real persistence.
 */

const TRACKED = 'krishnaeyecentre.com';
// The visible start of the real production payload (the log line was cut there). It is protobuf bytes, not a URL: see resolver test below.
const OPAQUE_GOTO = 'https://google.com/goto?url=CAESigEBxCJF1zFG37DF23pvK409MsU_fBRruc';
const opaque = (rank) => ({ ...organicItem(rank, 'google.com'), url: OPAQUE_GOTO, title: 'ASG Krishna Eye Centre | An ASG Eye Hospital', domain: 'google.com' });
const productionDesktopItems = () => organicItems(9, { 2: opaque(2), 4: organicItem(4, 'asgeyehospital.com', '/'), 7: opaque(7) });

let mongoAvailable = false;
const realPost = axios.post;
before(async () => { try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { /* skipped */ } });
after(async () => { axios.post = realPost; if (mongoAvailable) await mongoose.connection.close(); });

let posts;
function stubProvider({ desktop, mobile }) {
  posts = { desktop: 0, mobile: 0, urls: new Set() };
  axios.post = async (url, payload) => {
    const device = payload[0].device;
    posts.urls.add(url);
    posts[device] += 1;
    return (device === 'desktop' ? desktop : mobile)(posts[device]);
  };
}
const fail40101 = () => serpResponse({ code: 40101, items: null });

describe('Issue 1: which provider is used', () => {
  test('with no DATAFORSEO_SERP_MODE (or a stale process that never loaded it) every keyword is Live, and the Live endpoint is what is called', async () => {
    assert.equal(providerFor({ keyword: 'k', locationCode: 1, languageCode: 'en' }, {}), 'live');
    assert.equal(providerFor({ keyword: 'k', locationCode: 1, languageCode: 'en' }, { DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT: '0' }), 'live', 'a 0% rollout is Live too');
    stubProvider({ desktop: () => serpResponse({ items: organicItems(10) }), mobile: () => serpResponse({ items: organicItems(10), device: 'mobile' }) });
    await scanKeywordDevices({ keyword: 'regression keyword', locationCode: 1007785, languageCode: 'en', mobileEnabled: true });
    assert.deepEqual([...posts.urls], ['https://api.dataforseo.com/v3/serp/google/organic/live/advanced']);
  });
});

describe('Issue 2: opaque Google goto destinations', () => {
  test('the production payload carries no destination: it is unresolved, never guessed from the title or the Google host', () => {
    const r = resolveSerpItem(opaque(2));
    assert.equal(r.resolutionStatus, 'unresolved');
    assert.equal(r.hostname, null);
    assert.equal(r.registrableDomain, null);
    const bytes = Buffer.from(OPAQUE_GOTO.split('url=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    assert.equal(bytes.toString('latin1').includes('http'), false, 'decoding gives protobuf bytes, not a URL');
    assert.equal(bytes[0], 0x08); // field 1 (varint)
    assert.equal(bytes[2], 0x12); // field 2 (length-delimited, 138 bytes): an opaque token
  });
});

describe('Issue 3: business, branch and corporate website are different things', () => {
  test('the corporate ASG site is NOT a ranking for the tracked branch domain (strict matching is unchanged), in both organic outcomes', () => {
    const scan = (items, code = 20000) => buildDeviceResult({ device: 'desktop', serpData: serpResponse({ code, items }).data, serpError: null, attempts: 1,
      serpMeta: code === 40106 ? { outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: items.length } : null, scanned_at: new Date() }, TRACKED);
    const clean = scan(organicItems(30, { 4: organicItem(4, 'asgeyehospital.com', '/'), 6: organicItem(6, 'www.asgeyehospital.com', '/krishna') }));
    assert.equal(clean.best_rank, null);
    assert.equal(clean.ranking_status, 'not_found', 'a complete SERP with no resolved match and no unresolved candidate is a genuine "not found"');
    const withSite = scan(organicItems(30, { 4: organicItem(4, 'asgeyehospital.com', '/'), 9: organicItem(9, `www.${TRACKED}`, '/') }));
    assert.equal(withSite.best_rank, 9, 'the branch site itself still matches at its own rank_group');
    assert.equal(scan(organicItems(30, { 3: organicItem(3, `${TRACKED}.asgeyehospital.com`) })).best_rank, null, 'a sub-domain look-alike of another registrable domain never matches');
  });
});

describe('Issue 4: the production sequence end to end', () => {
  const kwResult = (d, m) => ({ keyword: 'asg krishna eye centre', ranking_urls: d.ranking_urls, maps_rank: 7, maps_listing: null, scan_error: d.scan_error, rank_state: d.rank_state, attempts: d.attempts, scanned_at: d.scanned_at, ...(d.serp ? { serp: d.serp } : {}), mobile: m });
  const okDevice = (name, rank, at) => buildDeviceResult({ device: name, serpData: serpResponse({ items: organicItems(100, { [rank]: organicItem(rank, TRACKED, '/') }) }).data, serpError: null, attempts: 1,
    serpMeta: { outcome: 'complete', provider_code: 20000, requested_depth: 100, returned_results: 100 }, scanned_at: at }, TRACKED);

  test('desktop 40101,40101,40106 (9 results, opaque links) + mobile 40101 x3: desktop becomes not_ranked_partial after ONE retry, mobile (nothing returned) keeps its rank as a scan error', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not reachable');
    const projectId = new mongoose.Types.ObjectId(); const userId = new mongoose.Types.ObjectId();
    const seedAt = new Date(Date.now() - 3_600_000);
    await saveCanonicalRanking({ projectId, userId, domain: TRACKED, location: 'Hyderabad', locationCode: 1007785, country: 'IN', language: 'en', seoScope: 'local', scanSource: 'onboarding',
      keywords: [kwResult(okDevice('desktop', 12, seedAt), okDevice('mobile', 15, seedAt))] });
    const historyBefore = await KeywordRankingHistory.countDocuments({ project_id: projectId });

    stubProvider({
      desktop: (n) => (n < 3 ? fail40101() : serpResponse({ code: 40106, items: productionDesktopItems(), depth: 100 })),
      mobile: () => fail40101(),
    });
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'asg krishna eye centre', locationCode: 1007785, languageCode: 'en', mobileEnabled: true, cleanDomain: TRACKED });
    // desktop: 3 provider attempts (40101, 40101, 40106) + the single partial retry (40106 again); mobile: 3 attempts, all 40101.
    assert.deepEqual([posts.desktop, posts.mobile], [4, 3]);
    assert.equal(desktop.attempts, 4);
    assert.equal(desktop.serpMeta.outcome, 'partial');
    assert.equal(desktop.serpMeta.returned_results, 9);
    assert.equal(desktop.serpMeta.requested_depth, 100);
    assert.ok(mobile.serpError && !mobile.serpData);

    const d = buildDeviceResult(desktop, TRACKED); const m = buildDeviceResult(mobile, TRACKED);
    assert.equal(d.ranking_status, 'unknown', 'partial + not found is never a verified not-found');
    assert.equal(d.rank_state, 'not_ranked_partial');
    assert.equal(d.best_rank, null);
    assert.equal(d.scan_error, null, 'the check ran: not a provider failure');
    assert.equal(d.unreadable_count >= 0, true);
    assert.equal(m.ranking_status, 'unknown');
    assert.equal(m.rank_state, 'scan_error');
    assert.equal(m.attempts, 3);

    await mergeSingleKeywordRescan({ projectId, userId, domain: TRACKED, keywordResult: kwResult(d, m), scanSource: 'manual_rescan' });
    const kw = (await SeoRankingCurrent.findOne({ project_id: projectId }).lean()).keywords[0];
    assert.equal(kw.current_rank ?? null, null, 'desktop: state updated to "not in the 9 results returned (partial)"');
    assert.equal(kw.best_rank, 12, 'the best rank ever seen is kept');
    assert.equal(kw.desktop_scan.status, 'not_found_partial');
    assert.equal(kw.desktop_scan.previous_successful_rank, 12);
    assert.equal(kw.desktop_scan.serp_outcome, 'partial');
    assert.equal(kw.desktop_scan.returned_results, 9);
    assert.equal(kw.mobile.current_rank, 15, 'mobile: previous ranking preserved');
    assert.equal(kw.mobile.scan.status, 'scan_error');
    assert.equal(new Date(kw.mobile.scan.last_successful_scan_at).getTime(), seedAt.getTime());
    assert.equal(kw.maps_rank, 7, 'the independent Maps result of the same run is kept');
    assert.equal(await KeywordRankingHistory.countDocuments({ project_id: projectId }), historyBefore + 1, 'only the desktop observation is recorded; the failed mobile check adds none');
    await SeoRankingCurrent.deleteMany({ project_id: projectId }); await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('a COMPLETE desktop SERP with opaque Google links and no breadcrumb is not_ranked_uncertain "(X unreadable)" - unknown status, no scan error', () => {
    const items = organicItems(30, { 5: opaque(5), 11: opaque(11) });
    const r = buildDeviceResult({ device: 'desktop', serpData: serpResponse({ items }).data, serpError: null, attempts: 1, serpMeta: null, scanned_at: new Date() }, TRACKED);
    assert.equal(r.ranking_status, 'unknown');
    assert.equal(r.rank_state, 'not_ranked_uncertain');
    assert.equal(r.best_rank, null);
    assert.equal(r.scan_error, null);
    assert.equal(r.unreadable_count, 2);
    assert.equal(r.serp.unresolved_candidates, 2);
  });
});
