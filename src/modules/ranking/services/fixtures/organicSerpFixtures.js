/**
 * DataForSEO Google Organic Live Advanced response fixtures (serp/google/organic/live/advanced), shaped like the
 * documented response: envelope -> tasks[0] (status, cost, data, result_count) -> result[0] (item_types, items_count,
 * items[]). Used by the partial-results tests. The 40106 shape (a task that still carries `result`) follows the
 * DataForSEO documentation for "partial results"; it has not yet been captured from a live response.
 */

const TASK_MESSAGES = {
  20000: 'Ok.',
  40101: 'Internal SE Server Error.',
  40102: 'No Search Results.',
  40103: 'Task execution failed, please try to resubmit the task.',
  40106: 'Task completed with partial results. Some pages could not be retrieved after several retry attempts. You have not been charged for the pages that were not returned.',
};

let seq = 0;
const taskId = () => `11031208-2891-0139-0000-${String(++seq).padStart(12, '0')}`;

export function organicItem(rank, domain, path = `/p${rank}`) {
  return {
    type: 'organic', rank_group: rank, rank_absolute: rank + 1, page: Math.ceil(rank / 10), domain,
    title: `Result ${rank}`, url: `https://${domain}${path}`, breadcrumb: `https://${domain}`, is_featured_snippet: false,
  };
}

/** `count` organic items ranked 1..count from filler domains, with the given overrides { rank: domain|item }. */
export function organicItems(count, overrides = {}) {
  const out = [];
  for (let r = 1; r <= count; r++) {
    const o = overrides[r];
    out.push(o && typeof o === 'object' ? o : organicItem(r, o || `competitor${r}.example`));
  }
  return out;
}

export const localPack = (rank, domain) => ({
  type: 'local_pack', rank_group: 1, rank_absolute: rank, title: 'Places',
  items: [{ type: 'local_pack_element', rank_group: 1, rank_absolute: 1, title: 'Biz', domain, url: `https://${domain}/` }],
});
export const mapsSearch = (rank, domain) => ({ type: 'maps_search', rank_group: rank, rank_absolute: rank, title: 'Clinic', domain, url: `https://${domain}/` });
export const peopleAlsoAsk = (rank) => ({ type: 'people_also_ask', rank_group: 1, rank_absolute: rank, items: [] });
export const aiOverview = (rank) => ({ type: 'ai_overview', rank_group: 1, rank_absolute: rank, items: [] });

/** One axios response for one task. `items` null -> result: null (as DataForSEO sends for failed tasks). */
export function serpResponse({ code = 20000, items = [], device = 'desktop', keyword = 'an asg eye center near me', depth = 100, cost } = {}) {
  const hasResult = Array.isArray(items);
  const ok = code === 20000 || code === 40106 || code === 40102;
  return {
    status: 200,
    data: {
      version: '0.1.20251001', status_code: 20000, status_message: 'Ok.', time: '14.5 sec.',
      cost: cost ?? (ok ? 0.006 : 0), tasks_count: 1, tasks_error: code === 20000 ? 0 : 1,
      tasks: [{
        id: taskId(), status_code: code, status_message: TASK_MESSAGES[code] ?? 'Unknown.', time: '14.5 sec.',
        cost: cost ?? (ok ? 0.006 : 0), result_count: hasResult ? 1 : 0,
        path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
        data: { api: 'serp', function: 'live', se: 'google', se_type: 'organic', keyword, location_code: 1007785, language_code: 'en', device, os: device === 'mobile' ? 'android' : 'windows', depth },
        result: hasResult ? [{
          keyword, type: 'organic', se_domain: 'google.co.in', location_code: 1007785, language_code: 'en',
          check_url: 'https://www.google.co.in/search?q=x', datetime: '2026-11-03 12:08:30 +00:00', spell: null,
          item_types: [...new Set(items.map(i => i.type))], se_results_count: 1_230_000, items_count: items.length, items,
        }] : null,
      }],
    },
  };
}
