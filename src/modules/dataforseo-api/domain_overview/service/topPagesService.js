import { getDomainOverviewSection } from './domainOverviewService.js';
import { getPageFlags } from '../provider/pageMetrics.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * The Top Pages page's sections, with the TRAFFIC joined on. A page row is cached for 24 hours exactly as the provider described it (plus the
 * values computed from its own numbers); the traffic per page is a SEPARATE 7-day entry (one Organic Keywords call, see buildTrafficPayload in
 * domainOverviewService.js). They are joined here, when a response is built, so that:
 *  - a traffic fetch that failed (or has not happened yet) can never be frozen into 24 hours of cached rows: the table loads, the traffic
 *    columns are null ("—"), the response says the join failed, and the next request tries again (a failure is never cached);
 *  - the table and the CSV export read the very same join.
 * A page with no match in the traffic is 0 (the keywords read do not rank it); null only when the join failed.
 */

/**
 * @returns {Promise<{ status: 'ok', byUrl: Record<string, { traffic: number, keywords: number }>, meta: object } | { status: 'failed', code: string }>}
 */
export async function loadTraffic({ project, userId }) {
  try {
    const t = await getDomainOverviewSection({ project, section: 'top-pages-traffic', userId });
    return { status: 'ok', byUrl: t.result?.byUrl ?? {}, meta: t.result?.meta ?? {} };
  } catch (err) {
    LoggerUtil.warn('Top pages: the traffic join failed; the table loads without traffic', { code: err?.code ?? 'UNKNOWN' });
    return { status: 'failed', code: String(err?.code ?? 'TRAFFIC_UNAVAILABLE') };
  }
}

/** One cached page row + the traffic -> the row the browser gets: traffic, keywords and the opportunity flags. */
export function joinTraffic(row, traffic) {
  const known = traffic?.status === 'ok';
  const hit = known ? traffic.byUrl[row.normalized_url] : null;
  const trafficValue = known ? (hit?.traffic ?? 0) : null;
  return {
    ...row,
    traffic: trafficValue,
    keywords: known ? (hit?.keywords ?? 0) : null,
    flags: getPageFlags({ statusGroup: row.status_group, backlinks: row.backlinks, referringDomains: row.referring_domains, traffic: trafficValue }),
  };
}

/** What the response says about the join, so the page can say so (and offer Retry) when it failed. */
const describeTraffic = (traffic) => (traffic.status === 'ok'
  ? { status: 'ok', rows: traffic.meta.rows ?? null, keywordsTotal: traffic.meta.keywordsTotal ?? null, truncated: Boolean(traffic.meta.truncated) }
  : { status: 'failed', code: traffic.code });

/**
 * `domain-pages` (the table) or `tp-fix-first` (the five worst error pages) with the traffic joined. `traffic` may be passed in (the export loads
 * it once for all its batches). "Fix first" lists error pages and does not need traffic: its flags are the traffic-free ones.
 */
export async function getTopPagesSection({ project, section, query, refresh = false, userId = null, traffic = null }) {
  const base = await getDomainOverviewSection({ project, section, query, refresh, userId });
  const needsTraffic = section === 'domain-pages';
  const joined = needsTraffic ? (traffic ?? await loadTraffic({ project, userId })) : { status: 'failed', code: 'NOT_NEEDED' };
  const items = (base.result?.items ?? []).map((row) => joinTraffic(row, needsTraffic ? joined : { status: 'failed' }));
  return {
    ...base,
    result: { ...base.result, items },
    ...(needsTraffic ? { traffic: describeTraffic(joined) } : {}),
  };
}
