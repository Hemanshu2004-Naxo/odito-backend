import mongoose from 'mongoose';
import {
  normalizeFrameworkString,
  normalizePageTypeString,
  detectPageType,
} from '../../audit/services/PageTypeDetector.js';

const { ObjectId } = mongoose.Types;

/**
 * PageDataExtractor
 *
 * Fetches the seo_page_data document for a specific project + URL.
 * Also fetches the seo_page_issues documents for that URL so resolvers
 * have access to detected_value / expected_value / context stored at scan time.
 *
 * Normalization applied here:
 *   - meta_tags.description is stored as a list by the Python worker.
 *     We expose a normalized `metaDescription` string field (first item).
 *   - headings may be stored as [{tag, text}] list or as {h1:[...], h2:[...]} dict.
 *     We expose a normalized `headingsByTag` dict for both formats.
 *   - title is a plain string — no normalization needed.
 *   - page_context (new structured field) is normalized into flat strings
 *     (framework, cms, pageType) for backward compat with all consumers.
 */
export class PageDataExtractor {
  constructor() {
    this.name = 'page_data';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const [pageData, pageIssues] = await Promise.all([
      db.collection('seo_page_data').findOne(
        { projectId: projectIdObj, url: pageUrl },
        {
          projection: {
            title: 1,
            meta_tags: 1,
            content: 1,
            headings: 1,
            images: 1,
            links: 1,
            structured_data: 1,
            og_tags: 1,
            canonical: 1,
            url: 1,
            word_count: 1,
            primary_keyword: 1,
            language: 1,
            page_type: 1,
            page_type_confidence: 1,
            framework: 1,
            cms: 1,
            tracking: 1,
            http_status: 1,
            mixed_content_urls: 1,
            iframe_src: 1,
            // Structured context enrichment (populated by Python context_enrichment.py)
            page_context: 1,
            // FAQ Q/A pairs + detection counters (enhanced_seo_extraction.py) —
            // read by SchemaResolver's faq_schema case via faqSchema.getFaqDetection.
            faq_howto_signals: 1,
            // Visible rating figures (rating_extraction.py) — read by SchemaResolver's
            // aggregate_rating_schema case via aggregateRatingSchema.getRatingDetection.
            rating_signals: 1,
          },
        }
      ),
      db.collection('seo_page_issues')
        .find({ projectId: projectIdObj, page_url: pageUrl })
        .project({
          issue_code: 1,
          rule_id: 1,
          detected_value: 1,
          expected_value: 1,
          data_key: 1,
          data_path: 1,
          severity: 1,
          category: 1,
          issue_message: 1,
          recommendation: 1,
          context: 1,           // pre-computed metrics stored by the Python worker
        })
        .toArray(),
    ]);

    // ── Normalize meta description ────────────────────────────────────────
    // Python worker stores meta_tags.description as a list of strings.
    // Expose a normalised string so resolvers don't need to handle both formats.
    let metaDescription = null;
    if (pageData) {
      const rawDesc = pageData.meta_tags?.description;
      if (Array.isArray(rawDesc)) {
        metaDescription = rawDesc[0] || null;
      } else if (typeof rawDesc === 'string') {
        metaDescription = rawDesc || null;
      }
    }

    // ── Normalize headings ────────────────────────────────────────────────
    // Three storage formats depending on which worker last wrote the document:
    //   A) pageData.headings = [{tag:'h1', text:'...'}, ...]   (flat list — page_analysis normalized)
    //   B) pageData.headings = {h1:['text1'], h2:['text2']}    (top-level dict)
    //   C) pageData.content.headings = {h1:['text1'], h2:[...]} (primary format — scraper/shared/seo.py)
    // Produce headingsByTag = { h1: string[], h2: string[], ... } from whichever is present.
    let headingsByTag = {};
    if (pageData) {
      const raw = pageData.headings;
      const contentHeadings = pageData.content?.headings;

      if (Array.isArray(raw) && raw.length > 0) {
        // Format A: flat list of {tag, text}
        for (const h of raw) {
          const tag = (h.tag || '').toLowerCase();
          if (!tag) continue;
          if (!headingsByTag[tag]) headingsByTag[tag] = [];
          const text = (h.text || '').trim();
          if (text) headingsByTag[tag].push(text);
        }
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // Format B: top-level dict
        for (const [tag, texts] of Object.entries(raw)) {
          headingsByTag[tag.toLowerCase()] = Array.isArray(texts) ? texts : [texts].filter(Boolean);
        }
      } else if (contentHeadings && typeof contentHeadings === 'object' && !Array.isArray(contentHeadings)) {
        // Format C: content.headings dict — the canonical format written by extract_content_analysis()
        for (const [tag, texts] of Object.entries(contentHeadings)) {
          headingsByTag[tag.toLowerCase()] = Array.isArray(texts) ? texts : [texts].filter(Boolean);
        }
      }
    }

    // ── Issue lookup ──────────────────────────────────────────────────────
    // Build a quick lookup: issue_code → issue doc (includes context field).
    const issuesByCode = {};
    for (const issue of pageIssues) {
      issuesByCode[issue.issue_code || issue.rule_id] = issue;
    }

    // ── Normalize page_context ────────────────────────────────────────────
    // The Python context_enrichment layer stores structured dicts in page_context.
    // Older records have flat string fields (framework, cms, page_type) instead.
    // We normalize both into flat canonical strings for all downstream consumers,
    // and also expose the full structured object for consumers that want confidence.
    let normalizedFramework = 'unknown';
    let normalizedCms       = null;
    let normalizedPageType  = 'Unknown';
    let pageContextRaw      = null;

    if (pageData) {
      const pc = pageData.page_context;  // new structured field

      if (pc) {
        pageContextRaw      = pc;
        normalizedFramework = normalizeFrameworkString(pc.framework, 'unknown');
        normalizedCms       = pc.cms?.name || null;
        normalizedPageType  = normalizePageTypeString(pc.pageType, 'Unknown');
      } else {
        // Fall back to legacy flat fields
        normalizedFramework = normalizeFrameworkString(pageData.framework, 'unknown');
        normalizedCms       = typeof pageData.cms === 'string' ? pageData.cms : pageData.cms?.name || null;
        normalizedPageType  = normalizePageTypeString(pageData.page_type, null)
          || _detectPageTypeFallback(pageUrl, pageData);
      }
    }

    return {
      pageData,
      pageIssues,
      issuesByCode,
      // Normalized convenience fields
      metaDescription,
      headingsByTag,
      pageTitle:        pageData?.title || null,
      firstH1:          headingsByTag.h1?.[0] || null,
      primaryKeyword:   pageData?.primary_keyword || null,
      // Normalized context enrichment fields — directly fetchable, no nesting needed
      framework:          normalizedFramework,
      cms:                normalizedCms,
      pageType:           normalizedPageType,
      pageTypeConfidence: pageData?.page_type_confidence ?? pageContextRaw?.pageType?.confidence ?? null,
      pageContextRaw,     // full structured object for consumers that want all signals
    };
  }
}

/**
 * Last-resort page type detection when the DB has neither page_context nor page_type.
 * Only uses URL heuristics — no HTML access at this layer.
 * @private
 */
function _detectPageTypeFallback(pageUrl, pageData) {
  if (!pageUrl) return 'Unknown';
  const title = pageData?.title || '';
  const firstH1 = pageData?.content?.headings?.h1?.[0] || '';
  const result = detectPageType({ url: pageUrl, title, h1: firstH1 });
  return result.confidence >= 65 ? result.name : 'Unknown';
}

export default new PageDataExtractor();
