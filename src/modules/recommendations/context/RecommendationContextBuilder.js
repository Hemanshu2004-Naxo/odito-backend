/**
 * RecommendationContextBuilder
 *
 * Transforms a resolved IssueContext (from IssueContextEngine) into a
 * normalized RecommendationContext ready for prompt construction.
 *
 * ─────────────────────────────────────────────────────────────────
 * DATA FLOW
 * ─────────────────────────────────────────────────────────────────
 *   IssueContextEngine.resolve(projectId, issueId, pageUrl)
 *     → IssueContext  { identity, currentState, expectedState, pageContext, metadata }
 *     → RecommendationContextBuilder.build(issueContext)
 *     → RecommendationContext  (this module's output)
 *     → AI Generator (Phase 3)
 * ─────────────────────────────────────────────────────────────────
 *
 * DESIGN PRINCIPLES
 *   - Zero DB calls.  All data already resolved by IssueContextEngine.
 *   - Zero AI calls.  Pure data transformation.
 *   - Lazy sections.  Only contentContext / technicalContext /
 *     aiVisibilityContext are built when relevant to the issue.
 *   - Cache-first.    In-memory LRU (5 min TTL) prevents rebuild on
 *     repeated calls for the same issue + page.
 *   - Stable output.  Same IssueContext → same RecommendationContext.
 *     Changes only when IssueContext.metadata.readinessScore changes
 *     or rawValue changes (contextHash detects this).
 */

import crypto from 'crypto';
import { normalizeDisplayType }        from './DisplayTypeNormalizer.js';
import { resolveObjective }            from './ObjectiveStrategyMap.js';
import recommendationContextCache      from './RecommendationContextCache.js';
import MissingElementContextBuilder    from './MissingElementContextBuilder.js';
import {
  CONTEXT_VERSION,
  CONTEXT_SECTION,
  CONTEXT_LIMITS,
  emptyContext,
} from './RecommendationContextSchema.js';

// Issue categories / IDs that warrant content context enrichment
const CONTENT_ISSUE_IDS = new Set([
  'meta_description_missing', 'meta_description_too_short', 'meta_description_too_long',
  'meta_description_ctr', 'multiple_meta_descriptions',
  'title_missing', 'title_too_short', 'title_too_long', 'title_pixel_length',
  'multiple_title_tags', 'keyword_not_in_h1',
  'h1_missing', 'multiple_h1_tags', 'heading_hierarchy_skipped',
  'thin_content', 'service_pages_800_words',
  'description_minimum_50_characters', 'first_60_words_direct_answer',
  'clear_entity_first_150_words',
  'h1_tags',
]);

// Issue IDs that warrant technical context enrichment
const TECHNICAL_ISSUE_IDS = new Set([
  'canonical_tag_errors', 'canonical_tags', 'og_tags_missing', 'og_tags_incomplete',
  'og_tags', 'social_tags', 'og_social_tags', 'security_headers',
  'noindex_key_pages', 'noindex_tags',
  'orphan_pages', 'click_depth', 'topic_clusters_internal_links',
  'broken_links', 'links_to_redirecting_urls', 'redirect_chains',
  'non_seo_friendly_urls', 'long_urls', 'https_not_enforced',
]);

// Issue IDs that warrant AI visibility context enrichment
const AI_VIS_ISSUE_IDS = new Set([
  'organization_schema', 'schema_markup', 'faq_schema', 'article_schema',
  'primary_organization_schema', 'schema_valid_jsonld', 'correct_type',
  'breadcrumblist_schema', 'no_plugin_duplicate_schemas',
  'service_pages_800_words', 'topic_clusters_internal_links',
  'first_60_words_direct_answer', 'clear_entity_first_150_words',
  'faq_section_5_to_10_questions', 'question_based_h2_headings',
  'semantic_subtopics_covered', 'bullet_numbered_lists_used',
  'conversational_tone', 'step_by_step_content',
]);

class RecommendationContextBuilder {

  /**
   * Build a RecommendationContext from a resolved IssueContext.
   *
   * @param {object} issueContext  — Full IssueContext from IssueContextEngine
   * @returns {object}              RecommendationContext
   */
  build(issueContext) {
    if (!issueContext) {
      console.warn('[RCB] build() called with null issueContext — returning empty context');
      return emptyContext('unknown', '');
    }

    const issueId  = issueContext.identity?.issueId  || '';
    const pageUrl  = issueContext.pageContext?.pageUrl || '';

    // ── Cache check ──────────────────────────────────────────────────────────
    const contentHash  = this._hashIssueContext(issueContext);
    const cacheKey     = recommendationContextCache.buildKey(issueId, pageUrl, contentHash);
    const cached       = recommendationContextCache.get(cacheKey);
    if (cached) {
      console.log(`[RCB] Cache HIT | issueId=${issueId} | page=${pageUrl}`);
      return cached;
    }

    // ── Step 1: Normalize display-type-specific state ────────────────────────
    const { currentState, expectedState } = normalizeDisplayType(issueContext);

    // ── Step 2: Resolve recommendation objective ─────────────────────────────
    const objective = resolveObjective(issueId, currentState, expectedState, issueContext);

    // ── Step 3: Build identity ────────────────────────────────────────────────
    const identity = this._buildIdentity(issueContext);

    // ── Step 4: Build page context ────────────────────────────────────────────
    const pageContext = this._buildPageContext(issueContext);

    // ── Step 5: Build optional domain contexts ────────────────────────────────
    const sectionsPopulated = [];
    let contentContext      = null;
    let technicalContext    = null;
    let aiVisibilityContext = null;

    if (CONTENT_ISSUE_IDS.has(issueId) || identity.category?.toLowerCase().includes('content')) {
      contentContext = this._buildContentContext(issueContext, currentState);
      if (contentContext) sectionsPopulated.push(CONTEXT_SECTION.CONTENT);
    }

    if (TECHNICAL_ISSUE_IDS.has(issueId) || identity.category?.toLowerCase().includes('technical')) {
      technicalContext = this._buildTechnicalContext(issueContext, currentState);
      if (technicalContext) sectionsPopulated.push(CONTEXT_SECTION.TECHNICAL);
    }

    if (AI_VIS_ISSUE_IDS.has(issueId) || identity.issueType === 'ai_visibility') {
      aiVisibilityContext = this._buildAiVisibilityContext(issueContext);
      if (aiVisibilityContext) sectionsPopulated.push(CONTEXT_SECTION.AI_VISIBILITY);
    }

    // ── Step 5b: Build missing element context ────────────────────────────────
    // Infers primaryTopic, businessName, pageIntent, etc. from available signals
    // so PromptBuilder can generate page-specific content instead of placeholders.
    let missingElementContext = null;
    if (currentState.isAbsent) {
      // Provide a partial RC for inference (before caching)
      const partialRc = {
        pageContext,
        contentContext,
        technicalContext,
        aiVisibilityContext,
        entityContext: issueContext.entityContext || null,
      };
      missingElementContext = MissingElementContextBuilder.infer(partialRc);
      if (missingElementContext) {
        sectionsPopulated.push(CONTEXT_SECTION.MISSING_ELEMENT);
        console.log(`[RCB] MissingElementContext built | isRich=${missingElementContext.isRich} | topic="${missingElementContext.primaryTopic}" | business="${missingElementContext.businessName}"`);
      }
    }

    // ── Step 6: Assemble context ──────────────────────────────────────────────
    const context = {
      identity,
      currentState,
      expectedState,
      pageContext,
      contentContext,
      technicalContext,
      aiVisibilityContext,
      missingElementContext,
      // Verified facts about the page's Organization / breadcrumb trail / article (schema-evidence/).
      // Null for every issue type that does not emit those schemas.
      schemaEvidence: issueContext.schemaEvidence || null,
      recommendationObjective: objective,
      builderMeta: {
        version:                CONTEXT_VERSION,
        builtAt:                new Date().toISOString(),
        contextHash:            contentHash,
        issueContextReadiness:  issueContext.metadata?.readinessScore ?? 0,
        hasRichContext:         this._hasRichContext(currentState, sectionsPopulated),
        sectionsPopulated,
      },
    };

    // ── Step 7: Cache and return ──────────────────────────────────────────────
    recommendationContextCache.set(cacheKey, context);
    console.log(`[RCB] Built context | issueId=${issueId} | promptMode=${objective.promptMode} | sections=[${sectionsPopulated.join(',')}] | rich=${context.builderMeta.hasRichContext}`);
    return context;
  }

  // ── Section Builders ────────────────────────────────────────────────────────

  /**
   * Identity — issueId, issueType, category, severity, displayType.
   * @private
   */
  _buildIdentity(issueContext) {
    const id = issueContext.identity || {};
    return {
      issueId:     id.issueId    || '',
      issueType:   id.issueType  || id.pipeline || '',
      category:    id.category   || '',
      severity:    id.severity   || '',
      displayType: issueContext.currentState?.displayType || '',
      pipeline:    id.pipeline   || id.issueType || '',
    };
  }

  /**
   * Page context — URL, type, framework, cms, canonical.
   * @private
   */
  _buildPageContext(issueContext) {
    const pc = issueContext.pageContext || {};
    return {
      pageUrl:      pc.pageUrl      || '',
      pageType:     pc.pageType     || 'Unknown',
      framework:    pc.framework    || 'unknown',
      cms:          pc.cms          || null,
      canonicalUrl: pc.canonicalUrl || null,
    };
  }

  /**
   * Content context — populated for content/meta/heading issues.
   * Pulls from currentState relatedContent and the raw IssueContext state.
   * @private
   */
  _buildContentContext(issueContext, normalizedCurrentState) {
    const cs  = issueContext.currentState || {};
    const related = cs.relatedContent || normalizedCurrentState._relatedContent || {};
    const issueId = issueContext.identity?.issueId || '';

    // Page title — from related content or textState label associations
    const pageTitle = related.pageTitle ?? null;

    // H1 text
    const h1Text = related.h1Text ?? null;

    // Word count — measurement when issue is thin_content
    const wordCount = (issueId === 'thin_content' || issueId === 'service_pages_800_words')
      ? (normalizedCurrentState.measurement?.value ?? null)
      : null;

    // Content preview — rawText when thin_content (already truncated by normalizer)
    const contentPreview = issueId === 'thin_content'
      ? (normalizedCurrentState.rawText
          ? _words(normalizedCurrentState.rawText, 60)  // 60-word excerpt for context
          : null)
      : null;

    // Meta description — rawText when issue is meta-related
    const isMeta = issueId.startsWith('meta_description');
    const metaDescription = isMeta ? (normalizedCurrentState.rawText ?? null) : null;

    // Only return if at least one field is populated
    if (!pageTitle && !h1Text && !wordCount && !contentPreview && !metaDescription) {
      return null;
    }

    return { pageTitle, h1Text, wordCount, contentPreview, metaDescription };
  }

  /**
   * Technical context — populated for canonical, OG, link issues.
   * Pulls from normalized table / list / chain currentState.
   * @private
   */
  _buildTechnicalContext(issueContext, normalizedCurrentState) {
    const issueId = issueContext.identity?.issueId || '';

    // ── Canonical ────────────────────────────────────────────────────────────
    if (issueId === 'canonical_tag_errors' || issueId === 'canonical_tags') {
      const rows = normalizedCurrentState.tableRows || [];
      const row  = rows[0] || {};
      return {
        canonicalUrl:        row.canonicalUrl || row['Canonical URL'] || null,
        pageUrl:             row.pageUrl      || row['Page URL']      || null,
        canonicalMatchStatus:row.matchStatus  || row['Match Status']  || null,
        ogFieldsPresent:     null,
        ogFieldsMissing:     null,
        inboundLinkCount:    null,
        potentialLinkers:    null,
      };
    }

    // ── OG Tags ──────────────────────────────────────────────────────────────
    if (
      issueId === 'og_tags_incomplete' ||
      issueId === 'og_tags_missing' ||
      issueId === 'og_tags' ||
      issueId === 'social_tags' ||
      issueId === 'og_social_tags'
    ) {
      const rows    = normalizedCurrentState.tableRows || [];
      const present = rows.filter(r => !_isMissingRow(r)).map(r => r.field || r.Field || '').filter(Boolean);
      const missing = rows.filter(r =>  _isMissingRow(r)).map(r => r.field || r.Field || '').filter(Boolean);
      return {
        canonicalUrl:        null,
        pageUrl:             null,
        canonicalMatchStatus:null,
        ogFieldsPresent:     present.length ? present : null,
        ogFieldsMissing:     missing.length ? missing : null,
        inboundLinkCount:    null,
        potentialLinkers:    null,
      };
    }

    // ── Security Headers ─────────────────────────────────────────────────────
    if (issueId === 'security_headers') {
      const items = normalizedCurrentState.listItems || [];
      const missing = items.map(item => item.replace(/^Missing:\s*/i, '').toLowerCase().replace(/-/g, '_'));
      return {
        canonicalUrl:        null,
        pageUrl:             null,
        canonicalMatchStatus:null,
        ogFieldsPresent:     null,
        ogFieldsMissing:     null,
        inboundLinkCount:    null,
        potentialLinkers:    null,
        securityHeadersMissing: missing.length ? missing : null,
        securityHeadersPresent: null,
      };
    }

    // ── Noindex Key Pages ────────────────────────────────────────────────────
    if (issueId === 'noindex_key_pages' || issueId === 'noindex_tags') {
      const items = normalizedCurrentState.listItems || [];
      const isNoindex = items.some(item => item.includes('noindex flag: YES') || item.includes('YES'));
      const robotsMeta = items.find(item => item.startsWith('robots meta:'))?.replace('robots meta: ', '') || null;
      return {
        canonicalUrl:        null,
        pageUrl:             null,
        canonicalMatchStatus:null,
        ogFieldsPresent:     null,
        ogFieldsMissing:     null,
        inboundLinkCount:    null,
        potentialLinkers:    null,
        isNoindex,
        robotsMeta,
      };
    }

    // ── Orphan Pages ─────────────────────────────────────────────────────────
    if (issueId === 'orphan_pages') {
      const items = normalizedCurrentState.listItems || [];
      const isOrphan = normalizedCurrentState._isOrphan ?? (normalizedCurrentState.inboundLinkCount === 0);
      return {
        canonicalUrl:        null,
        pageUrl:             issueContext.pageContext?.pageUrl || null,
        canonicalMatchStatus:null,
        ogFieldsPresent:     null,
        ogFieldsMissing:     null,
        inboundLinkCount:    normalizedCurrentState._inboundLinkCount ?? 0,
        potentialLinkers:    isOrphan && items.length ? items.slice(0, 5) : null,
        actualLinkers:       !isOrphan && items.length ? items.slice(0, 5) : null,
      };
    }

    // ── Topic Clusters ────────────────────────────────────────────────────────
    if (issueId === 'topic_clusters_internal_links') {
      const items = normalizedCurrentState.listItems || [];
      return {
        canonicalUrl:        null,
        pageUrl:             null,
        canonicalMatchStatus:null,
        ogFieldsPresent:     null,
        ogFieldsMissing:     null,
        inboundLinkCount:    null,
        potentialLinkers:    null,
        currentInternalLinks: items.length ? items : null,
        linkCount:           normalizedCurrentState.measurement?.value ?? items.length,
      };
    }

    // Generic technical context — return null if nothing specific
    return null;
  }

  /**
   * AI Visibility context — schema types, entity, score.
   * Pulls from issueContext.pageContext and the raw visibility data
   * if it was included in the extracted context.
   * @private
   */
  _buildAiVisibilityContext(issueContext) {
    const pc  = issueContext.pageContext || {};
    // The IssueContext doesn't directly carry AI visibility score or schema types
    // in a normalized way — those come from the extractor via pageContext enrichment.
    // Populate what's available; Phase 3 can enrich further from contextExtractor.
    const has = Boolean(pc.pageType && pc.pageType !== 'Unknown');
    if (!has) return null;

    return {
      schemaTypes:      null,     // enriched by contextExtractor in Phase 3
      entityName:       null,     // enriched by contextExtractor in Phase 3
      hasStructuredData:null,
      aiVisibilityScore:null,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * SHA256 hash of the IssueContext content — used as cache key component
   * and as contextHash in builderMeta.
   * Includes rawValue + displayType + issueId to detect state changes.
   * @private
   */
  _hashIssueContext(issueContext) {
    const cs      = issueContext.currentState || {};
    const rawVal  = cs.rawValue ?? cs.formattedValue ?? '';
    const parts   = [
      issueContext.identity?.issueId  || '',
      cs.displayType                  || '',
      typeof rawVal === 'string' ? rawVal.slice(0, 200) : JSON.stringify(rawVal).slice(0, 200),
      issueContext.metadata?.readinessScore ?? '',
      // A different verified logo / canonical / hierarchy must never be served a context built without it.
      issueContext.schemaEvidence?.fingerprintKey ?? '',
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  }

  /**
   * Returns true when there is actionable context beyond issue metadata.
   * @private
   */
  _hasRichContext(currentState, sectionsPopulated) {
    return Boolean(
      currentState.rawText ||
      currentState.tableRows?.length ||
      currentState.listItems?.length ||
      currentState.chainHops?.length ||
      currentState.codeContent ||
      sectionsPopulated.length > 0
    );
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _isMissingRow(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || row.Status || '');
  const value  = String(row.value  || row.Value  || '');
  return status === '✗' || value.toLowerCase() === 'missing' || status.toLowerCase() === 'missing';
}

/** Return first N words from a string. */
function _words(text, n) {
  if (!text || typeof text !== 'string') return null;
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return words.slice(0, n).join(' ') + '…';
}

export default new RecommendationContextBuilder();
