/**
 * sitelinkResolver — the ONE place a sitelink's destination URL comes from.
 *
 * HONESTY CONSTRAINT (spec §12/§13, the reason this file exists at all):
 * Odito's AI Campaign generation context (campaignContextBuilder.js) does
 * NOT crawl or discover a project's other pages — it only ever knows TWO
 * possibly-distinct URLs: the brief's explicitly-submitted landing page,
 * and the project's own main website URL. There is no "6 verified pages"
 * data source anywhere in this codebase today (confirmed by inspection —
 * see the Phase 9 creative-quality report). So this resolver returns AT
 * MOST those 1-2 already-trusted URLs, deduplicated — never more, no
 * matter what Claude is asked for. generatedCampaignMapper.js then caps
 * sitelink generation at `trustedUrls.length`, and
 * creativeQualityValidator.js's UNTRUSTED_URL check is the hard backstop
 * that makes it structurally impossible for a Claude-invented URL to ever
 * reach a sitelink, even if every other layer had a bug.
 *
 * If a future phase adds real page discovery (a sitemap crawl, a verified
 * page list), it plugs in here — the rest of the pipeline (mapper,
 * validator, publish provider) already scales to however many trusted URLs
 * this function returns.
 */

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {object} args.brief - normalized brief ({ landingPageUrl })
 * @param {object} args.context - campaignContextBuilder's output ({ project: { websiteUrl } })
 * @returns {{ urls: string[], reason: string|null }} `reason` is set (and `urls` may be short of the target) whenever Odito could not resolve as many trusted URLs as ASSET_TARGETS.sitelinksTarget would want.
 */
export function resolveTrustedSitelinkUrls({ brief, context } = {}) {
  const candidates = [brief?.landingPageUrl, context?.project?.websiteUrl]
    .map((v) => (typeof v === 'string' ? v.trim() : null))
    .filter(isHttpUrl);

  const urls = [...new Set(candidates)]; // de-dupe exact-string matches (e.g. landing page IS the main site)

  const reason = urls.length === 0
    ? 'no_verified_urls_available'
    : 'insufficient_verified_pages'; // Odito has no page-discovery pipeline — see file header

  return { urls, reason };
}

export default { resolveTrustedSitelinkUrls };
