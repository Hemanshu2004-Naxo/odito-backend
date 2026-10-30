import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest, parseSectionResponse, parseRankOverview, parseHistory, parseRankedKeyword, parseRankedKeywords, parseCompetitors, parseBacklinksSummary,
  parseBulkTraffic, parseBacklinksSummary as parseBacklinks, normalizeDomain,
} from '../provider/domainOverviewProvider.js';
import { buildHistoryRange, resolveMarket, parseRefresh, parseSection, parseMonths } from '../validator/domainOverviewValidation.js';
import { DataForSeoApiError, DATAFORSEO_ERROR, classifyProviderError } from '../../shared/providerErrors.js';
import { SECTIONS, DEFAULT_MARKET } from '../config.js';
import { parseCompetitorsQuery } from '../validator/competitorsQuery.js';
import { parseBulkTrafficQuery } from '../validator/bulkTrafficQuery.js';
import {
  envelope, organicMetrics, rankOverviewResult, historyResult, historyItem, rankedKeywordItem, richRankedKeywordItem, rankedKeywordsResult, competitorItem,
  competitorsResult, backlinksResult, bulkTrafficItem, bulkTrafficResult,
} from './fixtures.js';

const market = { location_name: 'India', language_name: 'English' };

describe('request bodies', () => {
  test('each section sends exactly the documented body', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    const ctx = { target: 'asgeyehospital.com', market, now };
    assert.deepEqual(buildRequest('rank-overview', ctx), { target: 'asgeyehospital.com', location_name: 'India', language_name: 'English' });
    assert.deepEqual(buildRequest('history', ctx), { target: 'asgeyehospital.com', location_name: 'India', language_name: 'English', date_from: '2025-10-01', date_to: '2026-10-01' });
    assert.deepEqual(buildRequest('ranked-keywords', ctx), {
      target: 'asgeyehospital.com', location_name: 'India', language_name: 'English', limit: 5, order_by: ['ranked_serp_element.serp_item.etv,desc'],
    });
    // The default view: what the dashboard card and the Competitors page both ask for.
    assert.deepEqual(buildRequest('competitors', ctx), {
      target: 'asgeyehospital.com', location_name: 'India', language_name: 'English', limit: 50, order_by: ['intersections,desc'],
      exclude_top_domains: true, max_rank_group: 100,
    });
    // The default view: what the dashboard's three cards and the Backlink Overview page both send (one shared cache entry).
    assert.deepEqual(buildRequest('backlinks', ctx), {
      target: 'asgeyehospital.com', include_subdomains: true, internal_list_limit: 20, backlinks_status_type: 'live',
    }, 'backlinks are not market-specific and carry no filter by default');
  });

  test('the history request covers the requested number of months (default 12), anchored to the current month', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    const ctx = { target: 'a.com', market, now };
    assert.deepEqual(buildRequest('history', { ...ctx, months: 24 }), { target: 'a.com', location_name: 'India', language_name: 'English', date_from: '2024-10-01', date_to: '2026-10-01' });
    assert.deepEqual(buildRequest('history', { ...ctx, months: 6 }), { target: 'a.com', location_name: 'India', language_name: 'English', date_from: '2026-04-01', date_to: '2026-10-01' });
    assert.deepEqual(buildRequest('history', ctx).date_from, '2025-10-01');
    assert.deepEqual(buildHistoryRange(new Date('2026-02-10T00:00:00Z'), 24), { date_from: '2024-02-01', date_to: '2026-02-01' });
  });

  test('?months accepts only 6, 12 or 24 (and defaults to 12) before any billed call can happen', () => {
    assert.equal(parseMonths(undefined), 12);
    assert.equal(parseMonths(''), 12);
    for (const [raw, n] of [['6', 6], ['12', 12], ['24', 24]]) assert.equal(parseMonths(raw), n);
    for (const bad of ['0', '7', '13', '36', '24.0', '-12', 'abc', '12 ', ['24'], { n: 24 }, 24]) {
      assert.throws(() => parseMonths(bad), (e) => e.field === 'months' && e.code === 'VALIDATION_ERROR', JSON.stringify(bad));
    }
  });

  test('the historical window is today minus 12 months to this month, both YYYY-MM-01 (UTC), across year boundaries', () => {
    assert.deepEqual(buildHistoryRange(new Date('2026-10-27T23:59:59Z')), { date_from: '2025-10-01', date_to: '2026-10-01' });
    assert.deepEqual(buildHistoryRange(new Date('2026-01-01T00:00:00Z')), { date_from: '2025-01-01', date_to: '2026-01-01' });
    assert.deepEqual(buildHistoryRange(new Date('2026-12-31T23:59:59Z')), { date_from: '2025-12-01', date_to: '2026-12-01' });
    assert.deepEqual(buildHistoryRange(new Date('2024-02-29T12:00:00Z')), { date_from: '2023-02-01', date_to: '2024-02-01' });
  });
});

describe('response envelope: 20000 is required at BOTH levels', () => {
  const ctx = { target: 'a-site.example.com' };

  test('a good response is reduced to the slim payload and reports its cost', () => {
    const out = parseSectionResponse('backlinks', envelope(backlinksResult(), { cost: 0.024036 }), ctx);
    assert.equal(out.payload.rank, 353);
    assert.equal(out.payload.backlinks, 18343);
    assert.equal(out.payload.referring_domains, 3965);
    assert.equal(out.payload.broken_backlinks, 1643);
    assert.equal(out.payload.info.target_spam_score, 5);
    assert.equal(out.cost, 0.024036);
  });

  test('HTTP-200 with a failed TASK is an error, not an empty success', () => {
    for (const [taskStatus, code] of [[40201, DATAFORSEO_ERROR.ACCOUNT_RESTRICTED], [40501, DATAFORSEO_ERROR.REQUEST_REJECTED], [50000, DATAFORSEO_ERROR.UNAVAILABLE]]) {
      assert.throws(() => parseSectionResponse('rank-overview', envelope(null, { taskStatus, taskMessage: 'nope' }), ctx), (e) => e instanceof DataForSeoApiError && e.code === code, String(taskStatus));
    }
  });

  test('a failed TOP-LEVEL status is an error even when the task looks fine', () => {
    assert.throws(() => parseSectionResponse('backlinks', envelope(backlinksResult(), { status: 40100 }), ctx), (e) => e.code === DATAFORSEO_ERROR.AUTH);
    assert.throws(() => parseSectionResponse('backlinks', envelope(backlinksResult(), { status: 40200 }), ctx), (e) => e.code === DATAFORSEO_ERROR.INSUFFICIENT_CREDITS);
  });

  test('malformed payloads are rejected', () => {
    for (const bad of [null, undefined, 'x', {}, { status_code: 20000 }, { status_code: 20000, tasks: [] }, { status_code: 20000, tasks: [null] }]) {
      assert.throws(() => parseSectionResponse('backlinks', bad, ctx), (e) => e.code === DATAFORSEO_ERROR.MALFORMED_RESPONSE, JSON.stringify(bad));
    }
    assert.throws(() => parseSectionResponse('backlinks', envelope('nope', { raw: true }), ctx), (e) => e.code === DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    assert.throws(() => parseSectionResponse('backlinks', envelope([7], { raw: true }), ctx), (e) => e.code === DATAFORSEO_ERROR.MALFORMED_RESPONSE);
  });

  test('"nothing found" ([] or items: null) is a real, empty result for every section', () => {
    const empty = (section, payload) => assert.deepEqual(parseSectionResponse(section, envelope([], { raw: true }), ctx).payload, payload, `${section} []`);
    empty('rank-overview', { organic: null, paid: null });
    empty('history', { items: [] });
    empty('ranked-keywords', { totalCount: null, metrics: null, items: [] });
    empty('competitors', { totalCount: null, self: null, items: [] });
    empty('bulk-traffic', { items: [] });
    const nothing = parseSectionResponse('backlinks', envelope([], { raw: true }), ctx).payload;
    assert.equal(nothing.rank, null);
    assert.equal(nothing.referring_links_tld, null);
    assert.deepEqual(nothing.info.platform_type, []);
    assert.deepEqual(parseSectionResponse('rank-overview', envelope({ total_count: 0, items_count: 0, items: null }), ctx).payload, { organic: null, paid: null });
  });
});

describe('parsers keep only what the page uses, and never turn a missing value into 0', () => {
  test('rank overview: organic and paid metrics', () => {
    const out = parseRankOverview(rankOverviewResult());
    assert.equal(out.organic.etv, 100412.4);
    assert.equal(out.organic.count, 802);
    assert.equal(out.organic.estimated_paid_traffic_cost, 24500.7);
    assert.equal(out.organic.pos_2_3, 30);
    assert.deepEqual([out.organic.is_new, out.organic.is_up, out.organic.is_down, out.organic.is_lost], [31, 120, 95, 18]);
    assert.deepEqual(out.paid, { etv: 0, count: 0, estimated_paid_traffic_cost: 0 });
    assert.equal('se_type' in out.organic, false);
  });

  test('rank overview: absent / non-numeric fields are null', () => {
    const out = parseRankOverview(rankOverviewResult({ organic: organicMetrics({ pos_1: undefined, etv: 'lots', is_lost: null }), paid: null }));
    assert.equal(out.organic.pos_1, null);
    assert.equal(out.organic.etv, null);
    assert.equal(out.organic.is_lost, null);
    assert.equal(out.paid, null);
  });

  test('history: keeps the provider order, nulls for months without metrics, drops items without a valid year/month', () => {
    const out = parseHistory(historyResult([
      historyItem(2026, 10, 110000, 810), { year: 2026, month: 9, metrics: { organic: null } }, { year: 2026, month: 13, metrics: {} }, { month: 7 }, historyItem(2026, 8, 95000, 790),
    ]));
    assert.deepEqual(out.items.map((i) => [i.year, i.month, i.etv, i.count]), [[2026, 10, 110000, 810], [2026, 9, null, null], [2026, 8, 95000, 790]]);
    // the gap month keeps its place with EVERY figure null (not a month of zeros), and no paid block
    const gap = out.items[1];
    assert.equal(Object.entries(gap).filter(([k, v]) => k !== 'year' && k !== 'month' && k !== 'paid' && v !== null).length, 0);
    assert.equal(gap.paid, null);
  });

  test('history: every monthly metric the Traffic History page needs is kept, flat, next to etv and count', () => {
    const full = { pos_1: 12, pos_2_3: 30, pos_4_10: 150, pos_11_20: 220, pos_21_30: 100, pos_31_40: 80, pos_41_50: 60, pos_51_60: 50, pos_61_70: 40, pos_71_80: 30, pos_81_90: 20, pos_91_100: 10, estimated_paid_traffic_cost: 24500.7, is_new: 31, is_up: 120, is_down: 95, is_lost: 18, ignored_field: 'x' };
    const [m] = parseHistory(historyResult([historyItem(2026, 10, 100412.4, 802, full, { etv: 55.5, count: 4, estimated_paid_traffic_cost: 9.9 })])).items;
    assert.deepEqual(m, {
      year: 2026, month: 10, etv: 100412.4, count: 802, estimated_paid_traffic_cost: 24500.7,
      pos_1: 12, pos_2_3: 30, pos_4_10: 150, pos_11_20: 220, pos_21_30: 100, pos_31_40: 80, pos_41_50: 60, pos_51_60: 50, pos_61_70: 40, pos_71_80: 30, pos_81_90: 20, pos_91_100: 10,
      is_new: 31, is_up: 120, is_down: 95, is_lost: 18,
      paid: { etv: 55.5, count: 4, estimated_paid_traffic_cost: 9.9 },
    });
    assert.equal('ignored_field' in m, false, 'fields the page does not use are dropped');
  });

  test('ranked keyword: position, previous position, NEW and unknown movement are distinguished', () => {
    const slim = parseRankedKeyword(rankedKeywordItem());
    assert.deepEqual(
      { keyword: slim.keyword, search_volume: slim.search_volume, keyword_difficulty: slim.keyword_difficulty, position: slim.position, position_absolute: slim.position_absolute, previous_position: slim.previous_position, rank_changes_known: slim.rank_changes_known, etv: slim.etv, relative_url: slim.relative_url },
      { keyword: 'lasik surgery cost', search_volume: 2900, keyword_difficulty: 42, position: 3, position_absolute: 4, previous_position: 6, rank_changes_known: true, etv: 410.2, relative_url: '/lasik-surgery-cost/' },
    );
    const isNew = parseRankedKeyword(rankedKeywordItem({ ranked_serp_element: { serp_item: { rank_group: 9, etv: 1, relative_url: '/x/', rank_changes: { previous_rank_absolute: null } } } }));
    assert.equal(isNew.rank_changes_known, true);
    assert.equal(isNew.previous_position, null); // known movement + no previous rank = NEW
    const unknown = parseRankedKeyword(rankedKeywordItem({ ranked_serp_element: { serp_item: { rank_group: 9, etv: 1 } } }));
    assert.equal(unknown.rank_changes_known, false); // no rank_changes block at all: nothing is claimed
    assert.equal(parseRankedKeyword({ keyword_data: {} }), null);
    const sparse = parseRankedKeyword({ keyword_data: { keyword: 'k' } });
    assert.deepEqual([sparse.search_volume, sparse.keyword_difficulty, sparse.position, sparse.position_absolute, sparse.etv, sparse.relative_url], [null, null, null, null, null, null]);
  });

  test('ranked keyword: the Organic Keywords fields are read from their real paths; junk is dropped, gaps stay null / empty', () => {
    const r = parseRankedKeyword(richRankedKeywordItem());
    assert.deepEqual(r, {
      keyword: 'lasik surgery cost', search_volume: 2900, keyword_difficulty: 42, position: 3, position_absolute: 4, previous_position: 6, rank_changes_known: true,
      etv: 410.2, relative_url: '/lasik-surgery-cost/', type: 'organic', is_new: false, is_up: true, is_down: false, intent: 'commercial', cpc: 1.25,
      competition_level: 'MEDIUM', low_top_of_page_bid: 0.4, high_top_of_page_bid: 1.9,
      monthly_searches: [{ year: 2026, month: 9, search_volume: 3100 }, { year: 2026, month: 8, search_volume: null }], // month 13 and a null year are dropped
      estimated_paid_traffic_cost: 512.5, url: 'https://a-site.example.com/lasik-surgery-cost/', title: 'LASIK surgery cost in India',
      serp_features: ['organic', 'people_also_ask', 'featured_snippet'], check_url: 'https://www.google.com/search?q=lasik+surgery+cost&gl=in',
      referring_domains: 12, backlinks: 80, last_updated_time: '2026-10-20 05:00:00 +00:00',
    });
    const sparse = parseRankedKeyword({ keyword_data: { keyword: 'k' } });
    assert.deepEqual([sparse.type, sparse.is_new, sparse.is_up, sparse.is_down, sparse.intent, sparse.cpc, sparse.monthly_searches, sparse.serp_features, sparse.url, sparse.referring_domains], [null, null, null, null, null, null, [], [], null, null]);
    // A provider flag is only trusted when it is a boolean: absence is "unknown", never "false".
    const odd = parseRankedKeyword(richRankedKeywordItem({ ranked_serp_element: { serp_item: { rank_group: 1, rank_changes: { is_new: 'yes' } } } }));
    assert.equal(odd.is_new, null);
  });

  test('ranked keywords result: totalCount is the filtered match count; metrics are the whole-domain organic totals (null when absent)', () => {
    const withMetrics = parseRankedKeywords({ total_count: 12, items: [], metrics: { organic: { count: 4139, etv: 9000.5, pos_1: 50, pos_2_3: 60, pos_4_10: 70, is_new: 2788, is_up: 100, is_down: 90, pos_11_20: 5, extra: 1 } } });
    assert.deepEqual(withMetrics.metrics, { count: 4139, etv: 9000.5, pos_1: 50, pos_2_3: 60, pos_4_10: 70, is_new: 2788, is_up: 100, is_down: 90 });
    assert.equal(withMetrics.totalCount, 12);
    assert.equal(parseRankedKeywords({ total_count: 3, items: [] }).metrics, null);
  });

  test('ranked keywords result: a filter that matches nothing (live shape: total_count null, items null, metrics null) is 0 matches', () => {
    assert.deepEqual(
      parseRankedKeywords({ se_type: 'google', target: 'a.com', total_count: null, items_count: 0, metrics: null, metrics_absolute: null, items: null }),
      { totalCount: 0, metrics: null, items: [] },
    );
    assert.equal(parseRankedKeywords(null).totalCount, null, 'no result object at all stays unknown');
  });

  test('ranked-keywords request: a canonical query adds offset / order / filters; no query is the dashboard top-5 call', () => {
    const body = buildRequest('ranked-keywords', {
      target: 'a.com', market,
      query: { limit: 50, offset: 100, orderBy: 'keyword_data.keyword,asc', filters: [['keyword_data.keyword', 'like', '%eye%']] },
    });
    assert.deepEqual(body, {
      target: 'a.com', location_name: 'India', language_name: 'English', limit: 50, offset: 100, order_by: ['keyword_data.keyword,asc'],
      filters: ['keyword_data.keyword', 'like', '%eye%'],
    });
    const two = buildRequest('ranked-keywords', {
      target: 'a.com', market,
      query: { limit: 25, offset: 0, orderBy: 'ranked_serp_element.serp_item.etv,desc', filters: [['a', '>=', 1], ['b', '<=', 5]] },
    });
    assert.deepEqual(two.filters, [['a', '>=', 1], 'and', ['b', '<=', 5]]);
    assert.equal('offset' in two, false, 'offset 0 is not sent');
    const plain = buildRequest('ranked-keywords', { target: 'a.com', market });
    assert.deepEqual(Object.keys(plain), ['target', 'location_name', 'language_name', 'limit', 'order_by']);
  });

  test('backlinks summary reads rank, backlinks, referring domains, broken backlinks and info.target_spam_score', () => {
    const p = parseBacklinksSummary(backlinksResult());
    assert.deepEqual([p.rank, p.backlinks, p.referring_domains, p.broken_backlinks, p.info.target_spam_score], [353, 18343, 3965, 1643, 5]);
    assert.equal(parseBacklinksSummary(backlinksResult({ info: undefined })).info.target_spam_score, null);
  });
});

describe('competitors: request body', () => {
  const ctx = { target: 'asgeyehospital.com', market };
  const body = (q, excludeDomains) => buildRequest('competitors', { ...ctx, query: parseCompetitorsQuery(q), excludeDomains });

  test('every choice the page makes reaches the provider: page, sort, filter, both toggles and the project exclude list', () => {
    assert.deepEqual(body({
      limit: '25', offset: '50', order_by: 'competitor_metrics.organic.etv,desc', exclude_top_domains: '0', max_rank_group: '10',
      filters: JSON.stringify(['intersections', '>=', 200]),
    }, ['practo.com', 'justdial.com']), {
      target: 'asgeyehospital.com', location_name: 'India', language_name: 'English', limit: 25, offset: 50,
      order_by: ['competitor_metrics.organic.etv,desc'], filters: ['intersections', '>=', 200],
      exclude_top_domains: false, exclude_domains: ['practo.com', 'justdial.com'], max_rank_group: 10,
    });
  });

  test('several conditions are "and"-joined; an empty exclude list sends no exclude_domains; offset 0 is not sent', () => {
    const b = body({ filters: JSON.stringify([['intersections', '>=', 200], 'and', ['avg_position', '<=', 40]]) }, []);
    assert.deepEqual(b.filters, [['avg_position', '<=', 40], 'and', ['intersections', '>=', 200]]);
    assert.equal('exclude_domains' in b, false);
    assert.equal('offset' in b, false);
  });
});

describe('competitors: the project row is taken out, and the API\'s confusing names are translated in ONE place', () => {
  const target = 'asgeyehospital.com';
  const selfRow = competitorItem('asgeyehospital.com', {
    intersections: 4139, avg_position: 22.3,
    full_domain_metrics: { organic: { count: 4139, etv: 100411.9, estimated_paid_traffic_cost: 24520.3 } },
    metrics: { organic: { etv: 100411.9, pos_1: 165, pos_2_3: 308, pos_4_10: 1037 } },
    competitor_metrics: { organic: { etv: 100411.9, pos_1: 165, pos_2_3: 308, pos_4_10: 1037 } },
  });

  test('removes the target (the API returns the site as a row), including www and case, and hands it back as self', () => {
    const out = parseCompetitors(competitorsResult([selfRow, competitorItem('WWW.AsgEyeHospital.com'), competitorItem('rival-one.com')], 18778), { target });
    assert.deepEqual(out.items.map((i) => i.domain), ['rival-one.com']);
    assert.equal(out.self.domain, 'asgeyehospital.com');
    assert.equal(out.self.total.count, 4139);
    assert.equal(out.self.total.etv, 100411.9);
    assert.equal(out.totalCount, 18778, "the provider's own total_count (it counts the project row too)");
  });

  test('metrics = the PROJECT, competitor_metrics = the COMPETITOR, full_domain_metrics = the competitor\'s whole site (real dragarwal.com row)', () => {
    const [row] = parseCompetitors(competitorsResult([selfRow, competitorItem('dragarwal.com')]), { target }).items;
    assert.deepEqual(row, {
      domain: 'dragarwal.com', intersections: 2423, avg_position: 12.786628146925299,
      total: { count: 10222, etv: 328637.028294719, estimated_paid_traffic_cost: 138179.48659965894 },
      project_shared: { etv: 26007.879283742077, pos_1: 32, pos_2_3: 151, pos_4_10: 643 },
      competitor_shared: { etv: 36882.67061826761, pos_1: 213, pos_2_3: 346, pos_4_10: 904 },
    });
  });

  test('keeps every other row in the provider\'s order (nothing is removed client-side any more: the provider excludes sites)', () => {
    const items = ['youtube.com', 'practo.com', 'x.com', 'rival.in'].map((d) => competitorItem(d));
    assert.deepEqual(parseCompetitors(competitorsResult([selfRow, ...items]), { target }).items.map((i) => i.domain), ['youtube.com', 'practo.com', 'x.com', 'rival.in']);
  });

  test('missing metrics are null (never 0); rows without a domain are skipped; nothing found is an empty page, not unknown', () => {
    const out = parseCompetitors(competitorsResult([{ intersections: 3 }, { domain: 'solo.com' }]), { target });
    assert.deepEqual(out.items, [{ domain: 'solo.com', intersections: null, avg_position: null, total: null, project_shared: null, competitor_shared: null }]);
    const none = parseCompetitors({ total_count: null, items: null }, { target });
    assert.deepEqual(none, { totalCount: 0, self: null, items: [] });
    assert.deepEqual(parseCompetitors(null, { target }), { totalCount: null, self: null, items: [] });
  });

  test('a row with only part of a block gives null for the rest of that block', () => {
    const [row] = parseCompetitors(competitorsResult([competitorItem('a.com', { competitor_metrics: { organic: { etv: 5 } } })]), { target }).items;
    assert.deepEqual(row.competitor_shared, { etv: 5, pos_1: null, pos_2_3: null, pos_4_10: null });
  });

  test('normalizeDomain', () => {
    assert.equal(normalizeDomain(' WWW.Example.COM. '), 'example.com');
  });
});

describe('bulk traffic (Compare section, API 5)', () => {
  const target = 'asgeyehospital.com';
  const market2 = { location_name: 'India', language_name: 'English' };

  test('the request names the project first, then the competitors, with all four item types', () => {
    const query = parseBulkTrafficQuery({ targets: 'https://www.Dragarwal.com/x/, centreforsight.net' }, target);
    assert.deepEqual(buildRequest('bulk-traffic', { target, market: market2, query }), {
      targets: ['asgeyehospital.com', 'centreforsight.net', 'dragarwal.com'],
      location_name: 'India', language_name: 'English', item_types: ['organic', 'paid', 'featured_snippet', 'local_pack'],
    });
  });

  test('targets are cleaned, de-duplicated, never include the project twice, and are capped before any billed call', () => {
    const q = parseBulkTrafficQuery({ targets: 'A.com,a.com,www.a.com,asgeyehospital.com,b.com' }, target);
    assert.deepEqual(q.targets, ['asgeyehospital.com', 'a.com', 'b.com']);
    const same = parseBulkTrafficQuery({ targets: 'b.com,a.com' }, target);
    assert.equal(same.variant, parseBulkTrafficQuery({ targets: 'A.com, B.com' }, target).variant, 'order and case do not change the cache key');
    assert.equal(same.variant, q.variant, 'the same set of domains is the same cache key');
    assert.notEqual(same.variant, parseBulkTrafficQuery({ targets: 'a.com,c.com' }, target).variant, 'a different set is a different key');
    const bad = (targets) => assert.throws(() => parseBulkTrafficQuery({ targets }, target), (e) => e.field === 'targets', String(targets));
    for (const t of [undefined, '', ',,', 'asgeyehospital.com', 'localhost', '10.0.0.1', 'javascript:alert(1)', 'not a domain', ['a.com'], Array.from({ length: 11 }, (_, i) => `d${i}.com`).join(',')]) bad(t);
    assert.equal(parseBulkTrafficQuery({ targets: Array.from({ length: 10 }, (_, i) => `d${i}.com`).join(',') }, target).targets.length, 11);
  });

  test('the response is read per target (the provider answers in a different order) with each of the four metrics, null when absent', () => {
    const result = bulkTrafficResult([
      bulkTrafficItem('dragarwal.com', { organic: { etv: 328637.03, count: 10222 }, local_pack: null }),
      bulkTrafficItem('Asgeyehospital.com'),
      { target: 'odd.com', metrics: null },
      { metrics: {} },
    ]);
    const out = parseSectionResponse('bulk-traffic', envelope(result), { target }).payload;
    assert.deepEqual(out.items.map((i) => i.target), ['dragarwal.com', 'asgeyehospital.com', 'odd.com']);
    assert.deepEqual(out.items[0], {
      target: 'dragarwal.com', organic: { etv: 328637.03, count: 10222 }, paid: { etv: 0, count: 0 }, featured_snippet: { etv: 0, count: 0 }, local_pack: null,
    });
    assert.deepEqual(out.items[1].local_pack, { etv: 32993.009464502335, count: 130 });
    assert.deepEqual(out.items[2], { target: 'odd.com', organic: null, paid: null, featured_snippet: null, local_pack: null });
    assert.deepEqual(parseBulkTraffic(null), { items: [] });
  });
});

describe('market and input handling', () => {
  test('country / language come from the project, with defaults field by field', () => {
    assert.deepEqual(resolveMarket({ country: 'IN', language: 'en' }), { location_name: 'India', language_name: 'English' });
    assert.deepEqual(resolveMarket({ country: 'us', language: 'EN' }), { location_name: 'United States', language_name: 'English' });
    assert.deepEqual(resolveMarket({ country: 'GB', language: 'hi' }), { location_name: 'United Kingdom', language_name: 'Hindi' });
    assert.deepEqual(resolveMarket({ country: 'TR', language: 'en-GB' }), { location_name: 'Turkey', language_name: 'English' });
    assert.deepEqual(resolveMarket({ country: 'IN', language: 'zh' }), { location_name: 'India', language_name: 'Chinese (Simplified)' });
  });

  test('missing or junk values fall back to India / English instead of being sent', () => {
    for (const project of [undefined, null, {}, { country: null, language: null }, { country: 'XX1', language: '??' }, { country: 'ZZ', language: '' }, { country: 42, language: {} }]) {
      assert.deepEqual(resolveMarket(project), { ...DEFAULT_MARKET }, JSON.stringify(project));
    }
    assert.deepEqual(resolveMarket({ country: 'IN' }), { location_name: 'India', language_name: 'English' });
  });

  test('section and refresh parameters are validated', () => {
    assert.equal(parseSection('history'), 'history');
    for (const bad of ['', 'overview', 'HISTORY', undefined, ['history'], '../x']) assert.throws(() => parseSection(bad), (e) => e.code === 'UNKNOWN_SECTION', String(bad));
    for (const off of [undefined, '', '0', 'false']) assert.equal(parseRefresh(off), false);
    for (const on of ['1', 'true']) assert.equal(parseRefresh(on), true);
    for (const bad of ['yes', '2', ['1'], { a: 1 }]) assert.throws(() => parseRefresh(bad), (e) => e.field === 'refresh');
  });

  test('cache lifetimes: history 7 days, everything else 24 hours', () => {
    const hours = (s) => SECTIONS[s].ttlMs / 3_600_000;
    assert.equal(hours('history'), 168);
    for (const s of ['rank-overview', 'ranked-keywords', 'competitors', 'backlinks']) assert.equal(hours(s), 24, s);
  });

  test('provider failures are classified into codes only', () => {
    assert.equal(classifyProviderError({ response: { status: 429 } }).code, DATAFORSEO_ERROR.RATE_LIMITED);
    assert.equal(classifyProviderError({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' }).code, DATAFORSEO_ERROR.TIMEOUT);
    assert.equal(classifyProviderError({ taskStatusCode: 40501, message: "Invalid Field: 'location_name'." }).code, DATAFORSEO_ERROR.REQUEST_REJECTED);
  });
});
