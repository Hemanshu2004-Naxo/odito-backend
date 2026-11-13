import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSerpItem } from './serpUrlResolver.js';
import { calculateSerpRankings } from './serpRankCalculator.js';
import { RankingParserService } from './RankingParserService.js';
import { buildDeviceResult, scanDeviceSerp } from './deviceSerpScan.js';
import { summarizeOrganicResponse, assessOrganicOutcome, assessCoverage, toSerpMeta } from './serpResponseOutcome.js';
import { serpResponse, organicItem, organicItems, localPack } from './fixtures/organicSerpFixtures.js';

/**
 * Masked Google results (google.com/goto?url=CAES...): the real site is read from the breadcrumb the SERP displays; a brand-name match is a
 * LOW-confidence last resort; anything else stays unreadable and says so. Fixtures follow the production response pattern.
 */

const TARGET = 'krishnaeyecentre.com';
const GOTO = 'https://google.com/goto?url=CAESigEBxCJF1zFG37DF23pvK409MsU_fBRruc';
const masked = (rank, { breadcrumb = null, website_name = null, title = `Result ${rank}` } = {}) => ({
  ...organicItem(rank, 'google.com'), url: GOTO, domain: 'google.com', breadcrumb, website_name, title,
});
const resp = (items, over = {}) => serpResponse({ items, ...over }).data;
const device = (items, matchOptions = {}, meta = null) => buildDeviceResult({ device: 'desktop', serpData: resp(items), serpError: null, attempts: 1, serpMeta: meta, scanned_at: new Date() }, TARGET, matchOptions);

describe('host resolution per item', () => {
  test('a real domain resolves from the domain', () => {
    const r = resolveSerpItem(organicItem(1, 'www.justdial.com', '/x'));
    assert.deepEqual([r.hostname, r.resolutionMethod], ['justdial.com', 'direct']);
  });
  test('a goto item resolves from the breadcrumb: www host, sub-domain host, and the host is normalised', () => {
    const www = resolveSerpItem(masked(2, { breadcrumb: 'https://www.JustDial.com › Eye Hospitals › Pal Road...' }));
    assert.deepEqual([www.hostname, www.resolutionMethod, www.resolutionStatus, www.resolvedUrl], ['justdial.com', 'breadcrumb', 'resolved', null]);
    const sub = resolveSerpItem(masked(3, { breadcrumb: 'https://clinic.asgeyehospital.com › best-eye-hospital' }));
    assert.equal(sub.hostname, 'clinic.asgeyehospital.com');
    assert.equal(sub.originalUrl, GOTO, 'the original goto URL is kept');
  });
  test('a goto item with a Google breadcrumb, a private host, a title-only item, or no breadcrumb stays unresolved (a website name is never a host)', () => {
    for (const item of [masked(1, { breadcrumb: 'https://google.com › maps' }), masked(2, { breadcrumb: 'http://10.0.0.5 › x' }), masked(3, { website_name: 'Justdial', title: 'justdial.com - Eye Hospitals' }), masked(4)]) {
      const r = resolveSerpItem(item);
      assert.equal(r.resolutionStatus, 'unresolved');
      assert.equal(r.hostname, null);
    }
  });
});

describe('matching masked results', () => {
  test('target found at rank_group 4 / rank_absolute 7 after a 3-item local pack, via the breadcrumb; the goto link is kept and flagged masked', () => {
    const items = [localPack(1, 'other.example'), localPack(2, 'other2.example'), localPack(3, 'other3.example'),
      ...organicItems(3), { ...masked(4, { breadcrumb: `https://www.${TARGET} › home` }), rank_absolute: 7 }, ...organicItems(3).map((i, k) => ({ ...i, rank_group: 5 + k, rank_absolute: 8 + k }))];
    const calc = calculateSerpRankings(items, TARGET);
    assert.equal(calc.organicRank, 4);
    assert.equal(calc.absoluteRank, 7);
    assert.equal(calc.matches[0].urlMasked, true);
    assert.equal(calc.matches[0].host, TARGET);
    assert.equal(calc.matches[0].url, GOTO);
    assert.equal(calc.matches[0].matchBasis, 'breadcrumb');
    const parsed = RankingParserService.parseOrganic(items, TARGET);
    assert.deepEqual(parsed.ranking_urls[0], { rank: 4, url: GOTO, type: 'internal_page', rank_absolute: 7, host: TARGET, url_masked: true, match_basis: 'breadcrumb' });
  });
  test('sub-domains count (a breadcrumb host under the target); look-alikes do not', () => {
    assert.equal(calculateSerpRankings([masked(2, { breadcrumb: `https://blog.${TARGET} › post` })], TARGET).organicRank, 2);
    assert.equal(calculateSerpRankings([masked(2, { breadcrumb: `https://${TARGET}.evil.example › x` }), masked(3, { breadcrumb: `https://not${TARGET} › x` })], TARGET).organicRank, null);
  });
  test('a goto item with no breadcrumb whose website_name / title match the brand is a LOW-confidence match; without the brand it is unresolved', () => {
    const items = [...organicItems(3), masked(4, { website_name: 'Krishna Eye Centre' }), ...organicItems(2).map((i, k) => ({ ...i, rank_group: 5 + k }))];
    const low = calculateSerpRankings(items, TARGET, { brandName: 'Krishna Eye-Centre' });
    assert.equal(low.organicRank, 4);
    assert.equal(low.matchConfidence, 'low');
    assert.equal(low.matchBasis, 'brand_name');
    assert.equal(low.matches[0].host, null, 'no domain is ever invented');
    assert.equal(low.stats.brandNameMatches, 1);
    assert.deepEqual(RankingParserService.parseOrganic(items, TARGET, { brandName: 'Krishna Eye Centre' }).ranking_urls[0].match_confidence, 'low');
    const none = calculateSerpRankings(items, TARGET);
    assert.equal(none.organicRank, null);
    assert.equal(none.stats.unresolvedOrganic, 1);
    assert.equal(calculateSerpRankings([masked(4, { title: 'ASG' })], TARGET, { brandName: 'ASG' }).organicRank, null, 'a very short brand is too weak to match on');
    const titleMatch = calculateSerpRankings([masked(2, { title: 'Krishna Eye Centre - Hyderabad' })], TARGET, { brandName: 'krishna eye centre' });
    assert.equal(titleMatch.organicRank, 2);
  });
  test('a confident match beats a brand-name guess even when the guess ranks higher', () => {
    const calc = calculateSerpRankings([masked(2, { website_name: 'Krishna Eye Centre' }), organicItem(6, `www.${TARGET}`)], TARGET, { brandName: 'Krishna Eye Centre' });
    assert.equal(calc.organicRank, 6);
    assert.equal(calc.matchConfidence, 'high');
  });
  test('additionalDomains: a match on a verified additional domain counts and records which domain matched', () => {
    const items = organicItems(12, { 9: organicItem(9, 'clinic.asgeyehospital.com', '/') });
    const parsed = RankingParserService.parseOrganic(items, TARGET, { alternateDomains: ['asgeyehospital.com'] });
    assert.equal(parsed.best_rank, 9);
    assert.equal(parsed.ranking_urls[0].matched_domain, 'asgeyehospital.com');
    assert.equal(RankingParserService.parseOrganic(items, TARGET).best_rank, null);
  });
});

describe('status per device', () => {
  test('100% masked results, every one readable from its breadcrumb, target absent -> not_ranked (a valid result), not scan_error', () => {
    const items = Array.from({ length: 40 }, (_, i) => masked(i + 1, { breadcrumb: `https://site${i + 1}.example › page` }));
    const d = device(items);
    assert.equal(d.rank_state, 'not_ranked');
    assert.equal(d.ranking_status, 'not_found');
    assert.equal(d.scan_error, null);
    assert.equal(d.unreadable_count, 0);
    assert.equal(d.tracked_depth, 40);
  });
  test('some results unreadable and the target absent -> not_ranked_uncertain with the unreadable count (not a scan error)', () => {
    const items = [...organicItems(5), masked(6), masked(7, { breadcrumb: 'https://readable.example › x' }), masked(8)];
    const d = device(items);
    assert.equal(d.rank_state, 'not_ranked_uncertain');
    assert.equal(d.unreadable_count, 2);
    assert.equal(d.scan_error, null);
    assert.equal(d.best_rank, null);
  });
  test('target found among masked results -> ranked with rank_group (match basis recorded)', () => {
    const d = device([...organicItems(3), masked(4, { breadcrumb: `https://${TARGET} › home` })]);
    assert.deepEqual([d.rank_state, d.best_rank, d.match_basis], ['ranked', 4, 'breadcrumb']);
  });
});

describe('retries: partial once, 40101 through the provider loop', () => {
  const partialMeta = (n) => ({ outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: n });
  const tagged = (data, meta) => { Object.defineProperty(data, 'dfsSerpMeta', { value: meta }); return data; };
  test('40106 without the site is fetched ONE more time; still partial -> not_ranked_partial', async () => {
    let calls = 0;
    const serpFetcher = async () => { calls += 1; return tagged(resp(organicItems(9), { code: 40106 }), partialMeta(9)); };
    const scan = await scanDeviceSerp({ keyword: 'k', locationCode: 1, languageCode: 'en', device: 'desktop', serpFetcher, cleanDomain: TARGET });
    assert.equal(calls, 2);
    const d = buildDeviceResult(scan, TARGET);
    assert.equal(d.rank_state, 'not_ranked_partial');
    assert.equal(d.scan_error, null);
    assert.equal(d.tracked_depth, 9, 'N = the deepest rank returned');
  });
  test('the retry fails -> the first partial answer stands (no scan error); no cleanDomain -> no retry', async () => {
    let calls = 0;
    const serpFetcher = async () => { calls += 1; if (calls === 2) throw new Error('boom'); return tagged(resp(organicItems(9), { code: 40106 }), partialMeta(9)); };
    const scan = await scanDeviceSerp({ keyword: 'k', locationCode: 1, languageCode: 'en', device: 'desktop', serpFetcher, cleanDomain: TARGET });
    assert.equal(scan.serpError, null);
    assert.equal(buildDeviceResult(scan, TARGET).rank_state, 'not_ranked_partial');
    calls = 0;
    await scanDeviceSerp({ keyword: 'k', locationCode: 1, languageCode: 'en', device: 'desktop', serpFetcher: async () => { calls += 1; return tagged(resp(organicItems(9), { code: 40106 }), partialMeta(9)); } });
    assert.equal(calls, 1);
  });
  test('a Standard-provider answer is not retried (the task is shared and already got the provider\'s own retries)', async () => {
    let calls = 0;
    const serpFetcher = async () => { calls += 1; const d = tagged(resp(organicItems(9), { code: 40106 }), partialMeta(9)); Object.defineProperty(d, 'dfsProvider', { value: 'standard' }); return d; };
    await scanDeviceSerp({ keyword: 'k', locationCode: 1, languageCode: 'en', device: 'desktop', serpFetcher, cleanDomain: TARGET });
    assert.equal(calls, 1);
  });
});

describe('coverage', () => {
  const coverage = (organic, { se, pages, depth = 100 }) => {
    const data = serpResponse({ items: organicItems(organic) }).data;
    data.tasks[0].result[0].se_results_count = se;
    data.tasks[0].result[0].pages_count = pages;
    const s = summarizeOrganicResponse(data, { requestedDepth: depth });
    return assessCoverage(s, assessOrganicOutcome(s));
  };
  test('mobile 75 organic, se_results_count 74, 8 pages, depth 100 -> complete', () => {
    const c = coverage(75, { se: 74, pages: 8 });
    assert.equal(c.coverageComplete, true);
    assert.equal(c.resultCompleteness, 'full');
  });
  test('each rule alone: depth reached; every reported result returned; Google ran out of pages', () => {
    assert.equal(coverage(100, { se: 5_000_000, pages: 10 }).coverageComplete, true);
    assert.equal(coverage(48, { se: 48, pages: 10 }).coverageComplete, true);
    assert.equal(coverage(48, { se: 1_230_000, pages: 5 }).coverageComplete, true);
  });
  test('still short when none holds (48 of 100, 1.2M reported results, 10 pages); a 40106 is never complete', () => {
    assert.equal(coverage(48, { se: 1_230_000, pages: 10 }).resultCompleteness, 'short');
    const data = serpResponse({ code: 40106, items: organicItems(75) }).data;
    data.tasks[0].result[0].se_results_count = 74; data.tasks[0].result[0].pages_count = 8;
    const s = summarizeOrganicResponse(data, { requestedDepth: 100 });
    assert.equal(assessCoverage(s, assessOrganicOutcome(s)).coverageComplete, false);
    assert.equal(toSerpMeta(summarizeOrganicResponse(serpResponse({ items: organicItems(100) }).data, { requestedDepth: 100 }), 'complete').pages_count, undefined);
  });
});
