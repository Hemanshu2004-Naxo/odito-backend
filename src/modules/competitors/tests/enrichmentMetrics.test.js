import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapRankSection, mapBacklinksSection, overallStatus, classifyFailure, toEnrichmentDto, mapSharedSection, REQUIRED_SECTIONS, SECTION_ERROR,
} from '../service/enrichmentMetrics.js';
import { DATAFORSEO_ERROR } from '../../dataforseo-api/shared/providerErrors.js';

const organic = (over = {}) => ({ organic: { etv: 1200.5, count: 340, pos_1: 12, pos_2_3: 20, pos_4_10: 60, pos_11_20: 90, ...over }, paid: null });

describe('mapRankSection: a real value is kept, "no data" is never a zero', () => {
  test('values, including the #1 / top-3 / top-10 derived from the position buckets', () => {
    const s = mapRankSection(organic());
    assert.equal(s.status, 'ok');
    assert.deepEqual([s.data.organic_traffic, s.data.ranking_keywords, s.data.pos_1, s.data.top_3, s.data.top_10], [1200.5, 340, 12, 32, 92]);
    assert.equal(s.data.positions.pos_11_20, 90);
  });

  test('a domain the provider has no data for (organic: null) is no_data with NO values', () => {
    for (const payload of [{ organic: null, paid: null }, null, undefined, {}]) assert.deepEqual(mapRankSection(payload), { status: 'no_data', data: null });
  });

  test('a REAL zero stays zero (the provider knows the domain, it just ranks for nothing)', () => {
    const s = mapRankSection(organic({ etv: 0, count: 0, pos_1: 0, pos_2_3: 0, pos_4_10: 0 }));
    assert.equal(s.status, 'ok');
    assert.deepEqual([s.data.organic_traffic, s.data.ranking_keywords, s.data.pos_1, s.data.top_3, s.data.top_10], [0, 0, 0, 0, 0]);
  });

  test('a missing field is null, never 0, and a derived total needs every part', () => {
    const s = mapRankSection({ organic: { etv: 5, count: null, pos_1: 3 } });
    assert.equal(s.data.ranking_keywords, null);
    assert.equal(s.data.top_3, null, 'pos_2_3 missing -> top 3 unknown, not pos_1 alone');
    assert.equal(s.data.top_10, null);
    assert.equal(s.data.pos_1, 3);
  });

  test('non-numeric junk is null', () => {
    const s = mapRankSection({ organic: { etv: '12', count: NaN, pos_1: Infinity } });
    assert.deepEqual([s.data.organic_traffic, s.data.ranking_keywords, s.data.pos_1], [null, null, null]);
  });
});

describe('mapBacklinksSection: zero counts need a first_seen to be believed', () => {
  test('a domain the provider has seen: values and the DataForSEO rank', () => {
    const s = mapBacklinksSection({ backlinks: 5400, referring_domains: 310, rank: 412, first_seen: '2015-03-01 00:00:00 +00:00' });
    assert.equal(s.status, 'ok');
    assert.deepEqual([s.data.backlinks, s.data.referring_domains, s.data.dataforseo_rank], [5400, 310, 412]);
  });

  test('zero counts and no first_seen = the provider has nothing on it: no_data, not "0 backlinks"', () => {
    assert.deepEqual(mapBacklinksSection({ backlinks: 0, referring_domains: 0, rank: 0, first_seen: null }), { status: 'no_data', data: null });
    assert.deepEqual(mapBacklinksSection({ backlinks: null, referring_domains: null }), { status: 'no_data', data: null });
    assert.deepEqual(mapBacklinksSection(null), { status: 'no_data', data: null });
  });

  test('zero counts WITH a first_seen are a real zero', () => {
    const s = mapBacklinksSection({ backlinks: 0, referring_domains: 0, rank: 3, first_seen: '2024-01-01' });
    assert.equal(s.status, 'ok');
    assert.deepEqual([s.data.backlinks, s.data.referring_domains], [0, 0]);
  });

  test('the rank is a DataForSEO score only: the stored field is named so', () => {
    const s = mapBacklinksSection({ backlinks: 1, referring_domains: 1, rank: 9, first_seen: '2020-01-01' });
    assert.ok('dataforseo_rank' in s.data);
    assert.ok(!('domain_authority' in s.data) && !('domain_rating' in s.data));
  });
});

describe('overallStatus', () => {
  const ok = { status: 'ok' }; const nd = { status: 'no_data' }; const bad = { status: 'failed' };
  test('enriched only when EVERY required section (rank, backlinks, shared) has values', () => {
    assert.deepEqual(REQUIRED_SECTIONS, ['rank', 'backlinks', 'shared']);
    assert.equal(overallStatus({ rank: ok, backlinks: ok, shared: ok }), 'enriched');
  });
  test('a missing shared section can never hide behind the others: it makes the competitor partial', () => {
    assert.equal(overallStatus({ rank: ok, backlinks: ok }), 'partial');
    assert.equal(overallStatus({ rank: ok, backlinks: ok, shared: { status: 'not_configured' } }), 'partial');
    assert.equal(overallStatus({ rank: ok, backlinks: ok, shared: nd }), 'partial');
    assert.equal(overallStatus({ rank: ok, backlinks: ok, shared: bad }), 'partial');
  });
  test('values and failures -> partial; only failures -> failed; only "no data" -> no_data', () => {
    assert.equal(overallStatus({ rank: ok, backlinks: bad, shared: ok }), 'partial');
    assert.equal(overallStatus({ rank: bad, backlinks: bad, shared: bad }), 'failed');
    assert.equal(overallStatus({ rank: nd, backlinks: nd, shared: nd }), 'no_data');
    assert.equal(overallStatus({ rank: nd, backlinks: bad, shared: nd }), 'failed');
    assert.equal(overallStatus({}), 'no_data');
  });
});

describe('classifyFailure', () => {
  test('transient provider errors are retryable and count as an attempt', () => {
    for (const code of [DATAFORSEO_ERROR.RATE_LIMITED, DATAFORSEO_ERROR.TIMEOUT, DATAFORSEO_ERROR.NETWORK, DATAFORSEO_ERROR.UNAVAILABLE, DATAFORSEO_ERROR.INSUFFICIENT_CREDITS]) {
      assert.deepEqual(classifyFailure({ code }), { code, retryable: true, countsAsAttempt: true });
    }
  });
  test('a rejected request or an unconfigured provider will not get better by waiting', () => {
    assert.equal(classifyFailure({ code: DATAFORSEO_ERROR.REQUEST_REJECTED }).retryable, false);
    assert.equal(classifyFailure({ code: DATAFORSEO_ERROR.NOT_CONFIGURED }).retryable, false);
  });
  test('the project budget waits, and is not a failed attempt', () => {
    assert.deepEqual(classifyFailure({ name: 'ProviderBudgetExceeded', code: SECTION_ERROR.PROJECT_BUDGET }), { code: SECTION_ERROR.PROJECT_BUDGET, retryable: true, countsAsAttempt: false });
  });
  test('an unknown error becomes a SAFE code, never its message', () => {
    const f = classifyFailure(new Error('mongodb://user:secret@host/db exploded'));
    assert.equal(f.code, SECTION_ERROR.UNKNOWN);
    assert.ok(!JSON.stringify(f).includes('secret'));
  });
});


describe('mapSharedSection (the keywords BOTH the project and the competitor rank for)', () => {
  const kw = [{ keyword: 'a' }, { keyword: 'b' }];
  test('the count is the provider total, whatever number of keywords was stored', () => {
    const s = mapSharedSection({ sharedTotal: 45, keywords: kw }, { competitorHasData: true });
    assert.equal(s.status, 'ok');
    assert.deepEqual([s.data.shared_keywords, s.data.stored_keywords, s.data.truncated], [45, 2, true]);
    assert.equal(mapSharedSection({ sharedTotal: 2, keywords: kw }, { competitorHasData: true }).data.truncated, false);
  });
  test('no answer is never a zero', () => {
    for (const payload of [null, undefined, {}, { sharedTotal: null, keywords: [] }, { sharedTotal: 'x' }]) assert.equal(mapSharedSection(payload, { competitorHasData: true }).status, 'no_data');
    assert.equal(mapSharedSection(null).data, null);
  });
  test('zero is real only when the provider knows the competitor; otherwise it is "no data"', () => {
    const known = mapSharedSection({ sharedTotal: 0, keywords: [] }, { competitorHasData: true });
    assert.deepEqual([known.status, known.data.shared_keywords], ['ok', 0]);
    assert.equal(mapSharedSection({ sharedTotal: 0, keywords: [] }, { competitorHasData: false }).status, 'no_data');
  });
});

describe('toEnrichmentDto', () => {
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const enriched = (over = {}) => ({
    domain: 'rival.com',
    enrichment: {
      status: 'enriched', finished_at: new Date(NOW - 3600e3), last_success_at: new Date(NOW - 3600e3), attempts: 1, market: { location: 'India', language: 'English' },
      sections: {
        rank: { status: 'ok', fetched_at: new Date(NOW - 3600e3), data: mapRankSection(organic()).data },
        backlinks: { status: 'ok', fetched_at: new Date(NOW - 3600e3), data: mapBacklinksSection({ backlinks: 10, referring_domains: 4, rank: 55, first_seen: '2020-01-01' }).data },
        shared: { status: 'ok', fetched_at: new Date(NOW - 3600e3), data: mapSharedSection({ sharedTotal: 45, keywords: [{ keyword: 'eye hospital parel', search_volume: 590 }] }, { competitorHasData: true }).data },
      },
      ...over,
    },
  });

  test('metrics from the stored sections, including the shared-keyword count (the provider total, not the stored list length)', () => {
    const d = toEnrichmentDto(enriched(), { now: NOW });
    assert.deepEqual([d.status, d.stale], ['enriched', false]);
    assert.deepEqual([d.metrics.organicTraffic, d.metrics.rankingKeywords, d.metrics.top10, d.metrics.referringDomains, d.metrics.dataforseoRank], [1200.5, 340, 92, 4, 55]);
    assert.equal(d.metrics.sharedKeywords, 45);
    assert.deepEqual([d.metrics.sharedStored, d.metrics.sharedTruncated], [1, true]);
    assert.equal(d.sections.shared.status, 'ok');
  });
  test('an older record finished before the shared section existed is NOT complete, and its shared count is unknown (null, never 0)', () => {
    const old = enriched();
    old.enrichment.sections.shared = { status: 'not_configured', error_code: SECTION_ERROR.HEAD_TO_HEAD_NOT_CONFIGURED };
    const d = toEnrichmentDto(old, { now: NOW });
    assert.equal(d.status, 'partial');
    assert.equal(d.metrics.sharedKeywords, null);
    assert.equal(d.sections.shared.status, 'not_configured');
    const none = enriched(); delete none.enrichment.sections.shared;
    assert.equal(toEnrichmentDto(none, { now: NOW }).status, 'partial');
  });

  test('a section that is not ok contributes null metrics, never zero', () => {
    const e = enriched();
    e.enrichment.sections.rank = { status: 'no_data', data: null };
    e.enrichment.sections.backlinks = { status: 'failed', error_code: 'PROVIDER_TIMEOUT', data: null };
    const d = toEnrichmentDto(e, { now: NOW });
    for (const k of ['organicTraffic', 'rankingKeywords', 'pos1', 'top3', 'top10', 'backlinks', 'referringDomains', 'dataforseoRank', 'positions']) assert.equal(d.metrics[k], null, k);
    assert.equal(d.sections.backlinks.errorCode, 'PROVIDER_TIMEOUT');
  });

  test('a record with no website is no_website whatever its enrichment says; a website never queued is not_started', () => {
    assert.equal(toEnrichmentDto({ domain: null, enrichment: { status: 'pending' } }, { now: NOW }).status, 'no_website');
    assert.equal(toEnrichmentDto({ domain: 'a.com' }, { now: NOW }).status, 'not_started');
  });

  test('stale is derived from the age of the last success (not stored), only for finished data', () => {
    const old = enriched({ last_success_at: new Date(NOW - 20 * 86400e3), finished_at: new Date(NOW - 20 * 86400e3) });
    assert.equal(toEnrichmentDto(old, { now: NOW, staleAfterMs: 14 * 86400e3 }).stale, true);
    assert.equal(toEnrichmentDto(enriched(), { now: NOW, staleAfterMs: 14 * 86400e3 }).stale, false);
    const pending = enriched({ status: 'pending', next_attempt_at: new Date(NOW) });
    assert.equal(toEnrichmentDto(pending, { now: NOW }).stale, false);
    assert.ok(toEnrichmentDto(pending, { now: NOW }).nextAttemptAt);
  });
});
