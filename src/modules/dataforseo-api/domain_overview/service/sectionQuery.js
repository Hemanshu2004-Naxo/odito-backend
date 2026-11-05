import { parseRankedKeywordsQuery } from '../validator/rankedKeywordsQuery.js';
import { parseCompetitorsQuery } from '../validator/competitorsQuery.js';
import { parseBacklinksQuery } from '../validator/backlinksQuery.js';
import { parseBacklinksListQuery } from '../validator/backlinksListQuery.js';
import { parseAnchorsQuery } from '../validator/anchorsQuery.js';
import { parseReferringDomainsQuery } from '../validator/referringDomainsQuery.js';
import { parseDomainPagesQuery } from '../validator/domainPagesQuery.js';
import { parseBulkTrafficQuery } from '../validator/bulkTrafficQuery.js';
import { normalizeTargetDomain } from '../../shared/targetDomain.js';

/**
 * A section's query string -> the validator's canonical query (undefined for sections that take none). The ONE place that maps a section to
 * its parser: the HTTP controller and the scan engine both use it, so a scan buys exactly the cache entry a page reads.
 * @param {string} section
 * @param {Record<string, unknown>} params the raw query-string values
 * @param {{ main_url: string }} project
 */
export function parseSectionQuery(section, params = {}, project) {
  switch (section) {
    case 'ranked-keywords': return parseRankedKeywordsQuery(params);
    case 'competitors': return parseCompetitorsQuery(params);
    case 'backlinks': return parseBacklinksQuery(params);
    case 'backlinks-list': return parseBacklinksListQuery(params);
    case 'anchors': return parseAnchorsQuery(params);
    case 'referring-domains': return parseReferringDomainsQuery(params);
    case 'domain-pages': return parseDomainPagesQuery(params);
    // The project is always the first target; the browser only chooses who to compare it with.
    case 'bulk-traffic': return parseBulkTrafficQuery(params, normalizeTargetDomain(project.main_url));
    default: return undefined;
  }
}
