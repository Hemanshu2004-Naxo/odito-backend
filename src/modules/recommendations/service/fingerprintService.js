import crypto from 'crypto';
import { RECOMMENDATION_VERSION } from '../constants/recommendationTypes.js';

/**
 * Fingerprint Service
 *
 * Creates deterministic hashes for recommendation deduplication.
 *
 * Fingerprint = SHA256(ruleId + pageType + framework + promptGroup + scopeDiscriminator)
 *
 * recommendationHash = SHA256(fingerprint + templateVersion + recommendationVersion)
 * Used to detect when regeneration is needed (prompt/template change).
 */

class FingerprintService {

  /**
   * Compute the recommendation fingerprint from issue context.
   * 
   * @param {string} ruleId - The rule that triggered the issue
   * @param {Object} context - Issue context (pageType, framework, cms)
   * @returns {string} SHA256 hex fingerprint
   */
  /**
   * Fingerprint v2 — stable, prompt-mode-aware cache key.
   *
   * Base:  ruleId + pageType + framework + promptGroup
   * Scope: determined by promptMode (see table below)
   *
   * promptMode          scopeDiscriminator
   * ──────────────────  ──────────────────────────────────────────────
   * content_rewrite     SHA256(pageUrl)[:12]        — per-page (text is unique per page)
   * comparison_fix      SHA256(pageUrl)[:12]        — per-page (canonical/OG is page-specific)
   * element_add         SHA256(pageUrl)[:12]        — per-page when URL known
   *                     SHA256(pageType|ruleId)[:12] — per-type fallback when no URL
   * list_fix            SHA256(pageUrl)[:12]        — per-page when URL known
   *                     SHA256(pageType|ruleId)[:12] — per-type fallback when no URL
   * structural_fix      SHA256(pageUrl)[:12]        — per-page when URL known
   *                     (empty)                     — per-framework when URL unknown
   *
   * Legacy path (no recommendationContext):
   *   SHA256(pageUrl)[:12] when URL available, else SHA256(rawValue)[:16]
   */
  /**
   * @param {string}  ruleId
   * @param {Object}  context
   * @param {string|null} rawValue
   * @param {Object|null} recommendationContext
   * @param {string|null} auditId  — optional audit/crawl ID. When provided, the
   *   fingerprint changes whenever the page is re-crawled, preventing stale
   *   recommendations from a previous audit being served for updated content.
   *   Applies to all per-page prompt modes.
   * @param {string|null} fallbackPageUrl — URL to use when recommendationContext
   *   is unavailable (legacy path). Prevents cross-URL cache bleeding for absent
   *   elements that produce no rawValue.
   */
  computeFingerprint(ruleId, context = {}, rawValue = null, recommendationContext = null, auditId = null, fallbackPageUrl = null) {
    const { pageType = 'Unknown', framework = 'unknown' } = context;
    const rcPromptMode  = recommendationContext?.recommendationObjective?.promptMode;
    const rcPromptGroup = recommendationContext?.recommendationObjective?.promptGroup;
    // Prefer URL from context; fall back to explicitly-passed URL (for legacy path)
    const pageUrl = recommendationContext?.pageContext?.pageUrl || fallbackPageUrl || '';

    const base = [
      ruleId.toLowerCase().trim(),
      pageType.toLowerCase().trim(),
      framework.toLowerCase().trim(),
      // promptGroup included so GroupRegistry changes invalidate stale recs
      rcPromptGroup != null ? String(rcPromptGroup) : 'legacy',
    ];

    // auditId scopes the fingerprint to a specific crawl session.
    // Inject for all per-page modes so re-crawls produce fresh URL-specific recommendations.
    const isPerPageMode = rcPromptMode === 'content_rewrite'
      || rcPromptMode === 'comparison_fix'
      || rcPromptMode === 'element_add'
      || rcPromptMode === 'list_fix';
    if (auditId && isPerPageMode) {
      const auditHash = crypto.createHash('sha256').update(String(auditId)).digest('hex').slice(0, 10);
      base.push(`audit:${auditHash}`);
    }

    // ── Scope discriminator (v2 strategy) ─────────────────────────────────
    if (rcPromptMode) {
      let scopeInput = '';
      if (rcPromptMode === 'content_rewrite' || rcPromptMode === 'comparison_fix') {
        // Per-page: recommendation content is tightly bound to the detected text
        scopeInput = pageUrl.toLowerCase();
      } else if (rcPromptMode === 'element_add' || rcPromptMode === 'list_fix') {
        // The generated element (suggested H1, alt text, schema JSON, link targets)
        // must match the specific page's topic and content — never share across URLs.
        // Fall back to per-type scope only when no URL is available (project-level
        // requests with no pageUrl context).
        scopeInput = pageUrl
          ? pageUrl.toLowerCase()
          : `${pageType.toLowerCase()}|${ruleId.toLowerCase()}`;
      } else if (rcPromptMode === 'structural_fix') {
        // Page structure problems (which duplicate H1s to remove, which redirect chain
        // to fix) are unique to each URL. Scope per-URL when available.
        scopeInput = pageUrl ? pageUrl.toLowerCase() : '';
      }

      if (scopeInput) {
        const scopeHash = crypto.createHash('sha256').update(scopeInput).digest('hex').slice(0, 12);
        base.push(scopeHash);
      }
    } else {
      // Legacy path (no recommendationContext): prefer URL scope so absent-element
      // issues (rawValue=null) don't bleed the same recommendation across all URLs.
      if (pageUrl) {
        const scopeHash = crypto.createHash('sha256').update(pageUrl.toLowerCase()).digest('hex').slice(0, 12);
        base.push(scopeHash);
      } else if (rawValue && typeof rawValue === 'string' && rawValue.trim()) {
        // No URL available — fall back to content hash of detected value
        const contentHash = crypto.createHash('sha256').update(rawValue.trim()).digest('hex').slice(0, 16);
        base.push(contentHash);
      }
      // No URL and no rawValue: truly global fingerprint (acceptable last resort)
    }

    // Schema recommendations are generated from verified evidence (existing entity, verified logo,
    // canonical URL, hierarchy). A cached recommendation built without it (or from different
    // evidence) may contain values that are now known to be wrong, so the evidence is part of the key.
    const evidenceKey = recommendationContext?.schemaEvidence?.fingerprintKey;
    if (evidenceKey) base.push(`ev:${evidenceKey}`);

    return crypto.createHash('sha256').update(base.join('|')).digest('hex');
  }

  /**
   * Compute the recommendation hash.
   * Changes when template/prompt version changes → triggers regeneration.
   * 
   * @param {string} fingerprint - The base fingerprint
   * @param {number} templateVersion - Current template version
   * @param {number} recommendationVersion - Current recommendation schema version
   * @returns {string} SHA256 hex hash
   */
  computeRecommendationHash(fingerprint, templateVersion = 1, recommendationVersion = RECOMMENDATION_VERSION, promptGroup = null) {
    const input = [
      fingerprint,
      String(templateVersion),
      String(recommendationVersion),
      // Including promptGroup ensures GroupRegistry changes invalidate stale recs
      promptGroup != null ? String(promptGroup) : 'none',
    ].join('|');

    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Check if a cached recommendation is still valid.
   * Invalid if: hash mismatch, invalidated, expired, or wrong version.
   * 
   * @param {Object} cached - Cached recommendation document
   * @param {string} expectedHash - Current expected hash
   * @returns {boolean}
   */
  isValid(cached, expectedHash) {
    if (!cached) return false;
    if (cached.invalidatedAt) return false;
    if (cached.recommendationHash !== expectedHash) return false;
    if (cached.recommendationVersion !== RECOMMENDATION_VERSION) return false;
    if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) return false;
    return true;
  }
}

export default new FingerprintService();
