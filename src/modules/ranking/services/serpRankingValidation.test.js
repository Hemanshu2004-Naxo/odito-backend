import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSerpRankings } from './serpRankCalculator.js';
import { buildDeviceResult } from './deviceSerpScan.js';
import { buildSerpValidationReport, formatSerpValidationReport } from './serpValidationReport.js';
import { organicItem, organicItems, serpResponse } from './fixtures/organicSerpFixtures.js';

const T = 'asgeyehospital.com';
const enc = encodeURIComponent;
const goto = (rank, dest, extra = {}) => ({
  type: 'organic', rank_group: rank, rank_absolute: rank + 2, title: 'ASG Eye Hospital', domain: 'google.com',
  url: dest ? `https://google.com/goto?url=${enc(dest)}` : 'https://google.com/goto?url=', ...extra,
});
const scan = (data, serpMeta = null) => buildDeviceResult({ device: 'desktop', serpData: data, serpError: null, attempts: 1, serpMeta, scanned_at: new Date() }, T);
const wrap = (items) => serpResponse({ items }).data;

describe('conservative ranking status', () => {
  test('complete SERP, no match, no unresolved candidates -> not_found', () => {
    const d = scan(wrap(organicItems(40)));
    assert.deepEqual([d.ranking_status, d.completeness, d.scan_error], ['not_found', 'complete', null]);
  });

  test('complete SERP, no match, but an unresolved redirect result -> not_ranked_uncertain (unknown status, X unreadable, not a scan error)', () => {
    const d = scan(wrap([...organicItems(5), goto(6, null), ...organicItems(3).map((i, k) => ({ ...i, rank_group: 7 + k, rank_absolute: 9 + k }))]));
    assert.equal(d.ranking_status, 'unknown');
    assert.equal(d.best_rank, null);
    assert.equal(d.scan_error, null);
    assert.equal(d.rank_state, 'not_ranked_uncertain');
    assert.equal(d.unreadable_count, 1);
    assert.equal(d.serp?.unresolved_candidates, 1);
  });

  test('confirmed match wins even when other results are unresolved; better rank possible is flagged only if it ranks higher', () => {
    const above = calculateSerpRankings([goto(1, null), organicItem(2, T)], T);
    assert.equal(above.rankingStatus, 'found');
    assert.equal(above.organicRank, 2);
    assert.equal(above.betterRankPossible, true);
    const below = calculateSerpRankings([organicItem(1, T), goto(2, null)], T);
    assert.equal(below.betterRankPossible, false);
  });

  test('an unresolved redirect that carries a real provider domain is resolved, not uncertain', () => {
    const r = calculateSerpRankings([goto(1, null, { domain: 'www.asgeyehospital.com' })], T);
    assert.equal(r.organicRank, 1);
    const other = calculateSerpRankings([goto(1, null, { domain: 'competitor.com' })], T);
    assert.equal(other.rankingStatus, 'not_found');
  });

  test('invalid / unsupported organic URLs are not "relevant unresolved candidates"', () => {
    const r = calculateSerpRankings([{ type: 'organic', rank_group: 1, rank_absolute: 1, url: 'javascript:void(0)' }, { type: 'organic', rank_group: 2, rank_absolute: 2, url: 'http://127.0.0.1/' }], T);
    assert.equal(r.rankingStatus, 'not_found');
  });

  test('rank-less match is unknown, never a position', () => {
    const d = scan(wrap([{ ...organicItem(1, T), rank_group: undefined }]));
    assert.equal(d.ranking_status, 'unknown');
    assert.equal(d.best_rank, null);
  });

  test('partial response without the site is unknown/partial; found inside a partial response stays found/partial', () => {
    const partialMeta = { outcome: 'partial', provider_code: 40106, requested_depth: 100, returned_results: 40 };
    const none = scan(wrap(organicItems(40)), partialMeta);
    assert.deepEqual([none.ranking_status, none.completeness], ['unknown', 'partial']);
    const found = scan(wrap(organicItems(40, { 7: T })), partialMeta);
    assert.deepEqual([found.ranking_status, found.completeness, found.best_rank], ['found', 'partial', 7]);
  });

  test('Local Pack listing that only carries a Google Maps link has no website and no invented domain', () => {
    const r = calculateSerpRankings([{ type: 'local_pack', items: [{ type: 'local_pack_element', rank_group: 1, rank_absolute: 1, title: 'ASG', cid: '77', url: 'https://www.google.com/maps/place/?cid=77', domain: 'google.com' }] }], T);
    assert.deepEqual(r.localPackCandidates[0], { position: 1, cid: '77', title: 'ASG', hostname: null, hasWebsite: false });
    assert.equal(r.localPackRank, null);
  });
});

describe('SERP-to-ranking accuracy report (realistic mixed SERP)', () => {
  // Original provider ordering, with ads, a local pack, a snippet, duplicates, a www variant, a /goto redirect and a look-alike.
  const items = [
    { type: 'paid', rank_group: 1, rank_absolute: 1, domain: T, url: `https://${T}/ad` },
    { type: 'local_pack', rank_group: 1, rank_absolute: 2, items: [
      { type: 'local_pack_element', rank_group: 1, rank_absolute: 1, title: 'Rival', domain: 'rival.com', url: 'https://rival.com/' },
      { type: 'local_pack_element', rank_group: 2, rank_absolute: 2, title: 'ASG', cid: '55', domain: T, url: `https://${T}/` },
    ] },
    { type: 'featured_snippet', rank_group: 1, rank_absolute: 3, domain: T, url: `https://${T}/snippet` },
    { type: 'organic', rank_group: 1, rank_absolute: 4, domain: 'competitor.com', url: 'https://competitor.com/' },
    { type: 'organic', rank_group: 2, rank_absolute: 5, domain: `fake${T}`, url: `https://fake${T}/` },
    goto(3, `https://www.${T}/pune`, { rank_absolute: 6 }),
    { type: 'organic', rank_group: 4, rank_absolute: 7, domain: T, url: `https://${T}/pune` },
    { type: 'organic', rank_group: 5, rank_absolute: 8, domain: `www.${T}`, url: `https://www.${T}/pune` },
    { type: 'people_also_ask', rank_group: 1, rank_absolute: 9, items: [] },
  ];
  const report = buildSerpValidationReport(wrap(items), T, { device: 'desktop', requestedDepth: 100 });

  test('final positions: organic from rank_group of the best page, local pack separate, ads / snippet ignored', () => {
    assert.deepEqual(report.final, { organicRank: 3, absoluteRank: 6, localPackRank: 2, rankingStatus: 'found', betterRankPossible: false, unresolvedOrganic: 0 });
  });

  test('positions are unchanged by URL resolution: every row keeps the provider rank_group / rank_absolute', () => {
    const organicRows = report.rows.filter((r) => r.type === 'organic');
    assert.deepEqual(organicRows.map((r) => [r.rank_group, r.rank_absolute]), [[1, 4], [2, 5], [3, 6], [4, 7], [5, 8]]);
    const g = organicRows[2];
    assert.equal(g.resolvedHostname, T);
    assert.equal(g.resolutionMethod, 'redirect_parameter');
    assert.match(g.originalUrl, /google\.com\/goto/);
  });

  test('competitors stay available in the report; look-alike is not a match; duplicates collapse to one ranking URL per distinct URL', () => {
    const matched = report.rows.filter((r) => r.type === 'organic' && r.matched).map((r) => r.rank_group);
    assert.deepEqual(matched, [3, 4, 5]);
    assert.equal(report.rows.find((r) => r.resolvedHostname === 'competitor.com').matched, false);
    assert.equal(report.rows.find((r) => r.resolvedHostname === `fake${T}`).matched, false);
    // rank-3 /goto resolves to the same URL as the rank-5 www page: one ranking URL, the best (3) kept.
    assert.deepEqual(calculateSerpRankings(wrap(items), T).matches.map((m) => m.rank), [3, 4]);
  });

  test('www and non-www of the same page are separate URLs but one site; resolved goto is deduplicated against its twin', () => {
    const dup = calculateSerpRankings([goto(1, `https://${T}/x`), organicItem(2, T, '/x')], T);
    assert.equal(dup.organicRank, 1);
    assert.equal(dup.matches.length, 1);
  });

  test('the text report renders every row and the FINAL line', () => {
    const text = formatSerpValidationReport(report);
    assert.match(text, /FINAL organic=3 absolute=6 localPack=2 status=found/);
    assert.match(text, /MATCH\(redirect|MATCH\(exact_hostname/);
    assert.equal(text.split('\n').length, report.rows.length + 2);
  });

  test('a partial provider code downgrades a not_found report to unknown', () => {
    const r = buildSerpValidationReport(serpResponse({ code: 40106, items: organicItems(30) }).data, T, { device: 'mobile' });
    assert.deepEqual([r.completeness, r.final.rankingStatus], ['partial', 'unknown']);
  });
});
