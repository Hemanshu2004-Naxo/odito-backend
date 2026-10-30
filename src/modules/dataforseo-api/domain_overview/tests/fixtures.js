import { REAL_BACKLINKS_LIVE } from './realBacklinks.js';
/**
 * DataForSEO-shaped payloads for tests (shapes per the v3 docs; the backlinks summary mirrors a real response for
 * asgeyehospital.com). Values are invented test data, never real results; no test in this module calls the real provider.
 */

/** { status_code, tasks: [{ status_code, cost, result }] } — `result` is wrapped in the array the API returns. */
export function envelope(result, { cost = 0.0136, status = 20000, taskStatus = 20000, taskMessage = 'Ok.', raw = false } = {}) {
  return {
    version: '0.1.20261022',
    status_code: status,
    status_message: status === 20000 ? 'Ok.' : 'Error.',
    cost,
    tasks_count: 1,
    tasks_error: taskStatus === 20000 ? 0 : 1,
    tasks: [{
      id: 'test-task',
      status_code: taskStatus,
      status_message: taskMessage,
      cost,
      result_count: 1,
      // `raw: true` sends `result` exactly as given (e.g. [] or a non-array) to test malformed / empty responses.
      result: taskStatus === 20000 ? (raw ? result : [result]) : null,
    }],
  };
}

export const organicMetrics = (o = {}) => ({
  pos_1: 12, pos_2_3: 30, pos_4_10: 150, pos_11_20: 220, pos_21_30: 100, pos_31_40: 80, pos_41_50: 60, pos_51_60: 50, pos_61_70: 40,
  pos_71_80: 30, pos_81_90: 20, pos_91_100: 10, etv: 100412.4, count: 802, estimated_paid_traffic_cost: 24500.7,
  is_new: 31, is_up: 120, is_down: 95, is_lost: 18,
  ...o,
});

export const rankOverviewResult = ({ organic = organicMetrics(), paid = { etv: 0, count: 0, estimated_paid_traffic_cost: 0 } } = {}) => ({
  se_type: 'google', target: 'a-site.example.com', location_code: 2356, language_code: 'en', total_count: 1, items_count: 1,
  items: [{ se_type: 'google', metrics: { organic, paid } }],
});

/** `extra` adds organic metrics (pos_*, is_*, estimated_paid_traffic_cost); `paid` replaces the (zero) paid metrics. */
export const historyItem = (year, month, etv, count, extra = {}, paid = { etv: 0, count: 0, estimated_paid_traffic_cost: 0 }) => ({ se_type: 'google', year, month, metrics: { organic: { etv, count, ...extra }, paid } });

/** Newest first, like the provider. */
export const historyResult = (items = [historyItem(2026, 10, 110000, 810), historyItem(2026, 9, 100000, 800), historyItem(2026, 8, 95000, 790)]) => ({
  target: 'a-site.example.com', total_count: items.length, items_count: items.length, items,
});

export const rankedKeywordItem = (o = {}) => ({
  keyword_data: {
    keyword: 'lasik surgery cost',
    keyword_info: { search_volume: 2900 },
    keyword_properties: { keyword_difficulty: 42 },
  },
  ranked_serp_element: {
    serp_item: {
      type: 'organic', rank_group: 3, rank_absolute: 4, etv: 410.2, relative_url: '/lasik-surgery-cost/',
      rank_changes: { previous_rank_absolute: 6, is_new: false, is_up: true, is_down: false },
    },
  },
  ...o,
});

/** A row with every field the Organic Keywords page reads, in the provider's real nesting, plus noise that must be ignored. */
export const richRankedKeywordItem = (o = {}) => ({
  keyword_data: {
    keyword: 'lasik surgery cost',
    keyword_info: {
      search_volume: 2900, cpc: 1.25, competition_level: 'MEDIUM', low_top_of_page_bid: 0.4, high_top_of_page_bid: 1.9,
      monthly_searches: [{ year: 2026, month: 9, search_volume: 3100 }, { year: 2026, month: 8, search_volume: null }, { year: 2026, month: 13, search_volume: 5 }, { year: null, month: 1, search_volume: 7 }],
      ignored_field: 'x',
    },
    keyword_properties: { keyword_difficulty: 42 },
    search_intent_info: { main_intent: 'commercial', foreign_intent: ['informational'] },
    serp_info: { check_url: 'https://www.google.com/search?q=lasik+surgery+cost&gl=in', serp_item_types: ['organic', 'people_also_ask', '', 7, 'featured_snippet'] },
  },
  ranked_serp_element: {
    last_updated_time: '2026-10-20 05:00:00 +00:00',
    serp_item: {
      type: 'organic', rank_group: 3, rank_absolute: 4, etv: 410.2, estimated_paid_traffic_cost: 512.5,
      url: 'https://a-site.example.com/lasik-surgery-cost/', relative_url: '/lasik-surgery-cost/', title: 'LASIK surgery cost in India',
      backlinks_info: { referring_domains: 12, backlinks: 80, ignored: 1 },
      rank_changes: { previous_rank_absolute: 6, is_new: false, is_up: true, is_down: false },
    },
  },
  ...o,
});

export const rankedKeywordsResult = (items = [rankedKeywordItem()], totalCount = 802, organic) => ({
  target: 'a-site.example.com', total_count: totalCount, items_count: items.length, items,
  ...(organic ? { metrics: { organic } } : {}),
});

/**
 * A competitors_domain row in the provider's real nesting. Defaults are the REAL numbers returned for dragarwal.com against
 * asgeyehospital.com (live check 2026-10-27): `metrics` = the PROJECT's numbers on the shared keywords, `competitor_metrics` = the
 * COMPETITOR's, `full_domain_metrics` = the competitor's whole site. Noise the parser must ignore is included.
 */
export const competitorItem = (domain, o = {}) => ({
  se_type: 'google', domain, avg_position: 12.786628146925299, sum_position: 30983, intersections: 2423,
  full_domain_metrics: {
    organic: { count: 10222, etv: 328637.028294719, estimated_paid_traffic_cost: 138179.48659965894, pos_1: 900, is_new: 5, clickstream_etv: null },
    paid: { count: 0, etv: 0 }, local_pack: null, featured_snippet: null,
  },
  metrics: { organic: { etv: 26007.879283742077, pos_1: 32, pos_2_3: 151, pos_4_10: 643, pos_11_20: 700, count: 2423 }, paid: { etv: 0 } },
  competitor_metrics: { organic: { etv: 36882.67061826761, pos_1: 213, pos_2_3: 346, pos_4_10: 904, pos_11_20: 500, count: 2423 }, paid: { etv: 0 } },
  ...o,
});

export const competitorsResult = (items, totalCount) => ({
  target: 'a-site.example.com', total_count: totalCount ?? items?.length ?? 0, items_count: items?.length ?? 0, items: items ?? null,
});

/** One bulk_traffic_estimation row: real values for asgeyehospital.com (live check 2026-10-27). Any metric can be passed as null. */
export const bulkTrafficItem = (target, o = {}) => ({
  se_type: 'google', target,
  metrics: {
    organic: { pos_1: 165, etv: 100411.929526025, count: 4139, estimated_paid_traffic_cost: 24520.31 },
    paid: { etv: 0, count: 0 },
    local_pack: { etv: 32993.009464502335, count: 130 },
    featured_snippet: { etv: 0, count: 0 },
    ...o,
  },
});

export const bulkTrafficResult = (items) => ({ se_type: 'google', location_code: 2356, language_code: 'en', total_count: items.length, items_count: items.length, items });

/** The real API 6 response for asgeyehospital.com (live, 20 entries per breakdown), plus overrides. See realBacklinks.js. */
export const backlinksResult = (o = {}) => ({ ...REAL_BACKLINKS_LIVE, ...o });
