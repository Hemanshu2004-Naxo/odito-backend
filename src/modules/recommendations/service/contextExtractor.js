import mongoose from 'mongoose';

/**
 * Context Extractor
 * 
 * Pulls page/issue context from EXISTING MongoDB data.
 * Supports BOTH issue sources:
 *   - seo_ai_visibility_issues (AI visibility rules, keyed by rule_id)
 *   - seo_page_issues (on-page SEO issues, keyed by issue_code / rule_id)
 * 
 * Also reads: seo_ai_visibility, seo_page_summary, seo_page_data
 * 
 * Produces context object used by fingerprint + template resolution.
 * pageUrl is extracted for sampleUrls reference but NOT included in context
 * (context drives fingerprinting, pageUrl would break dedup).
 */

// Issue source types
export const ISSUE_SOURCE = {
  AI_VISIBILITY:   'ai_visibility',   // seo_ai_visibility_issues collection
  ON_PAGE:         'on_page',         // seo_page_issues collection
  TECHNICAL_CHECK: 'technical_check', // domain_technical_reports / seo_page_data
};

const { ObjectId } = mongoose.Types;

class ContextExtractor {

  /**
   * Extract context for a specific page in a project.
   * Queries existing page data to determine pageType, framework, CMS, etc.
   * 
   * @param {string} projectId - Project ID
   * @param {string} pageUrl - Page URL (for data lookup, NOT stored in context)
   * @returns {Promise<Object>} { context, pageUrl }
   */
  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectObjectId = new ObjectId(projectId);

    // Query multiple sources in parallel for speed
    const [aiVisData, pageSummary, pageData] = await Promise.all([
      db.collection('seo_ai_visibility').findOne({
        projectId: projectObjectId,
        page_url: pageUrl,
      }),
      db.collection('seo_page_summary').findOne({
        projectId: projectObjectId,
        page_url: pageUrl,
      }),
      db.collection('seo_page_data').findOne({
        projectId: projectObjectId,
        page_url: pageUrl,
      }),
    ]);

    const context = this._buildContext(aiVisData, pageSummary, pageData);
    return { context, pageUrl };
  }

  /**
   * Extract context for an AI visibility rule across all affected pages.
   *
   * Phase 4: used to source sampleUrls from seo_ai_visibility_issues
   * (keyed by rule_id) — that collection is confirmed dead (zero writers
   * anywhere in the codebase; see project_ai_visibility_cleanup memory).
   * This path is only reachable today for legacy pre-V2 rule_ids (nothing
   * currently live sends one), and the query could only ever return zero
   * rows, so sampleUrls is now empty directly instead of via a wasted
   * query — the function's behavior (early-return with a default context)
   * is unchanged.
   *
   * @param {string} projectId - Project ID (unused now — kept for call-site signature compatibility)
   * @param {string} ruleId - Rule ID (unused now — kept for call-site signature compatibility)
   * @returns {Promise<Object>} { context, sampleUrls, issueSource }
   */
  async extractForRule(projectId, ruleId) {
    // With sampleUrls always empty (see docblock above), every branch that
    // depended on a non-empty result is now permanently unreachable —
    // removed rather than left as dead code behind an if that can never be
    // false.
    return {
      context: this._defaultContext(),
      sampleUrls: [],
      issueSource: ISSUE_SOURCE.AI_VISIBILITY,
    };
  }

  /**
   * Extract context for an on-page SEO issue across all affected pages.
   * Source: seo_page_issues (keyed by issue_code)
   * 
   * @param {string} projectId - Project ID
   * @param {string} issueCode - Issue code (e.g. META_DESC_MISSING)
   * @returns {Promise<Object>} { context, sampleUrls, issueSource }
   */
  async extractForIssueCode(projectId, issueCode) {
    const db = mongoose.connection.db;
    const projectObjectId = new ObjectId(projectId);

    // Get sample affected pages from on-page issues
    const affectedPages = await db.collection('seo_page_issues')
      .find({ projectId: projectObjectId, issue_code: issueCode })
      .limit(10)
      .project({ page_url: 1 })
      .toArray();

    const sampleUrls = affectedPages.map(p => p.page_url);

    if (sampleUrls.length === 0) {
      return {
        context: this._defaultContext(),
        sampleUrls: [],
        issueSource: ISSUE_SOURCE.ON_PAGE,
      };
    }

    // Get page data for first affected page (representative)
    const [aiVisData, pageSummary, pageData] = await Promise.all([
      db.collection('seo_ai_visibility').findOne({
        projectId: projectObjectId,
        page_url: sampleUrls[0],
      }),
      db.collection('seo_page_summary').findOne({
        projectId: projectObjectId,
        page_url: sampleUrls[0],
      }),
      db.collection('seo_page_data').findOne({
        projectId: projectObjectId,
        page_url: sampleUrls[0],
      }),
    ]);

    // Detect dominant page type from page data or page summary
    const dominantPageType = await this._getDominantPageTypeFromSummary(db, projectObjectId, sampleUrls);

    const context = this._buildContext(aiVisData, pageSummary, pageData, dominantPageType);
    return { context, sampleUrls, issueSource: ISSUE_SOURCE.ON_PAGE };
  }

  /**
   * Universal extractor — auto-detects issue source.
   *
   * V2 hub issues (AISO-*, AEO-*, GEO-*) always route to extractForV2Issue(),
   * which reads ai_issues + ai_pages (never legacy seo_ai_visibility_issues).
   *
   * Legacy on-page / ai_visibility issues use their existing paths unchanged.
   *
   * @param {string} projectId - Project ID
   * @param {string} issueId - Rule ID or issue code
   * @param {string} [source] - Optional hint: 'ai_visibility' | 'on_page'
   * @returns {Promise<Object>} { context, sampleUrls, issueSource }
   */
  async extractForIssue(projectId, issueId, source = null) {
    // V2 hub issues bypass the legacy seo_ai_visibility_issues collection entirely
    if (_isV2HubIssue(issueId)) {
      return this.extractForV2Issue(projectId, issueId);
    }

    if (source === ISSUE_SOURCE.ON_PAGE) {
      return this.extractForIssueCode(projectId, issueId);
    }
    if (source === ISSUE_SOURCE.AI_VISIBILITY) {
      return this.extractForRule(projectId, issueId);
    }

    // Auto-detect: try AI visibility first, then on-page
    const aiResult = await this.extractForRule(projectId, issueId);
    if (aiResult.sampleUrls.length > 0) {
      return aiResult;
    }

    return this.extractForIssueCode(projectId, issueId);
  }

  /**
   * V2 issue extractor — queries ai_issues + ai_pages for V2 hub rules.
   *
   * Provides sampleUrls from all pages where this rule currently FAILs, and
   * builds a context object from the first affected page's ai_pages document.
   * Uses ai_projects to scope to the latest scan job.
   *
   * @param {string} projectId
   * @param {string} ruleId - e.g. "AEO-055", "AISO-A2", "GEO-G1"
   * @returns {Promise<{ context, sampleUrls, issueSource }>}
   */
  async extractForV2Issue(projectId, ruleId) {
    const db  = mongoose.connection.db;
    const pid = new ObjectId(projectId);

    // Resolve the latest completed job so we only surface current issues
    const latestJob = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();
    const jobId = latestJob?.job_id ?? null;

    const issueFilter = jobId
      ? { project_id: pid, job_id: jobId, rule_id: ruleId }
      : { project_id: pid, rule_id: ruleId };

    const affectedIssues = await db.collection('ai_issues')
      .find(issueFilter)
      .limit(10)
      .project({ url: 1 })
      .toArray();

    const sampleUrls = affectedIssues.map(i => i.url).filter(Boolean);

    if (sampleUrls.length === 0) {
      return {
        context:     this._defaultContext(),
        sampleUrls:  [],
        issueSource: ISSUE_SOURCE.AI_VISIBILITY,
      };
    }

    // Build context from the first affected page's V2 page document
    const pageFilter = jobId
      ? { project_id: pid, job_id: jobId, url: sampleUrls[0] }
      : { project_id: pid, url: sampleUrls[0] };

    const pageDoc = await db.collection('ai_pages').findOne(pageFilter, {
      projection: {
        'technical.framework':             1,
        'technical.cms':                   1,
        'page_type_properties.detected_type': 1,
        word_count:                        1,
        structured_data:                   1,
      },
    });

    return {
      context:     this._buildContextFromV2Page(pageDoc),
      sampleUrls,
      issueSource: ISSUE_SOURCE.AI_VISIBILITY,
    };
  }

  /**
   * V2 page-level extractor — returns context for a specific URL from ai_pages.
   *
   * Called when pageUrl is provided and the issue is a V2 hub issue.
   * Parallel to the existing extract() which reads from seo_ai_visibility.
   *
   * @param {string} projectId
   * @param {string} pageUrl
   * @returns {Promise<{ context, pageUrl }>}
   */
  async extractForV2Page(projectId, pageUrl) {
    const db  = mongoose.connection.db;
    const pid = new ObjectId(projectId);

    const latestJob = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();
    const jobId = latestJob?.job_id ?? null;

    const pageFilter = jobId
      ? { project_id: pid, job_id: jobId, url: pageUrl }
      : { project_id: pid, url: pageUrl };

    const pageDoc = await db.collection('ai_pages').findOne(pageFilter, {
      projection: {
        'technical.framework':             1,
        'technical.cms':                   1,
        'page_type_properties.detected_type': 1,
        word_count:                        1,
        structured_data:                   1,
      },
    });

    return { context: this._buildContextFromV2Page(pageDoc), pageUrl };
  }

  /**
   * Build a context object from a V2 ai_pages document.
   * Returns a default context when the document is not found.
   * @private
   */
  _buildContextFromV2Page(pageDoc) {
    if (!pageDoc) return this._defaultContext();

    const schemaTypes = Array.isArray(pageDoc.structured_data)
      ? pageDoc.structured_data.map(s => s['@type']).filter(Boolean)
      : [];

    return {
      pageType:        pageDoc.page_type_properties?.detected_type || 'Unknown',
      framework:       pageDoc.technical?.framework  || 'unknown',
      cms:             pageDoc.technical?.cms        || null,
      detectedSchemas: schemaTypes,
      wordCount:       pageDoc.word_count            || 0,
    };
  }

  /**
   * Build context object from raw page data.
   * Merges signals from AI visibility data, page summary, and page data.
   * @private
   * 
   * @param {Object|null} aiVisData - From seo_ai_visibility collection
   * @param {Object|null} pageSummary - From seo_page_summary collection
   * @param {Object|null} pageData - From seo_page_data collection
   * @param {string|null} dominantPageType - Override page type
   */
  _buildContext(aiVisData, pageSummary, pageData = null, dominantPageType = null) {
    const context = {
      pageType: 'Unknown',
      framework: 'unknown',
      cms: null,
      detectedSchemas: [],
      wordCount: 0,
    };

    // Extract from AI visibility data (richest source for AI-related context)
    if (aiVisData) {
      const ns = aiVisData.normalized_signals || aiVisData.ai_visibility?.normalized_signals || {};
      const ptInfo = ns.page_type || aiVisData.page_type_properties || {};
      context.pageType = ptInfo.detected_type || 'Unknown';

      const schemas = ns.schema_types || aiVisData.ai_visibility?.schema_types || [];
      context.detectedSchemas = Array.isArray(schemas) ? schemas : [];

      context.wordCount = ns.word_count || aiVisData.word_count || 0;
    }

    // Fallback/enrich from seo_page_data (on-page analysis results)
    if (pageData) {
      if (context.wordCount === 0) {
        context.wordCount = pageData.word_count || 0;
      }
      // page_data may have title, h1, meta info useful for context
      if (context.pageType === 'Unknown' && pageData.page_type) {
        context.pageType = pageData.page_type;
      }
    }

    // Override with dominant page type if provided
    if (dominantPageType && dominantPageType !== 'Unknown') {
      context.pageType = dominantPageType;
    }

    // Framework/CMS detection from page summary
    if (pageSummary) {
      context.framework = this._detectFramework(pageSummary);
      context.cms = this._detectCMS(pageSummary);
      // Fallback word count from summary
      if (context.wordCount === 0) {
        context.wordCount = pageSummary.word_count || 0;
      }
    }

    return context;
  }

  /**
   * Detect framework from page summary signals.
   * @private
   */
  _detectFramework(pageSummary) {
    const html = (pageSummary.raw_html || '').toLowerCase();
    const headers = pageSummary.response_headers || {};
    const generator = pageSummary.meta_generator || '';

    if (generator.includes('Next.js') || html.includes('__next')) return 'nextjs';
    if (generator.includes('WordPress') || html.includes('wp-content')) return 'wordpress';
    if (html.includes('shopify') || headers['x-shopify-stage']) return 'shopify';
    if (html.includes('__nuxt') || html.includes('nuxt')) return 'nuxtjs';
    if (html.includes('gatsby')) return 'gatsby';
    if (html.includes('react') || html.includes('_app')) return 'react';
    return 'unknown';
  }

  /**
   * Detect CMS from page summary signals.
   * @private
   */
  _detectCMS(pageSummary) {
    const html = (pageSummary.raw_html || '').toLowerCase();
    const generator = pageSummary.meta_generator || '';

    if (generator.includes('WordPress') || html.includes('wp-content')) return 'wordpress';
    if (html.includes('shopify')) return 'shopify';
    if (html.includes('squarespace')) return 'squarespace';
    if (html.includes('wix')) return 'wix';
    if (html.includes('webflow')) return 'webflow';
    if (html.includes('drupal')) return 'drupal';
    return null;
  }

  /**
   * Get dominant page type from a set of URLs using AI visibility data.
   * Used for AI visibility issues.
   * @private
   */
  async _getDominantPageType(db, projectObjectId, urls) {
    if (!urls.length) return 'Unknown';

    const result = await db.collection('seo_ai_visibility').aggregate([
      {
        $match: {
          projectId: projectObjectId,
          page_url: { $in: urls },
        },
      },
      {
        $group: {
          _id: {
            $ifNull: [
              '$normalized_signals.page_type.detected_type',
              '$page_type_properties.detected_type',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]).toArray();

    return result.length > 0 ? (result[0]._id || 'Unknown') : 'Unknown';
  }

  /**
   * Get dominant page type from page summary/page data collections.
   * Used for on-page SEO issues when AI visibility data may not exist.
   * Falls back to URL pattern matching.
   * @private
   */
  async _getDominantPageTypeFromSummary(db, projectObjectId, urls) {
    if (!urls.length) return 'Unknown';

    // Try AI visibility first (it has the best page type detection)
    const aiResult = await this._getDominantPageType(db, projectObjectId, urls);
    if (aiResult !== 'Unknown') return aiResult;

    // Fallback: infer from URL patterns
    const patterns = {
      Homepage: urls.filter(u => u === '/' || u.endsWith('.com') || u.endsWith('.com/')),
      Article: urls.filter(u => u.includes('/blog/') || u.includes('/post/') || u.includes('/article/')),
      Product: urls.filter(u => u.includes('/product/') || u.includes('/shop/')),
      Service: urls.filter(u => u.includes('/service') || u.includes('/solutions/')),
      Listing: urls.filter(u => u.includes('/category/') || u.includes('/tag/')),
    };

    let maxCount = 0;
    let dominantType = 'Unknown';
    for (const [type, matched] of Object.entries(patterns)) {
      if (matched.length > maxCount) {
        maxCount = matched.length;
        dominantType = type;
      }
    }

    return dominantType;
  }

  /**
   * Default context when no data is available.
   * @private
   */
  _defaultContext() {
    return {
      pageType: 'Unknown',
      framework: 'unknown',
      cms: null,
      detectedSchemas: [],
      wordCount: 0,
    };
  }
}

/**
 * Returns true for V2 hub rule IDs: AISO-*, AEO-*, GEO-*.
 * Module-level so it can be used both inside extractForIssue() and by callers
 * that need the same check (e.g. recommendationService.js).
 */
function _isV2HubIssue(issueId) {
  return /^(AISO|AEO|GEO)-/i.test(issueId);
}

export default new ContextExtractor();
