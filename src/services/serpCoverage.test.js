import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { saveCanonicalRanking, mergeSingleKeywordRescan, guardShortCoverage } from './rankingHistoryService.js';
import { buildDeviceResult } from '../modules/ranking/services/deviceSerpScan.js';
import { buildSerpOrganicPayload } from '../modules/ranking/services/DataForSeoService.js';
import { summarizeOrganicResponse, assessOrganicOutcome, assessCoverage, toSerpMeta } from '../modules/ranking/services/serpResponseOutcome.js';
import { calculateSerpRankings } from '../modules/ranking/services/serpRankCalculator.js';
import { RankingParserService } from '../modules/ranking/services/RankingParserService.js';
import { providerFor } from '../modules/ranking/standard/config.js';
import { serpResponse, organicItems, organicItem, localPack, peopleAlsoAsk, aiOverview } from '../modules/ranking/services/fixtures/organicSerpFixtures.js';

/**
 * Requested depth vs what the provider returned (production: depth 100 -> 48 desktop / 50 mobile organic results with task status 20000),
 * the ASG domain identity cases, and the preservation rules that depend on coverage. Fixtures follow the production patterns; no request is made.
 */

const TRACKED = 'krishnaeyecentre.com';
const opaque = (rank) => ({ ...organicItem(rank, 'google.com'), url: 'https://google.com/goto?url=CAESigEBxCJF1zFG37DF23pvK409MsU_fBRruc', domain: 'google.com' });
const features = () => [localPack(1, 'someclinic.example'), peopleAlsoAsk(3), aiOverview(0)];
const metaOf = (resp, requested = 100) => {
  const s = summarizeOrganicResponse(resp.data, { requestedDepth: requested });
  return { summary: s, outcome: assessOrganicOutcome(s), meta: toSerpMeta(s, assessOrganicOutcome(s)) };
};
const deviceFrom = (name, resp, domain = TRACKED, at = new Date()) => {
  const { meta } = metaOf(resp);
  return buildDeviceResult({ device: name, serpData: resp.data, serpError: null, attempts: 1, serpMeta: meta, scanned_at: at }, domain);
};

describe('coverage: requested depth vs what the response establishes', () => {
  test('production desktop: depth 100, task 20000, 48 organic results -> returned 48, deepest 48, coverage NOT complete (short)', () => {
    const resp = serpResponse({ items: [...features(), ...organicItems(48)], depth: 100 });
    const { summary, outcome, meta } = metaOf(resp);
    assert.equal(outcome, 'complete', 'the task itself succeeded');
    const c = assessCoverage(summary, outcome);
    assert.deepEqual([c.requestedDepth, c.returnedOrganicCount, c.deepestOrganicRank, c.providerTaskStatus], [100, 48, 48, 20000]);
    assert.equal(c.resultCompleteness, 'short');
    assert.equal(c.coverageComplete, false);
    assert.deepEqual([meta.coverage_complete, meta.result_completeness, meta.deepest_organic_rank, meta.returned_results], [false, 'short', 48, 48]);
  });

  test('production mobile: 50 of 100 is short too; 100 of 100 is full; 40102 is a completed "no results"; 40106 is partial', () => {
    assert.equal(metaOf(serpResponse({ items: organicItems(50), device: 'mobile' })).meta.result_completeness, 'short');
    const full = metaOf(serpResponse({ items: organicItems(100) })).meta;
    assert.deepEqual([full.result_completeness, full.coverage_complete], ['full', true]);
    const none = metaOf(serpResponse({ code: 40102, items: null })).meta;
    assert.deepEqual([none.result_completeness, none.coverage_complete], ['no_results', true]);
    const partial = metaOf(serpResponse({ code: 40106, items: organicItems(40) })).meta;
    assert.deepEqual([partial.result_completeness, partial.coverage_complete], ['partial', false]);
    assert.equal(metaOf(serpResponse({ code: 40106, items: [] })).meta.result_completeness, 'none');
  });

  test('coverage is strict: reaching position 97 of 100 does not establish the depth', () => {
    assert.equal(metaOf(serpResponse({ items: organicItems(97) })).meta.coverage_complete, false);
  });

  test('Odito does not drop results: every organic item the provider sent is counted (SERP features are not organic and do not shrink or inflate it); the request asks for depth 100', () => {
    const resp = serpResponse({ items: [...features(), ...organicItems(48)] });
    assert.equal(RankingParserService._collectAllItems(resp.data).length, 51);
    assert.equal(metaOf(resp).summary.organicCount, 48);
    assert.equal(RankingParserService.observedOrganicDepth(resp.data), 48);
    assert.equal(buildSerpOrganicPayload('kw', 1007785, 'en', 'desktop')[0].depth, 100);
    assert.equal(buildSerpOrganicPayload('kw', 1007785, 'en', 'mobile')[0].depth, 100);
  });

  test('a "not found" on short coverage says what was covered; the result is not_found within 48, never claimed for 100', () => {
    const d = deviceFrom('desktop', serpResponse({ items: organicItems(48) }));
    assert.equal(d.ranking_status, 'not_found');
    assert.equal(d.tracked_depth, 48);
    assert.equal(d.serp.requested_depth, 100);
    assert.equal(d.serp.result_completeness, 'short');
    assert.equal(d.serp.coverage_complete, false);
  });
});

describe('ASG domain identity (production results)', () => {
  const asg = () => organicItems(30, { 9: organicItem(9, 'clinic.asgeyehospital.com', '/'), 10: organicItem(10, 'clinic.asgeyehospital.com', '/x'), 11: organicItem(11, 'justdial.com'), 20: organicItem(20, 'clinic.asgeyehospital.com', '/y') });

  test('the tracked branch domain does NOT match the corporate ASG results (positions 9, 10, 20): strict matching unchanged', () => {
    const r = calculateSerpRankings(serpResponse({ items: asg() }).data, TRACKED);
    assert.equal(r.organicRank, null);
    assert.equal(r.rankingStatus, 'not_found');
  });

  test('with an EXPLICIT verified alternate domain the corporate results count, with the alternate recorded - and look-alikes still never match', () => {
    const r = calculateSerpRankings(serpResponse({ items: asg() }).data, TRACKED, { alternateDomains: ['asgeyehospital.com'] });
    assert.equal(r.organicRank, 9);
    assert.equal(r.matches.length, 3);
    assert.equal(r.matches[0].viaAlternateDomain, 'asgeyehospital.com');
    const lookalikes = organicItems(20, { 4: organicItem(4, 'asgeyehospital.com.evil.example'), 5: organicItem(5, 'notasgeyehospital.com'), 6: organicItem(6, 'asgeyehospital.in') });
    assert.equal(calculateSerpRankings(serpResponse({ items: lookalikes }).data, TRACKED, { alternateDomains: ['asgeyehospital.com'] }).organicRank, null);
    const strictAlt = calculateSerpRankings(serpResponse({ items: asg() }).data, TRACKED, { alternateDomains: [{ domain: 'asgeyehospital.com', policy: 'hostname' }] });
    assert.equal(strictAlt.organicRank, null, 'an alternate registered as exact-hostname does not cover its sub-domains');
  });

  test('the tracked domain itself still wins/matches as before, and no alternates are used unless given', () => {
    const items = organicItems(30, { 5: organicItem(5, `www.${TRACKED}`, '/'), 9: organicItem(9, 'clinic.asgeyehospital.com') });
    const r = calculateSerpRankings(serpResponse({ items }).data, TRACKED, { alternateDomains: ['asgeyehospital.com'] });
    assert.equal(r.organicRank, 5);
    assert.equal(r.matches[0].viaAlternateDomain, null);
    assert.equal(calculateSerpRankings(serpResponse({ items }).data, TRACKED).matches.length, 1);
  });

  test('unreadable Google redirects (no breadcrumb) next to the corporate results: not_ranked_uncertain, never a verified not_found', () => {
    const r = deviceFrom('desktop', serpResponse({ items: organicItems(48, { 3: opaque(3), 9: organicItem(9, 'clinic.asgeyehospital.com') }) }));
    assert.equal(r.ranking_status, 'unknown');
    assert.equal(r.rank_state, 'not_ranked_uncertain');
    assert.equal(r.best_rank, null);
    assert.equal(r.unreadable_count, 1);
  });
});

describe('guardShortCoverage (pure)', () => {
  const short = { result_completeness: 'short', deepest_organic_rank: 48, returned_results: 48, requested_depth: 100 };
  test('short + not found + previous rank beyond the returned range -> unverified (scan error)', () => {
    const g = guardShortCoverage(72, { ranking_urls: [], scan_error: null, serp: short });
    assert.match(g.scan_error, /only 48 of 100 requested organic results.*#72.*could not be verified/);
  });
  test('inside the returned range, found, complete coverage, an existing error, or no previous rank -> untouched', () => {
    const base = { ranking_urls: [], scan_error: null, serp: short };
    assert.equal(guardShortCoverage(20, base).scan_error, null);
    assert.equal(guardShortCoverage(null, base).scan_error, null);
    assert.equal(guardShortCoverage(72, { ...base, ranking_urls: [{ rank: 30, url: 'u' }] }).scan_error, null);
    assert.equal(guardShortCoverage(72, { ...base, serp: { ...short, result_completeness: 'full' } }).scan_error, null);
    assert.equal(guardShortCoverage(72, { ...base, scan_error: 'x' }).scan_error, 'x');
    assert.equal(guardShortCoverage(72, undefined), undefined);
  });
});

describe('provider selection (no paid request)', () => {
  const k = { keyword: 'asg krishna eye centre', locationCode: 1007785, languageCode: 'en' };
  test('Live is selected without the variable; Standard when set (and inside the rollout); a 0% rollout is Live', () => {
    assert.equal(providerFor(k, {}), 'live');
    assert.equal(providerFor(k, { DATAFORSEO_SERP_MODE: 'standard' }), 'standard');
    assert.equal(providerFor(k, { DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT: '0' }), 'live');
    assert.equal(providerFor(k, { DATAFORSEO_SERP_MODE: 'Standard\n' }), 'standard', 'whitespace in a copied value does not silently turn it off');
  });
});

describe('preservation with short coverage (real MongoDB)', () => {
  let mongoAvailable = false;
  before(async () => { try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { /* skipped */ } });
  // Cleanup touches ONLY the records this file created (by their own generated project ids) - never anything matched by domain.
  const created = [];
  after(async () => {
    if (!mongoAvailable) return;
    await SeoRankingCurrent.deleteMany({ project_id: { $in: created } });
    await KeywordRankingHistory.deleteMany({ project_id: { $in: created } });
    await mongoose.connection.close();
  });

  let projectId; let userId;
  const baseOpts = () => ({ projectId, userId, domain: TRACKED, location: 'Hyderabad', locationCode: 1007785, country: 'IN', language: 'en', seoScope: 'national' });
  const kwResult = (d, m) => ({ keyword: 'kw', ranking_urls: d.ranking_urls, maps_rank: 7, maps_listing: null, scan_error: d.scan_error, rank_state: d.rank_state, attempts: d.attempts, scanned_at: d.scanned_at, ...(d.serp ? { serp: d.serp } : {}), mobile: m });
  const at = (ms) => new Date(Date.now() + ms);
  const seed = async (desktopRank, mobileRank) => saveCanonicalRanking({ ...baseOpts(), scanSource: 'onboarding', keywords: [kwResult(
    deviceFrom('desktop', serpResponse({ items: organicItems(100, { [desktopRank]: organicItem(desktopRank, TRACKED, '/') }) }), TRACKED, at(-120_000)),
    deviceFrom('mobile', serpResponse({ items: organicItems(100, { [mobileRank]: organicItem(mobileRank, TRACKED, '/') }), device: 'mobile' }), TRACKED, at(-120_000)))] });
  const rescan = (d, m) => mergeSingleKeywordRescan({ projectId, userId, domain: TRACKED, keywordResult: kwResult(d, m), scanSource: 'manual_rescan' });
  const get = async () => (await SeoRankingCurrent.findOne({ project_id: projectId }).lean()).keywords[0];
  const hist = () => KeywordRankingHistory.countDocuments({ project_id: projectId });

  beforeEach(async () => { projectId = new mongoose.Types.ObjectId(); userId = new mongoose.Types.ObjectId(); created.push(projectId); });


  test('48 results (short) + not found + previous desktop #72: #72 is preserved as an unverified scan error; mobile with FULL coverage independently becomes not_found', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not reachable');
    await seed(72, 15);
    const before = await hist();
    await rescan(
      deviceFrom('desktop', serpResponse({ items: organicItems(48) }), TRACKED, at(5_000)),
      deviceFrom('mobile', serpResponse({ items: organicItems(100), device: 'mobile' }), TRACKED, at(5_000)));
    const kw = await get();
    assert.equal(kw.current_rank, 72, 'desktop: previous ranking preserved');
    assert.equal(kw.last_scan_status, 'error');
    assert.match(kw.last_scan_error, /fewer results than requested/);
    assert.doesNotMatch(kw.last_scan_error, /could not be reached/, 'an unverified check is not a connectivity failure');
    assert.equal(kw.desktop_scan.status, 'scan_error');
    assert.equal(kw.desktop_scan.result_completeness, 'short');
    assert.equal(kw.desktop_scan.coverage_complete, false);
    assert.equal(kw.desktop_scan.deepest_organic_rank, 48);
    assert.equal(kw.mobile.current_rank ?? null, null, 'mobile: a verified FULL check legitimately updates to not found');
    assert.equal(kw.mobile.scan.status, 'not_found');
    assert.equal(kw.mobile.scan.coverage_complete, true);
    assert.equal(kw.maps_rank, 7, 'Maps ranking is independent of the unknown organic state');
    assert.equal(await hist(), before + 1, 'only the mobile observation (the verified not found) is recorded; the unverified desktop check adds none');
  });

  test('short coverage with the previous rank INSIDE the returned range: the drop is observable and is recorded as not_found within 48', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not reachable');
    await seed(20, 15);
    await rescan(deviceFrom('desktop', serpResponse({ items: organicItems(48) }), TRACKED, at(5_000)), deviceFrom('mobile', serpResponse({ items: organicItems(100, { 15: organicItem(15, TRACKED, '/') }), device: 'mobile' }), TRACKED, at(5_000)));
    const kw = await get();
    assert.equal(kw.current_rank ?? null, null);
    assert.equal(kw.desktop_scan.status, 'not_found');
    assert.equal(kw.desktop_scan.result_completeness, 'short');
    assert.equal(kw.mobile.current_rank, 15);
  });

  test('a COMPLETE (full coverage) scan without the site legitimately replaces a previous #72 with not_found', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not reachable');
    await seed(72, 15);
    await rescan(deviceFrom('desktop', serpResponse({ items: organicItems(100) }), TRACKED, at(5_000)), deviceFrom('mobile', serpResponse({ items: organicItems(100, { 15: organicItem(15, TRACKED, '/') }), device: 'mobile' }), TRACKED, at(5_000)));
    const kw = await get();
    assert.equal(kw.current_rank ?? null, null);
    assert.equal(kw.desktop_scan.status, 'not_found');
    assert.equal(kw.desktop_scan.coverage_complete, true);
  });
});
