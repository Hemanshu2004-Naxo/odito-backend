import { analyzeMention, maskCitationMarkup } from '../../shared/services/answerAnalysisService.js';
import { findMentions, mentions, normalizeForMatching } from '../../shared/services/brandMatchingService.js';
import { normalizeHost } from '../../shared/services/citationNormalizationService.js';

/**
 * Brand / domain / competitor analysis of ONE captured AI Overview. Pure; the same function is used when a result arrives and when
 * evidence is re-analysed, so a stored result is always reproducible from what was captured.
 *
 * Mention and citation are SEPARATE signals:
 *   mention   the business is NAMED in the overview prose (URLs and link targets are masked first; boundary-aware matching, so
 *             "Apollo" does not match "Apollonia"). Uses the business name plus reliable aliases only.
 *   citation  at least one reference URL's HOST is the verified owned host. Parsed hostnames only, never a substring test, and
 *             subdomains are NOT owned unless listed in target.ownedHosts (the verified domain policy).
 */

export const ANALYSIS_VERSION = 'google_aio_analysis_v1';

export const REFERENCES_STATUS = Object.freeze({ AVAILABLE: 'available', UNAVAILABLE: 'unavailable' });
export const CONTENT_STATUS = Object.freeze({ ANALYSED: 'analysed', NO_CONTENT: 'no_content' });

export function isOwnedHost(host, ownedHosts) {
  const h = normalizeHost(host);
  if (!h) return false;
  return (ownedHosts || []).some((o) => normalizeHost(o) === h);
}

const compact = (v) => normalizeForMatching(v).replace(/ /g, '');
// The registrable label of a host: "apollohospitals.com" -> "apollohospitals", "shop.acme.co.in" -> "acme" (two-letter ccTLD after a short SLD).
const domainLabel = (host) => {
  const parts = String(host || '').split('.').filter(Boolean);
  const n = parts.length;
  if (n < 2) return parts[0] || '';
  if (n >= 3 && parts[n - 1].length === 2 && parts[n - 2].length <= 3) return parts[n - 3];
  return parts[n - 2];
};

/** Was a competitor named by the metadata of a reference (source name, title, or the registrable label of its domain)? */
function competitorCited(name, refs) {
  const c = compact(name);
  if (!c) return false;
  return refs.some((r) => mentions(r.source || '', name) || mentions(r.title || '', name) || (r.host && compact(domainLabel(r.host)) === c));
}

/**
 * @param {{text:string|null, markdown:string|null, references:object[]}} overview  extracted by responseParser.extractAiOverview
 * @param {{brandNames:string[], brandMatchReliable?:boolean, competitors?:string[], targetHost?:string|null, ownedHosts?:string[]}} target
 */
export function analyzeOverview(overview, target) {
  const ownedHosts = (target.ownedHosts && target.ownedHosts.length ? target.ownedHosts : [target.targetHost]).filter(Boolean);
  const references = (overview.references || []).map((r) => ({ ...r, isOwned: r.host ? isOwnedHost(r.host, ownedHosts) : false }));

  // ── references ──
  const referencesStatus = references.length ? REFERENCES_STATUS.AVAILABLE : REFERENCES_STATUS.UNAVAILABLE;
  const owned = references.filter((r) => r.isOwned);
  const ownedPages = [...new Set(owned.map((r) => r.normalizedUrl))];
  const externalDomains = [...new Set(references.filter((r) => !r.isOwned && r.host).map((r) => r.host))];

  // ── prose ──
  const prose = overview.text || overview.markdown || '';
  const hasContent = Boolean(prose.trim());
  let mention = { status: null, mentioned: null, occurrences: null, excerpt: null, matchedName: null, ambiguousReason: null };
  let competitorMentions = [];
  if (hasContent) {
    const m = analyzeMention(prose, target);
    mention = { status: m.status, mentioned: m.status === 'mentioned', occurrences: m.occurrences, excerpt: m.excerpt, matchedName: m.matchedName, ambiguousReason: m.ambiguousReason };
    const masked = maskCitationMarkup(prose);
    competitorMentions = findMentions(masked, target.competitors || []);
  }

  const competitors = (target.competitors || []).filter(Boolean).map((name) => {
    const hit = competitorMentions.find((x) => normalizeForMatching(x.name) === normalizeForMatching(name));
    return {
      name,
      // null = could not be evaluated (no prose / no references); never "false" for missing evidence.
      mentioned: hasContent ? Boolean(hit) : null,
      mentionCount: hit ? hit.count : (hasContent ? 0 : null),
      cited: references.length ? competitorCited(name, references) : null,
    };
  });

  return {
    analysisVersion: ANALYSIS_VERSION,
    contentStatus: hasContent ? CONTENT_STATUS.ANALYSED : CONTENT_STATUS.NO_CONTENT,
    mention,
    referencesStatus,
    references,
    // null (not false) when no references could be inspected: those observations are excluded from the citation denominator.
    ownedCited: references.length ? owned.length > 0 : null,
    ownedPages,
    ownedCitationCount: owned.length,
    externalDomains,
    competitors,
  };
}

export default { analyzeOverview, isOwnedHost, ANALYSIS_VERSION, REFERENCES_STATUS, CONTENT_STATUS };
