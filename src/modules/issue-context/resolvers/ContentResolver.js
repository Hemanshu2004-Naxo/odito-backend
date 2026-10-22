import { BaseResolver } from './BaseResolver.js';
import { DataPathResolver } from './DataPathResolver.js';

/**
 * ContentResolver
 *
 * Handles all content-related issue types:
 *   title, meta description, H1, headings, word count, keywords,
 *   pixel length, CTR, density, semantic subtopics, AEO signals,
 *   AI visibility content rules.
 */
export class ContentResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, issueDoc) {
    const {
      pageData,
      issuesByCode,
      visibilityData,
      issuesByRuleId,
      // Normalized convenience fields from PageDataExtractor
      metaDescription,    // actual meta description string (list normalized)
      headingsByTag,      // { h1: string[], h2: string[], ... }
      pageTitle,          // page title string
      firstH1,            // first H1 text string
    } = extracted;

    const onPageIssue = issuesByCode?.[issueId];
    const aiIssue = issuesByRuleId?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? aiIssue?.detected_value ?? null;

    // context dict stored by the Python worker alongside the issue document.
    // Contains pre-computed values: detected_length, target_min, target_max,
    // page_title, h1_text — ready to use without re-deriving.
    const issueContext = onPageIssue?.context ?? aiIssue?.context ?? {};

    switch (issueId) {

      // ─── Title ────────────────────────────────────────────────────────
      case 'title_missing': {
        return {
          currentState: this._absentState('title tag'),
          expectedState: this._expectedState('A descriptive title tag between 30–60 characters', 30, 60, 'characters'),
        };
      }
      case 'title_too_short': {
        // After Python fix: detectedFromDoc = actual title text.
        // Fallback: pageTitle from PageDataExtractor (normalized from seo_page_data.title).
        const displayText = pageTitle
          ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = displayText !== null
          ? displayText.length
          : (issueContext.detected_length ?? _parseFirstInt(detectedFromDoc));
        return {
          currentState: this._textState(displayText, actualLen, 'characters', 30, 60, 'Title'),
          expectedState: this._expectedState('Title between 30–60 characters', 30, 60, 'characters'),
        };
      }
      case 'title_too_long': {
        const displayText = pageTitle
          ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = displayText !== null
          ? displayText.length
          : (issueContext.detected_length ?? _parseFirstInt(detectedFromDoc));
        return {
          currentState: this._textState(displayText, actualLen, 'characters', 30, 60, 'Title'),
          expectedState: this._expectedState('Title 60 characters or fewer', 30, 60, 'characters'),
        };
      }
      case 'multiple_title_tags': {
        const titles = Array.isArray(detectedFromDoc) ? detectedFromDoc : [pageData?.title].filter(Boolean);
        return {
          currentState: this._listState(titles),
          expectedState: this._expectedState('Exactly one title tag per page'),
        };
      }
      case 'title_pixel_length': {
        const titleText = pageTitle ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const pixels = onPageIssue?.pixel_width ?? _parseFirstInt(onPageIssue?.issue_message) ?? null;
        if (!titleText) {
          // No title text available — metric-only fallback
          return {
            currentState: this._metricState(pixels ?? 0, 'px', 600),
            expectedState: this._expectedState('Title renders within 600px on desktop (≈ 60 characters)', null, 600, 'px'),
          };
        }
        // Title text is primary; pixel width (or character count) is the measurement
        const measureValue = pixels ?? titleText.length;
        const unit = pixels !== null ? 'px' : 'characters';
        const maxThreshold = pixels !== null ? 600 : 60;
        return {
          currentState: this._textState(titleText, measureValue, unit, null, maxThreshold, 'Title'),
          expectedState: this._expectedState('Title renders within 600px on desktop (≈ 60 characters)', null, 600, 'px'),
        };
      }

      // ─── Meta Description ─────────────────────────────────────────────
      //
      // Data resolution priority (highest → lowest):
      //   1. `metaDescription`  — normalized by PageDataExtractor from seo_page_data
      //                           (Python worker stores meta_tags.description as a list;
      //                            extractor normalises to string)
      //   2. `detectedFromDoc`  — stored in seo_page_issues.detected_value.
      //                           After Python fix: stores actual text.
      //                           Before fix (legacy): stores diagnostic string.
      //                           `_isActualText()` filters out legacy diagnostic strings.
      //   3. `issueContext.detected_length` — pre-computed length from context dict.
      //                           Used as the numeric length when we can't get the text.
      //   4. `_parseFirstInt(detectedFromDoc)` — parse first number from legacy string
      //                           as absolute last resort for length.

      case 'meta_description_missing': {
        return {
          currentState: this._absentState('meta description'),
          expectedState: this._expectedState('A descriptive meta description between 120–160 characters', 120, 160, 'characters'),
        };
      }

      case 'meta_description_too_short': {
        const displayText = metaDescription
          ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = displayText !== null
          ? displayText.length
          : (issueContext.detected_length ?? _parseFirstInt(detectedFromDoc));
        const state = this._textState(displayText, actualLen, 'characters', 120, 160, 'Meta Description');
        state.relatedContent = {
          pageTitle: issueContext.page_title ?? pageTitle,
          h1Text: issueContext.h1_text ?? firstH1,
        };
        return {
          currentState: state,
          expectedState: this._expectedState('Meta description between 120–160 characters', 120, 160, 'characters'),
        };
      }

      case 'meta_description_too_long': {
        const displayText = metaDescription
          ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = displayText !== null
          ? displayText.length
          : (issueContext.detected_length ?? _parseFirstInt(detectedFromDoc));
        const state = this._textState(displayText, actualLen, 'characters', 120, 160, 'Meta Description');
        state.relatedContent = {
          pageTitle: issueContext.page_title ?? pageTitle,
          h1Text: issueContext.h1_text ?? firstH1,
        };
        return {
          currentState: state,
          expectedState: this._expectedState('Meta description 160 characters or fewer', 120, 160, 'characters'),
        };
      }

      case 'multiple_meta_descriptions': {
        const descs = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        return {
          currentState: this._listState(descs),
          expectedState: this._expectedState('Exactly one meta description per page'),
        };
      }

      case 'meta_description_ctr': {
        const displayText = metaDescription
          ?? (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = displayText !== null
          ? displayText.length
          : (issueContext.detected_length ?? _parseFirstInt(detectedFromDoc));
        const state = this._textState(displayText, actualLen, 'characters', 120, 160, 'Meta Description');
        state.relatedContent = {
          pageTitle: issueContext.page_title ?? pageTitle,
          h1Text: issueContext.h1_text ?? firstH1,
        };
        return {
          currentState: state,
          expectedState: this._expectedState('Meta description with power words, a question or CTA, 120–160 characters', 120, 160, 'characters'),
        };
      }

      // ─── Technical Check: h1_tags (check.id from technicalChecks.service.js) ──
      // Maps to the same logic as h1_missing / multiple_h1_tags combined.
      case 'h1_tags': {
        const h1List = headingsByTag?.h1 || (firstH1 ? [firstH1] : []);
        if (h1List.length === 0) {
          return {
            currentState: this._absentState('H1 heading'),
            expectedState: this._expectedState('One H1 tag matching the page topic'),
          };
        }
        if (h1List.length > 1) {
          return {
            currentState: this._listState(h1List.map(String)),
            expectedState: this._expectedState('Exactly one H1 tag per page'),
          };
        }
        return {
          currentState: this._textState(h1List[0], null, null, null),
          expectedState: this._expectedState('H1 matches the primary topic and contains target keyword'),
        };
      }

      // ─── H1 ───────────────────────────────────────────────────────────
      case 'h1_missing': {
        return {
          currentState: this._absentState('H1 heading'),
          expectedState: this._expectedState('One H1 tag matching the page topic'),
        };
      }
      case 'multiple_h1_tags': {
        // After Python fix: detectedFromDoc = actual list of H1 texts.
        // Fallback: headingsByTag.h1 from PageDataExtractor.
        const h1List = Array.isArray(detectedFromDoc)
          ? detectedFromDoc
          : (headingsByTag?.h1 || []);
        return {
          currentState: this._listState(h1List),
          expectedState: this._expectedState('Exactly one H1 tag per page'),
        };
      }
      case 'keyword_not_in_h1': {
        const h1 = firstH1
          || (_isActualText(detectedFromDoc) ? detectedFromDoc : null)
          || null;
        return {
          currentState: this._textState(h1, h1 ? h1.length : null, 'characters', null, null, 'H1 Heading'),
          expectedState: this._expectedState('H1 contains the primary keyword'),
        };
      }

      // ─── Headings Structure ───────────────────────────────────────────
      case 'heading_hierarchy_skipped': {
        // headingsByTag is already normalized by PageDataExtractor: { h1: [], h2: [], ... }
        const nodes = _buildHeadingTree(headingsByTag || {});
        return {
          currentState: this._treeState(nodes),
          expectedState: this._expectedState('Sequential heading hierarchy: H1 → H2 → H3 (no skipped levels)'),
        };
      }
      case 'question_based_h2_headings': {
        const headings = visibilityData?.heading_metrics || {};
        const h2List = headings.h2_list || [];
        return {
          currentState: this._listState(h2List),
          expectedState: this._expectedState('H2 headings phrased as questions (who, what, how, why, when)'),
        };
      }

      // ─── Content Length ────────────────────────────────────────────────
      case 'thin_content': {
        // After Python fix: detectedFromDoc = numeric word count.
        // issueContext.word_count also has it pre-computed.
        // Fallback: pageData.word_count from seo_page_data.
        const wordCount = (typeof detectedFromDoc === 'number')
          ? detectedFromDoc
          : (issueContext.word_count ?? pageData?.word_count ?? _parseFirstInt(detectedFromDoc) ?? 0);
        // Content text from seo_page_data.content.text — truncate to first 300 words as preview
        const rawText = pageData?.content?.text ?? null;
        const preview = _contentPreview(rawText, 300);
        if (preview) {
          return {
            currentState: this._textState(preview, wordCount, 'words', 300, null, 'Content Preview'),
            expectedState: this._expectedState('300 or more words of meaningful content', 300, null, 'words'),
          };
        }
        // No content text available — metric-only fallback
        return {
          currentState: this._metricState(wordCount, 'words', 300),
          expectedState: this._expectedState('300 or more words of meaningful content', 300, null, 'words'),
        };
      }
      case 'service_pages_800_words': {
        const wordCount = visibilityData?.content_metrics?.word_count
          ?? _parseFirstInt(detectedFromDoc)
          ?? 0;
        return {
          currentState: this._metricState(wordCount, 'words', 800),
          expectedState: this._expectedState('800 or more words on service pages', 800, null, 'words'),
        };
      }
      case 'description_minimum_50_characters': {
        // Prefer actual schema description text; parse length as fallback
        const actualDesc = visibilityData?.metadata?.description
          || (_isActualText(detectedFromDoc) ? detectedFromDoc : null);
        const actualLen = actualDesc ? actualDesc.length : _parseFirstInt(detectedFromDoc);
        return {
          currentState: this._metricState(actualLen, 'characters', 50, actualDesc),
          expectedState: this._expectedState('Schema description field with 50 or more characters', 50, null, 'characters'),
        };
      }
      case 'short_paragraphs_3_to_5_lines': {
        const avgLen = visibilityData?.content_metrics?.avg_paragraph_length
          || (typeof detectedFromDoc === 'number' ? detectedFromDoc : null);
        return {
          currentState: this._metricState(avgLen, 'lines avg', 5),
          expectedState: this._expectedState('Average paragraph length 3–5 lines for AI parseability', 3, 5, 'lines'),
        };
      }

      // ─── Duplicate Content ────────────────────────────────────────────
      case 'duplicate_content': {
        const dupes = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        return {
          currentState: this._listState(dupes),
          expectedState: this._expectedState('Unique content — no duplicate pages'),
        };
      }

      // ─── AI Visibility — Content Rules ────────────────────────────────
      case 'clear_entity_first_150_words': {
        const first150 = visibilityData?.content_metrics?.first_150_words
          || (_isActualText(detectedFromDoc) ? detectedFromDoc : null)
          || null;
        return {
          currentState: this._textState(first150, first150 ? first150.length : null, 'characters', null, null, 'First 150 Words'),
          expectedState: this._expectedState('Primary entity (brand name) mentioned in first 150 words'),
        };
      }
      case 'first_60_words_direct_answer': {
        const first60 = visibilityData?.content_metrics?.first_60_words
          || (_isActualText(detectedFromDoc) ? detectedFromDoc : null)
          || null;
        return {
          currentState: this._textState(first60, first60 ? first60.length : null, 'characters', null, null, 'First 60 Words'),
          expectedState: this._expectedState('Direct answer to the page topic in first 60 words'),
        };
      }
      case 'semantic_html_tags_used': {
        const missing = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        return {
          currentState: this._listState(missing),
          expectedState: this._expectedState('Semantic HTML tags used: <article>, <main>, <section>, <nav>, <aside>'),
        };
      }
      case 'last_updated_date_visible': {
        return {
          currentState: this._absentState('dateModified or visible update date'),
          expectedState: this._expectedState('Visible update date or dateModified in schema'),
        };
      }
      case 'semantic_subtopics_covered': {
        const score = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(score, 'subtopics covered', null),
          expectedState: this._expectedState('Comprehensive subtopic coverage under main topic heading'),
        };
      }
      case 'statistics_have_source_links': {
        const count = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(count, 'unsourced statistics', 0),
          expectedState: this._expectedState('All statistics linked to an authoritative source', 0, 0, 'unsourced'),
        };
      }
      case 'faq_section_5_to_10_questions': {
        const qCount = typeof detectedFromDoc === 'number'
          ? detectedFromDoc
          : (visibilityData?.content_metrics?.faq_question_count || 0);
        return {
          currentState: this._metricState(qCount, 'FAQ questions', 5),
          expectedState: this._expectedState('FAQ section with 5–10 questions', 5, 10, 'questions'),
        };
      }
      case 'content_cites_sources': {
        const extLinks = typeof detectedFromDoc === 'number'
          ? detectedFromDoc
          : (visibilityData?.links?.external_count || 0);
        return {
          currentState: this._metricState(extLinks, 'external citations', 2),
          expectedState: this._expectedState('Content cites at least 2 external authoritative sources', 2, null, 'citations'),
        };
      }
      case 'bullet_numbered_lists_used': {
        const listCount = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(listCount, 'list elements', 3),
          expectedState: this._expectedState('3 or more bullet or numbered lists throughout content', 3, null, 'lists'),
        };
      }
      case 'comparison_tables_present': {
        const tableCount = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(tableCount, 'comparison tables', 1),
          expectedState: this._expectedState('At least 1 comparison table for comparison-intent content', 1, null, 'tables'),
        };
      }
      case 'conversational_tone': {
        const score = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(score, 'conversational score', 60),
          expectedState: this._expectedState('Conversational, direct language with first and second person pronouns'),
        };
      }
      case 'step_by_step_content': {
        const stepCount = typeof detectedFromDoc === 'number' ? detectedFromDoc : null;
        return {
          currentState: this._metricState(stepCount, 'numbered step structures', 1),
          expectedState: this._expectedState('Process content structured as numbered steps', 1, null, 'step structures'),
        };
      }

      default: {
        // Generic path resolution: use data_path to fetch the actual value from
        // seo_page_data (or seo_ai_visibility), so any issue type not listed above
        // still resolves real content instead of showing the diagnostic string.
        let resolvedValue = null;
        if (issueDoc?.data_path) {
          resolvedValue =
            DataPathResolver.resolveAsString(issueDoc.data_path, pageData, 'page_data') ??
            DataPathResolver.resolveAsString(issueDoc.data_path, visibilityData, 'ai_visibility');
        }
        const displayValue = resolvedValue ?? detectedFromDoc;
        return {
          currentState: this._textState(displayValue, null, null, null),
          expectedState: this._expectedState(
            aiIssue?.expected_value || onPageIssue?.expected_value || 'See issue description'
          ),
        };
      }
    }
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the value looks like actual content text
 * rather than a Python worker diagnostic message.
 *
 * Diagnostic messages look like:
 *   "Description length: 112 characters (minimum: 120)"
 *   "Title too short: 18 characters"
 *   "Word count: 247 (minimum: 300)"
 */
function _isActualText(val) {
  if (!val || typeof val !== 'string') return false;
  const diagnosticPatterns = [
    /length:\s*\d+\s*characters?/i,
    /\d+\s*characters?\s*\(minimum/i,
    /\d+\s*characters?\s*\(maximum/i,
    /^description length:/i,
    /^title length:/i,
    /^title too (short|long)/i,
    /^meta description too (short|long)/i,
    /^word count:/i,
    /pixels?\s*\(maximum/i,
  ];
  return !diagnosticPatterns.some(p => p.test(val.trim()));
}

/**
 * Extract the first integer from a diagnostic string.
 * "Description length: 112 characters (minimum: 120)" → 112
 * "Title too short: 18 characters" → 18
 */
function _parseFirstInt(val) {
  if (!val || typeof val !== 'string') return null;
  const m = val.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Returns the first maxWords words of a content string, with an ellipsis if truncated.
 * Returns null when input is absent or non-string.
 */
function _contentPreview(text, maxWords = 300) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(' ') + '…';
}

function _buildHeadingTree(headings) {
  const nodes = [];
  const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  for (const level of levels) {
    const items = headings[level];
    if (!items) continue;
    const texts = Array.isArray(items) ? items : [items];
    for (const text of texts) {
      nodes.push({ level: level.toUpperCase(), text: String(text) });
    }
  }
  return nodes;
}

export default new ContentResolver();
