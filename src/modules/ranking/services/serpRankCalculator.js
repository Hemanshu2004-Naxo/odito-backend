/**
 * The single place that turns DataForSEO SERP items into rankings for a tracked domain. RankingParserService.parseOrganic
 * delegates here - there is no second ranking engine.
 *
 *  - Original provider ordering is preserved; positions come from the provider's metadata, never from array indexes of a
 *    filtered list.
 *  - organicRank  = rank_group of the best matching `organic` item (position within the organic group).
 *    absoluteRank = rank_absolute of that same item (position among every SERP element). Neither is derived from the
 *    other, and a missing/invalid rank_group is NOT replaced by rank_absolute (that would invent an organic position).
 *  - Paid, featured_snippet, ai_overview, maps and every other element type never count as organic.
 *  - Local pack is its own metric (localPackRank), taken from local_pack_element.rank_group, and is never merged into
 *    organicRank.
 *  - Several URLs of the tracked site: the best (lowest) valid organic rank wins; all are kept in `matches`.
 */

import { resolveSerpItem, isGoogleHost } from './serpUrlResolver.js';
import { matchSerpResultDomain, MATCH_POLICY } from './serpDomainMatcher.js';

export const RANKING_STATUS = Object.freeze({ FOUND: 'found', NOT_FOUND: 'not_found', UNKNOWN: 'unknown' });

const validRank = (n) => (Number.isInteger(n) && n > 0 ? n : null);

/** Lowercase, letters and digits only: "ASG Eye-Hospital!" and "asgeyehospital" compare equal. */
export const brandKey = (s) => (typeof s === 'string' ? s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '');
const MIN_BRAND_KEY = 4; // shorter names ("ASG", "Dr") would match unrelated results

/**
 * Last resort for a masked result whose website cannot be read: the result's `website_name` or `title` contains the project's brand name.
 * It is a LOW-confidence match (matchBasis 'brand_name'), never a verified domain: the host stays null.
 */
function brandNameMatches(item, key) {
  if (!key || key.length < MIN_BRAND_KEY) return false;
  return brandKey(item?.website_name).includes(key) || brandKey(item?.title).includes(key);
}

function classifyUrlType(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') === '' ? 'homepage' : 'internal_page'; } catch { return 'internal_page'; }
}

function flattenItems(data) {
  const result = data?.tasks?.[0]?.result;
  if (!Array.isArray(result)) return [];
  const all = [];
  for (const page of result) if (Array.isArray(page?.items)) all.push(...page.items);
  return all;
}

/**
 * @param {object|Array} serp  raw DataForSEO response, or an already-flattened items array
 * @param {string} trackedDomain
 * @param {{ policy?: string, brandName?: string|null, alternateDomains?: Array<string|{ domain: string, policy?: string }> }} [opts]
 *   brandName: the project's brand; enables the low-confidence brand_name fallback for masked results (see brandNameMatches).
 *   alternateDomains: websites that are EXPLICITLY verified to belong to the tracked business (an auditable association record, never inferred
 *   from a redirect, a title or a Maps listing). Each is matched as strictly as the tracked domain itself; a result is reported with
 *   `viaAlternateDomain` so the dashboard can say which site ranked. Empty by default: nothing is associated automatically.
 */
export function calculateSerpRankings(serp, trackedDomain, { policy = MATCH_POLICY.SUBDOMAINS, alternateDomains = [], brandName = null } = {}) {
  const brand = brandKey(brandName);
  let resolvedFromDomain = 0, resolvedFromBreadcrumb = 0, brandNameMatchCount = 0;
  const alternates = (Array.isArray(alternateDomains) ? alternateDomains : [])
    .map((a) => (typeof a === 'string' ? { domain: a, policy } : { domain: a?.domain, policy: a?.policy ?? policy }))
    .filter((a) => typeof a.domain === 'string' && a.domain.trim());
  const items = Array.isArray(serp) ? serp : flattenItems(serp);
  const matches = [];
  const seen = new Set();
  let organicSeen = 0, unresolvedOrganic = 0, matchedWithoutRank = 0;
  let bestUnresolvedRank = null; // best (lowest) rank_group among unresolved Google-redirect organic results
  let localPack = null;
  const localPackCandidates = [];

  for (const item of items) {
    if (item?.type === 'organic') {
      organicSeen++;
      const r = resolveSerpItem(item);
      if (r.resolutionStatus !== 'resolved') {
        // Only a Google redirect with no destination could still be the tracked site; invalid / unsupported / URL-less
        // items are known not to be a website we could match.
        if (r.resolutionStatus === 'unresolved' && brandNameMatches(item, brand)) {
          brandNameMatchCount++;
          const lowRank = validRank(item.rank_group);
          if (!lowRank) { matchedWithoutRank++; continue; }
          matches.push({
            rank: lowRank, absoluteRank: validRank(item.rank_absolute), url: item.url ?? '', originalUrl: null, type: 'internal_page',
            matchType: 'brand_name', resolutionMethod: null, viaAlternateDomain: null,
            host: null, urlMasked: true, matchConfidence: 'low', matchBasis: 'brand_name',
          });
          continue;
        }
        if (r.resolutionStatus === 'unresolved') {
          unresolvedOrganic++;
          const ur = validRank(item.rank_group);
          if (ur && (bestUnresolvedRank === null || ur < bestUnresolvedRank)) bestUnresolvedRank = ur;
        }
        continue;
      }
      if (r.resolutionMethod === 'breadcrumb') resolvedFromBreadcrumb++; else resolvedFromDomain++;
      let m = matchSerpResultDomain({ trackedDomain, resultHostname: r.hostname, policy });
      let viaAlternateDomain = null;
      if (!m.matched) {
        for (const alt of alternates) {
          const am = matchSerpResultDomain({ trackedDomain: alt.domain, resultHostname: r.hostname, policy: alt.policy });
          if (am.matched) { m = am; viaAlternateDomain = alt.domain; break; }
        }
      }
      if (!m.matched) continue;
      const rank = validRank(item.rank_group);
      if (!rank) { matchedWithoutRank++; continue; }
      // Direct results keep the provider's URL untouched; only redirects are replaced by their destination.
      const direct = r.resolutionMethod === 'direct';
      // A masked result (host known only from the SERP breadcrumb / provider domain) keeps its goto link: the real URL cannot be recovered.
      const masked = r.resolutionMethod === 'breadcrumb' || (r.resolutionMethod === 'provider_resolved' && !r.resolvedUrl && /\/goto\b/.test(item.url ?? ''));
      // A provider-resolved host with no destination URL keeps the provider's own URL so the match is not lost.
      const url = (direct ? item.url : r.resolvedUrl) ?? item.url ?? '';
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      matches.push({
        rank, absoluteRank: validRank(item.rank_absolute), url, originalUrl: direct || !r.resolvedUrl ? null : (item.url ?? null), type: classifyUrlType(url),
        matchType: m.matchType, resolutionMethod: r.resolutionMethod, viaAlternateDomain,
        host: r.hostname, urlMasked: masked, matchConfidence: 'high', matchBasis: r.resolutionMethod === 'breadcrumb' ? 'breadcrumb' : 'domain',
      });
    } else if (item?.type === 'local_pack') {
      for (const el of Array.isArray(item.items) ? item.items : []) {
        if (el?.type !== 'local_pack_element') continue;
        const r = resolveSerpItem(el);
        const position = validRank(el.rank_group) ?? validRank(el.rank_absolute);
        // A Google Maps / redirect link is not the business website.
        const site = r.resolutionStatus === 'resolved' && !isGoogleHost(r.hostname);
        const candidate = {
          position, cid: el.cid ?? null, title: el.title ?? null,
          hostname: site ? r.hostname : null, hasWebsite: site,
        };
        localPackCandidates.push(candidate);
        if (!localPack && candidate.hostname && position
          && matchSerpResultDomain({ trackedDomain, resultHostname: candidate.hostname, policy }).matched) localPack = candidate;
      }
    }
  }

  // Stable sort: equal ranks keep provider order.
  // A confident match always outranks a brand-name guess; the guess is used only when nothing confident was found.
  const bySort = (list) => list.map((m, i) => ({ m, i })).sort((a, b) => a.m.rank - b.m.rank || a.i - b.i).map((x) => x.m);
  const confident = bySort(matches.filter((m) => m.matchConfidence !== 'low'));
  const ranked = confident.length ? [...confident, ...bySort(matches.filter((m) => m.matchConfidence === 'low'))] : bySort(matches);
  const best = ranked[0] ?? null;

  return {
    organicRank: best?.rank ?? null,
    absoluteRank: best?.absoluteRank ?? null,
    localPackRank: localPack?.position ?? null,
    localPackListing: localPack,
    // not_found only when nothing could still be the tracked site: no match, no rank-less match, no unresolved redirect.
    rankingStatus: best ? RANKING_STATUS.FOUND
      : (matchedWithoutRank > 0 || unresolvedOrganic > 0 ? RANKING_STATUS.UNKNOWN : RANKING_STATUS.NOT_FOUND),
    // found, but an unresolved redirect ranked above it - the real best rank may be better than reported.
    betterRankPossible: !!best && bestUnresolvedRank !== null && bestUnresolvedRank < best.rank,
    matches: ranked,
    localPackCandidates,
    matchConfidence: best?.matchConfidence ?? null,
    matchBasis: best?.matchBasis ?? null,
    stats: { organicItems: organicSeen, unresolvedOrganic, matchedWithoutRank, bestUnresolvedRank, resolvedFromDomain, resolvedFromBreadcrumb, brandNameMatches: brandNameMatchCount },
  };
}

/**
 * Local pack businesses that listed no website but do carry a Google business id: the candidates a Maps lookup could
 * enrich (website -> domain match). `enrich(cid)` is injected so tests and callers control cost; it must return
 * { website } or null. Nothing is invented when it returns nothing - the listing keeps hostname null.
 */
export async function enrichLocalPackCandidates(candidates, trackedDomain, enrich, { policy = MATCH_POLICY.SUBDOMAINS, maxLookups = 5 } = {}) {
  const out = [];
  let lookups = 0;
  for (const c of candidates) {
    if (c.hasWebsite || !c.cid || lookups >= maxLookups || typeof enrich !== 'function') { out.push({ ...c, enriched: false }); continue; }
    lookups++;
    let info = null;
    try { info = await enrich(c.cid); } catch { info = null; }
    const r = info?.website ? resolveSerpItem({ url: info.website }) : null;
    if (r?.resolutionStatus === 'resolved') {
      out.push({ ...c, hostname: r.hostname, hasWebsite: true, enriched: true,
        matchesTracked: matchSerpResultDomain({ trackedDomain, resultHostname: r.hostname, policy }).matched });
    } else out.push({ ...c, enriched: false });
  }
  return out;
}
