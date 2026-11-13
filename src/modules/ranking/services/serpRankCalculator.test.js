import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSerpRankings, enrichLocalPackCandidates } from './serpRankCalculator.js';
import { RankingParserService } from './RankingParserService.js';
import { scanKeywordDevices, buildDeviceResult } from './deviceSerpScan.js';
import { organicItem, organicItems, localPack, serpResponse } from './fixtures/organicSerpFixtures.js';

const T = 'example.com';
const enc = encodeURIComponent;
const wrap = (items) => ({ tasks: [{ status_code: 20000, result: [{ items }] }] });
const org = (group, abs, url, extra = {}) => ({ type: 'organic', rank_group: group, rank_absolute: abs, url, domain: new URL(url).hostname, ...extra });

describe('organic ranking', () => {
  test('rank_group is the organic rank and rank_absolute the absolute rank (spec example)', () => {
    const r = calculateSerpRankings(wrap([
      org(1, 2, 'https://competitor.com/'), org(2, 3, 'https://anothercompetitor.com/'), org(3, 4, 'https://example.com/'),
    ]), T);
    assert.equal(r.organicRank, 3);
    assert.equal(r.absoluteRank, 4);
    assert.equal(r.rankingStatus, 'found');
  });

  test('rank does not depend on array position: earlier elements missing or other types interleaved', () => {
    const items = [
      { type: 'paid', rank_group: 1, rank_absolute: 1, url: 'https://example.com/ad', domain: 'example.com' },
      { type: 'featured_snippet', rank_group: 1, rank_absolute: 2, url: 'https://example.com/snip', domain: 'example.com' },
      { type: 'ai_overview', rank_group: 1, rank_absolute: 3, items: [] },
      org(1, 6, 'https://c1.com/'),
      org(2, 7, 'https://example.com/found'),
    ];
    const r = calculateSerpRankings(items, T);
    assert.equal(r.organicRank, 2);
    assert.equal(r.absoluteRank, 7);
    assert.equal(calculateSerpRankings(items.filter((i) => i.type === 'organic'), T).organicRank, 2);
    assert.equal(calculateSerpRankings([org(2, 7, 'https://example.com/found')], T).organicRank, 2);
  });

  test('paid, featured snippet and other non-organic types never count as organic', () => {
    const r = calculateSerpRankings([
      { type: 'paid', rank_group: 1, rank_absolute: 1, url: 'https://example.com/', domain: 'example.com' },
      { type: 'featured_snippet', rank_group: 1, rank_absolute: 2, url: 'https://example.com/', domain: 'example.com' },
      { type: 'maps_search', rank_group: 1, rank_absolute: 3, url: 'https://example.com/', domain: 'example.com' },
    ], T);
    assert.equal(r.organicRank, null);
    assert.equal(r.rankingStatus, 'not_found');
  });

  test('multiple matching URLs: best valid rank wins, all kept, duplicates collapsed, provider order for ties', () => {
    const r = calculateSerpRankings([
      org(4, 5, 'https://example.com/b'), org(2, 3, 'https://www.example.com/a'), org(2, 3, 'https://www.example.com/a'), org(9, 11, 'https://blog.example.com/x'),
    ], T);
    assert.equal(r.organicRank, 2);
    assert.equal(r.absoluteRank, 3);
    assert.deepEqual(r.matches.map((x) => x.rank), [2, 4, 9]);
  });

  test('missing or invalid rank metadata never invents a position', () => {
    for (const bad of [{ rank_group: undefined }, { rank_group: null }, { rank_group: 0 }, { rank_group: '3' }, { rank_group: -1 }]) {
      const r = calculateSerpRankings([org(1, 4, 'https://example.com/', bad)], T);
      assert.equal(r.organicRank, null, JSON.stringify(bad));
      assert.equal(r.rankingStatus, 'unknown');
    }
    const onlyAbsolute = calculateSerpRankings([{ type: 'organic', rank_absolute: 5, url: 'https://example.com/' }], T);
    assert.equal(onlyAbsolute.organicRank, null);
  });

  test('look-alike domains are not the tracked site', () => {
    const r = calculateSerpRankings([org(1, 2, 'https://fakeexample.com/'), org(2, 3, 'https://example.com.fake.org/')], T);
    assert.equal(r.rankingStatus, 'not_found');
  });

  test('Google goto result resolves to the real site and ranks; unresolved one is counted, not matched', () => {
    const goto = org(3, 4, `https://google.com/goto?url=${enc('https://www.example.com/clinic')}`, { domain: 'google.com' });
    const r = calculateSerpRankings([org(1, 2, 'https://c.com/'), goto], T);
    assert.equal(r.organicRank, 3);
    assert.equal(r.matches[0].url, 'https://www.example.com/clinic');
    assert.match(r.matches[0].originalUrl, /google\.com\/goto/);
    const dead = calculateSerpRankings([org(1, 2, 'https://google.com/goto?url=', { domain: 'google.com', title: 'Example' })], T);
    assert.equal(dead.organicRank, null);
    assert.equal(dead.stats.unresolvedOrganic, 1);
  });

  test('depth 100 response, and a response shorter than 100', () => {
    const full = calculateSerpRankings(wrap(organicItems(100, { 100: 'example.com' })), T);
    assert.equal(full.organicRank, 100);
    const short = calculateSerpRankings(wrap(organicItems(63)), T);
    assert.equal(short.rankingStatus, 'not_found');
    assert.equal(short.stats.organicItems, 63);
  });

  test('complete SERP with no matching website is not_found with null ranks', () => {
    const r = calculateSerpRankings(wrap(organicItems(30)), T);
    assert.deepEqual([r.organicRank, r.absoluteRank, r.localPackRank, r.rankingStatus], [null, null, null, 'not_found']);
  });
});

describe('local pack separation', () => {
  const pack = (els) => ({ type: 'local_pack', rank_group: 1, rank_absolute: 1, items: els });
  const el = (position, title, extra = {}) => ({ type: 'local_pack_element', rank_group: position, rank_absolute: position, title, ...extra });

  test('local pack position never becomes the organic rank (and vice versa)', () => {
    const r = calculateSerpRankings([pack([el(1, 'A', { domain: 'a.com', url: 'https://a.com/' }), el(2, 'Mine', { domain: 'example.com', url: 'https://example.com/' })])], T);
    assert.equal(r.organicRank, null);
    assert.equal(r.localPackRank, 2);
    assert.equal(r.rankingStatus, 'not_found');
    const both = calculateSerpRankings([pack([el(3, 'Mine', { domain: 'example.com' })]), org(7, 12, 'https://example.com/')], T);
    assert.deepEqual([both.organicRank, both.absoluteRank, both.localPackRank], [7, 12, 3]);
  });

  test('substring domain matches no longer count as the business', () => {
    const r = calculateSerpRankings([pack([el(1, 'X', { domain: 'tech.com' }), el(2, 'Y', { domain: 'wowinfotech.com.example.org' })])], 'wowinfotech.com');
    assert.equal(r.localPackRank, null);
  });

  test('listing without a website is preserved, with no invented domain; cid is kept', () => {
    const r = calculateSerpRankings([pack([el(1, 'No Site Clinic', { cid: '123' })])], T);
    assert.deepEqual(r.localPackCandidates, [{ position: 1, cid: '123', title: 'No Site Clinic', hostname: null, hasWebsite: false }]);
  });

  test('Maps enrichment fills the website for a cid and matches it; failures invent nothing', async () => {
    const r = calculateSerpRankings([pack([el(1, 'Mine', { cid: '999' }), el(2, 'Other', { cid: '5' }), el(3, 'Has site', { domain: 'x.com', url: 'https://x.com/' })])], T);
    const calls = [];
    const out = await enrichLocalPackCandidates(r.localPackCandidates, T, async (cid) => {
      calls.push(cid);
      if (cid === '999') return { website: 'https://www.example.com/contact' };
      throw new Error('maps down');
    });
    assert.deepEqual(calls, ['999', '5']);
    assert.equal(out[0].matchesTracked, true);
    assert.equal(out[0].hostname, 'example.com');
    assert.equal(out[1].hostname, null);
    assert.equal(out[2].enriched, false);
  });

  test('parseOrganic keeps its persisted shape and exposes extra detail additively', () => {
    const r = RankingParserService.parseOrganic(wrap([localPack(2, 'example.com').items ? localPack(2, 'example.com') : null, organicItem(3, 'www.example.com')].filter(Boolean)), T);
    // rank/url/type as always; rank_absolute and the resolved host are additive (a direct result carries no masked / low-confidence flags).
    assert.deepEqual(Object.keys(r.ranking_urls[0]).sort(), ['host', 'rank', 'rank_absolute', 'type', 'url']);
    assert.equal(r.best_rank, 3);
    assert.equal(r.absolute_rank, 4);
    assert.equal(r.maps_rank, 1);
    assert.equal(r.ranking_status, 'found');
  });
});

describe('desktop / mobile through the same engine', () => {
  const okSerp = (rank) => serpResponse({ items: organicItems(20, { [rank]: 'example.com' }) }).data;
  const run = (byDevice) => scanKeywordDevices({
    keyword: 'k', locationCode: 1, languageCode: 'en', mobileEnabled: true,
    serpFetcher: async (_k, _l, _g, { device }) => { const v = byDevice[device]; if (v instanceof Error) throw v; return v; },
  });

  test('both succeed with their own ranks', async () => {
    const { desktop, mobile } = await run({ desktop: okSerp(4), mobile: okSerp(9) });
    assert.equal(buildDeviceResult(desktop, T).best_rank, 4);
    assert.equal(buildDeviceResult(mobile, T).best_rank, 9);
  });

  test('desktop success + mobile failure, and the reverse: failure is unknown, never rank 101 / not_found', async () => {
    for (const [ok, bad] of [['desktop', 'mobile'], ['mobile', 'desktop']]) {
      const scans = await run({ [ok]: okSerp(6), [bad]: new Error('40101 Internal SE Server Error') });
      const good = buildDeviceResult(scans[ok], T);
      const fail = buildDeviceResult(scans[bad], T);
      assert.equal(good.best_rank, 6);
      assert.equal(good.ranking_status, 'found');
      assert.equal(fail.best_rank, null);
      assert.equal(fail.ranking_status, 'unknown');
      assert.ok(fail.scan_error);
    }
  });

  test('complete scan without the site is not_found/complete; partial scan without the site is not_ranked_partial (unknown, partial, no scan error)', async () => {
    const complete = buildDeviceResult((await run({ desktop: okSerp(99), mobile: okSerp(99) })).desktop, T);
    assert.deepEqual([complete.ranking_status, complete.completeness, complete.scan_error], ['not_found', 'complete', null]);
    const partialData = serpResponse({ code: 40106, items: organicItems(40) }).data;
    Object.defineProperty(partialData, 'dfsSerpMeta', { value: { outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: 40 } });
    const partial = buildDeviceResult((await run({ desktop: partialData, mobile: okSerp(2) })).desktop, T);
    assert.deepEqual([partial.ranking_status, partial.completeness, partial.best_rank], ['unknown', 'partial', null]);
    assert.equal(partial.scan_error, null);
    assert.equal(partial.rank_state, 'not_ranked_partial');
  });
});
