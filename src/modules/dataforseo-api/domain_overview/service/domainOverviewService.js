import { getOrFetch, getCachedOnly } from '../../shared/apiCache.js';
import { normalizeTargetDomain, ValidationFailure } from '../../shared/targetDomain.js';
import { windowStartDay } from '../../shared/dates.js';
import { DataForSeoApiError, hasCredentials, DATAFORSEO_ERROR } from '../../shared/providerErrors.js';
import { fetchSection } from '../provider/domainOverviewProvider.js';
import { buildHistoryRange, resolveMarket } from '../validator/domainOverviewValidation.js';
import { parseRankedKeywordsQuery } from '../validator/rankedKeywordsQuery.js';
import { parseCompetitorsQuery, withExcludedList } from '../validator/competitorsQuery.js';
import { parseBacklinksQuery } from '../validator/backlinksQuery.js';
import { parseBacklinksListQuery } from '../validator/backlinksListQuery.js';
import { parseAnchorsQuery } from '../validator/anchorsQuery.js';
import { parseReferringDomainsQuery } from '../validator/referringDomainsQuery.js';
import { parseDomainPagesQuery } from '../validator/domainPagesQuery.js';
import { buildTrafficByUrl } from '../provider/pageMetrics.js';
import { takeProviderCalls } from './providerBudget.js';
import { getExcludedCompetitors } from './competitorSettingsService.js';
import {
  SECTIONS, HISTORY_MONTHS, ANCHORS_QUERY, ANCHOR_PROFILE, REFERRING_DOMAINS_QUERY, RANK_BUCKETS, RD_COUNT_BUDGET, TOXIC_SPAM_ABOVE,
  DOMAIN_PAGES_QUERY, TOP_PAGES_FIX_FIRST, TOP_PAGES_TRAFFIC, TP_PROFILE_BUDGET, RD_LAST_30, PEEKABLE_SECTIONS,
} from '../config.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * One Domain Overview section for a project: from the cache when it is fresh, otherwise one billed provider call whose
 * (slimmed) response is cached. The target and the market come from the project, never from the request.
 */
export async function getDomainOverviewSection({ project, section, refresh = false, peek = false, months, query, userId = null, now = new Date() }) {
  if (peek && (refresh || !PEEKABLE_SECTIONS.includes(section))) {
    throw new ValidationFailure('peek', refresh ? 'peek cannot be combined with refresh' : `peek applies to ${PEEKABLE_SECTIONS.join(', ')} only`);
  }
  const target = normalizeTargetDomain(project.main_url);
  const market = resolveMarket(project);
  const config = SECTIONS[section];
  // Backlink data is about the domain, not a market: the three backlinks-family sections that never took one stay market-free.
  const marketSpecific = !['backlinks', 'anchors', 'anchor-profile', 'referring-domains', 'rd-rank-buckets', 'rd-toxic-count', 'rd-last-30', 'domain-pages', 'tp-counts', 'tp-fix-first'].includes(section);
  // The historical window is anchored to the current month and sized by `months`, so BOTH dates are part of the key: a new month
  // must not be served the old window, and a 24-month response must never be handed to a 12-month request (or the reverse).
  const range = section === 'history' ? buildHistoryRange(now, months) : null;
  // Ranked keywords: the page of rows depends on limit / offset / order / filters, so all four are part of the key (`query` is the
  // validator's canonical form; absent = the dashboard's top-5 call, which gets the same key as an explicit default query).
  const rankedQuery = section === 'ranked-keywords' ? (query ?? parseRankedKeywordsQuery({})) : null;
  // Competitors: the same idea, plus the project's own exclude list (read here from the project, never from the request). It is part of
  // the provider's question, so it is part of the key: changing the list can never be answered from the old list's entry. The default
  // view (no `query`) is exactly what the Competitors page asks first, so the dashboard card and the page share one entry.
  const competitorsQuery = section === 'competitors' ? (query ?? parseCompetitorsQuery({})) : null;
  const excludeDomains = competitorsQuery ? await getExcludedCompetitors(project._id) : [];
  // Bulk traffic: `query` = { targets (the project first), variant } from the validator; there is no default (it always has targets).
  const bulkQuery = section === 'bulk-traffic' ? query : null;
  // Backlinks: status (live / lost / all) and the dofollow filter. No parameters = the default view the dashboard's cards and the
  // Backlink Overview page both ask for, so they share one entry.
  // Backlinks list (the Backlinks page): status, mode, page / token, sort and filters, all in the validator's canonical form.
  const listQuery = section === 'backlinks-list' ? (query ?? parseBacklinksListQuery({})) : null;
  const backlinksQuery = section === 'backlinks' ? (query ?? parseBacklinksQuery({})) : null;
  // Anchors (the Anchors page): status / page / sort / filters in the validator's canonical form. The profile is ONE fixed request (7 days):
  // its key carries the request's own parameters, so changing them in config can never be answered from an old entry.
  const anchorsQuery = section === 'anchors' ? (query ?? parseAnchorsQuery({})) : null;
  const profileVariant = section === 'anchor-profile' ? `${ANCHOR_PROFILE.status}|l${ANCHOR_PROFILE.limit}|${ANCHOR_PROFILE.orderBy}|i${ANCHOR_PROFILE.internalListLimit}` : null;
  // Referring domains (the Referring Domains page): status, dofollow (the request's backlinks_filters), page, sort and filters. The two count
  // cards are PROFILE-LEVEL — fixed requests (live links, no filters, no dofollow): their key carries the request's own parameters, so a
  // change in config can never be answered from an old entry, and nothing the user toggles on the page can touch them.
  const rdQuery = section === 'referring-domains' ? (query ?? parseReferringDomainsQuery({})) : null;
  const rdCountVariant = section === 'rd-rank-buckets'
    ? `live|buckets:${RANK_BUCKETS.map((b) => b.key).join(',')}|i1`
    : section === 'rd-toxic-count' ? `live|spam>${TOXIC_SPAM_ABOVE}|i1`
      // The window starts on a Monday, so the key (and its 7-day entry) is the same all week.
      : section === 'rd-last-30' ? `new+lost|since${windowStartDay(now, RD_LAST_30.days)}|i1` : null;
  // Top pages (the Top Pages page): the table is the validator's canonical form (24 h). The headline counts, the "Fix first" list and the traffic per
  // page are PROFILE-LEVEL fixed requests (7 days), keyed by their own parameters; only the traffic is market-specific (it is Organic Keywords data).
  const dpQuery = section === 'domain-pages' ? (query ?? parseDomainPagesQuery({})) : null;
  const tpVariant = section === 'tp-counts'
    ? 'live|bl>=1|pages,errors,redirects|i1'
    : section === 'tp-fix-first' ? `live|status>=400|bl>=1|l${TOP_PAGES_FIX_FIRST.limit}|${TOP_PAGES_FIX_FIRST.orderBy}|i${DOMAIN_PAGES_QUERY.internalListLimit}`
      : section === 'top-pages-traffic' ? `etv|l${TOP_PAGES_TRAFFIC.limit}|v1` : null;
  const tpCalls = { 'tp-counts': 3, 'tp-fix-first': 1, 'top-pages-traffic': 1 }[section] ?? 0;
  let variant = '';
  if (range) variant = `${range.date_from}..${range.date_to}`;
  else if (competitorsQuery) variant = withExcludedList(competitorsQuery.variant, excludeDomains);
  else variant = rankedQuery?.variant ?? bulkQuery?.variant ?? backlinksQuery?.variant ?? listQuery?.variant ?? anchorsQuery?.variant ?? profileVariant ?? rdQuery?.variant ?? rdCountVariant ?? dpQuery?.variant ?? tpVariant ?? '';

  const cacheArgs = { endpoint: config.endpoint, target, location: marketSpecific ? market.location_name : '', language: marketSpecific ? market.language_name : '', variant };
  // A peek is answered from the cache alone: no credentials needed, no provider call, no budget used. A miss says so (`result: null`).
  const peeked = peek ? await getCachedOnly(cacheArgs) : null;
  if (!peek && !hasCredentials()) throw new DataForSeoApiError(DATAFORSEO_ERROR.NOT_CONFIGURED);

  const result = peek ? (peeked ?? { payload: null, fetchedAt: null, cached: false, refreshThrottled: false }) : await getOrFetch({
    endpoint: config.endpoint,
    target,
    location: marketSpecific ? market.location_name : '',
    language: marketSpecific ? market.language_name : '',
    variant,
    ttlMs: config.ttlMs,
    refresh,
    fetcher: async () => {
      // Only a REAL call is counted against the user's budget (this function does not run on a cache hit).
      if (rdCountVariant) takeProviderCalls(userId, section === 'rd-rank-buckets' ? RANK_BUCKETS.length : section === 'rd-last-30' ? 2 : 1, { bucket: 'rd-counts', ...RD_COUNT_BUDGET });
      if (tpCalls) takeProviderCalls(userId, tpCalls, { bucket: 'tp-profile', ...TP_PROFILE_BUDGET });
      if (section === 'top-pages-traffic') return buildTrafficPayload({ project, userId, target });
      try {
        const out = await fetchSection(section, { target, market, now, months, query: rankedQuery ?? competitorsQuery ?? bulkQuery ?? backlinksQuery ?? listQuery ?? anchorsQuery ?? rdQuery ?? dpQuery, excludeDomains });
        LoggerUtil.info('Domain overview: provider call completed', { section, target, cost: out.cost });
        return out;
      } catch (err) {
        LoggerUtil.warn('Domain overview: provider call failed', {
          section, target, code: err.code, httpStatus: err.httpStatus ?? null, providerCode: err.providerCode ?? null,
        });
        throw err;
      }
    },
  });

  return {
    section,
    target,
    market: { location: market.location_name, language: market.language_name },
    fetchedAt: result.fetchedAt ? result.fetchedAt.toISOString() : null,
    cached: result.cached,
    ...(peek ? { peek: true } : {}),
    refreshThrottled: result.refreshThrottled,
    ttlSeconds: Math.round(config.ttlMs / 1000),
    // The window the history covers, so the page knows exactly how much data it was handed (history only).
    ...(range ? { range: { ...range, months: months ?? HISTORY_MONTHS } } : {}),
    // The page of ranked keywords this response is, as validated (echoed so the browser can check it against what it asked for).
    ...(rankedQuery ? { query: { limit: rankedQuery.limit, offset: rankedQuery.offset, order_by: rankedQuery.orderBy } } : {}),
    // The same for competitors (+ the toggles and how many domains the project excludes), and the domains compared for bulk traffic.
    ...(competitorsQuery ? {
      query: {
        limit: competitorsQuery.limit, offset: competitorsQuery.offset, order_by: competitorsQuery.orderBy,
        exclude_top_domains: competitorsQuery.excludeTopDomains, max_rank_group: competitorsQuery.maxRankGroup, excluded_count: excludeDomains.length,
      },
    } : {}),
    ...(bulkQuery ? { query: { targets: bulkQuery.targets } } : {}),
    ...(listQuery ? { query: { status: listQuery.status, mode: listQuery.mode, limit: listQuery.limit, offset: listQuery.offset, order_by: listQuery.orderBy } } : {}),
    ...(anchorsQuery ? { query: { status: anchorsQuery.status, limit: anchorsQuery.limit, offset: anchorsQuery.offset, order_by: anchorsQuery.orderBy, internal_list_limit: ANCHORS_QUERY.internalListLimit } } : {}),
    ...(rdQuery ? { query: { status: rdQuery.status, dofollow: rdQuery.dofollow, limit: rdQuery.limit, offset: rdQuery.offset, order_by: rdQuery.orderBy, internal_list_limit: REFERRING_DOMAINS_QUERY.internalListLimit } } : {}),
    ...(dpQuery ? { query: { status: DOMAIN_PAGES_QUERY.status, limit: dpQuery.limit, offset: dpQuery.offset, order_by: dpQuery.orderBy, internal_list_limit: DOMAIN_PAGES_QUERY.internalListLimit } } : {}),
    ...(backlinksQuery ? { query: { status: backlinksQuery.status, dofollow: backlinksQuery.dofollow } } : {}),
    result: result.payload,
  };
}

/**
 * The traffic per page, built from ONE ranked-keywords call (the Organic Keywords section: the same cached entry its "export all" uses, so
 * a project that has already looked at its keywords buys nothing). Keywords are grouped by NORMALISED url; the answer says how many keywords
 * the domain has in all and whether the 1,000 that were read are all of them. Resolves to the { payload, cost } the cache stores.
 */
async function buildTrafficPayload({ project, userId, target }) {
  const keywords = await getDomainOverviewSection({
    project,
    section: 'ranked-keywords',
    query: parseRankedKeywordsQuery({ limit: String(TOP_PAGES_TRAFFIC.limit), order_by: TOP_PAGES_TRAFFIC.orderBy }),
    userId,
  });
  const items = keywords.result?.items ?? [];
  const keywordsTotal = typeof keywords.result?.totalCount === 'number' ? keywords.result.totalCount : null;
  return {
    payload: {
      byUrl: buildTrafficByUrl(items, target),
      meta: { rows: items.length, keywordsTotal, truncated: keywordsTotal !== null && keywordsTotal > items.length },
    },
    cost: null,
  };
}
