import mongoose from 'mongoose';
import { getRegistryEntry, RESOLVER } from './ResolverRegistry.js';
import { DATA_SOURCE } from './ResolverRegistry.js';
import IssueContextValidator from './IssueContextValidator.js';

// Extractors
import PageDataExtractor from '../extractors/PageDataExtractor.js';
import AIVisibilityExtractor from '../extractors/AIVisibilityExtractor.js';
import HeadlessExtractor from '../extractors/HeadlessExtractor.js';
import CrawlGraphExtractor from '../extractors/CrawlGraphExtractor.js';
import TechnicalReportExtractor from '../extractors/TechnicalReportExtractor.js';
import V2IssueExtractor from '../extractors/V2IssueExtractor.js';

// Resolvers
import ContentResolver from '../resolvers/ContentResolver.js';
import ImageResolver from '../resolvers/ImageResolver.js';
import SchemaResolver from '../resolvers/SchemaResolver.js';
import AccessibilityResolver from '../resolvers/AccessibilityResolver.js';
import TechnicalResolver from '../resolvers/TechnicalResolver.js';
import EntityResolver from '../resolvers/EntityResolver.js';
import V2IssueResolver from '../resolvers/V2IssueResolver.js';

const EXTRACTOR_MAP = {
  [DATA_SOURCE.PAGE_DATA]:    PageDataExtractor,
  [DATA_SOURCE.AI_VISIBILITY]:AIVisibilityExtractor,
  [DATA_SOURCE.HEADLESS]:     HeadlessExtractor,
  [DATA_SOURCE.CRAWL_GRAPH]:  CrawlGraphExtractor,
  [DATA_SOURCE.TECHNICAL]:    TechnicalReportExtractor,
};

const RESOLVER_MAP = {
  [RESOLVER.CONTENT]:       ContentResolver,
  [RESOLVER.IMAGE]:         ImageResolver,
  [RESOLVER.SCHEMA]:        SchemaResolver,
  [RESOLVER.ACCESSIBILITY]: AccessibilityResolver,
  [RESOLVER.TECHNICAL]:     TechnicalResolver,
  [RESOLVER.ENTITY]:        EntityResolver,
};

/**
 * IssueContextEngine
 *
 * Main orchestrator. Given (projectId, issueId, pageUrl):
 *   1. Look up the registry for resolver + required data sources
 *   2. Fetch only required data sources in parallel
 *   3. Delegate to the appropriate grouped resolver
 *   4. Validate completeness
 *   5. Return a complete IssueContext object
 */
class IssueContextEngine {
  /**
   * Resolve context for a single issue + page.
   *
   * @param {string} projectId
   * @param {string} issueId   — issue_code (on_page) or rule_id (ai_visibility)
   * @param {string} pageUrl
   * @returns {Promise<IssueContext>}
   */
  async resolve(projectId, issueId, pageUrl) {
    const startMs = Date.now();

    // V2 fast path: AISO-*, AEO-*, GEO-* bypass the legacy ResolverRegistry entirely.
    if (_isV2HubIssue(issueId)) {
      return this._resolveV2(projectId, issueId, pageUrl, startMs);
    }

    const entry = getRegistryEntry(issueId);

    // For unknown issues: return a minimal context so the UI can still render
    if (!entry) {
      console.warn(`[ISSUE_CONTEXT] Unknown issueId: ${issueId} — returning minimal context`);
      return await this._unknownContext(projectId, issueId, pageUrl, startMs);
    }

    const { resolver: resolverKey, dataSources, displayType, issueType } = entry;

    // ── Step 1: Parallel data fetch ─────────────────────────────────────
    const extractedData = await this._fetchDataSources(projectId, pageUrl, dataSources);

    // ── Step 2: Build issueDoc (raw issue from DB) ──────────────────────
    const issueDoc = this._pickIssueDoc(issueId, issueType, extractedData);

    // ── Step 3: Resolve currentState + expectedState ─────────────────────
    const resolver = RESOLVER_MAP[resolverKey];
    let currentState, expectedState, contextExtras = {};

    try {
      const result = resolver.resolve(issueId, displayType, extractedData, issueDoc);
      currentState = result.currentState;
      expectedState = result.expectedState;
      // Optional issue-specific structured payload (e.g. faqDetection for
      // faq_schema). Merged below without ever overriding a core context key.
      contextExtras = result.contextExtras || {};
    } catch (err) {
      console.error(`[ISSUE_CONTEXT] Resolver error for ${issueId}:`, err.message);
      currentState = {
        displayType: 'absent',
        rawValue: null,
        formattedValue: null,
        measurement: { value: null, unit: null, threshold: null },
        affectedItems: [],
        isAbsent: true,
        checkedFor: issueId,
      };
      expectedState = { description: 'Unable to resolve current state', measurement: {} };
    }

    // ── Step 4: Build page context ───────────────────────────────────────
    const pageContext = this._buildPageContext(pageUrl, extractedData);

    // ── Step 5: Assemble IssueContext ────────────────────────────────────
    const context = {
      identity: {
        issueId,
        issueType,
        category: issueDoc?.category || '',
        severity: issueDoc?.severity || '',
        pipeline: issueType,
      },
      currentState,
      expectedState,
      pageContext,
      metadata: {
        projectId,
        resolvedAt: new Date().toISOString(),
        resolutionMs: Date.now() - startMs,
        dataSources,
        readinessScore: 0,
        missingSignals: [],
        warnings: [],
      },
      recommendationReady: false,
    };
    for (const [key, value] of Object.entries(contextExtras)) {
      if (!(key in context)) context[key] = value;
    }

    // ── Step 6: Validate ─────────────────────────────────────────────────
    const validation = IssueContextValidator.validate(context);
    context.metadata.readinessScore = validation.readinessScore;
    context.metadata.missingSignals = validation.missingSignals;
    context.metadata.warnings = validation.warnings;
    context.recommendationReady = validation.recommendationReady;

    console.log(
      `[ISSUE_CONTEXT] Resolved ${issueId} | page=${pageUrl} | ` +
      `readiness=${validation.readinessScore} | ${Date.now() - startMs}ms`
    );

    return context;
  }

  /**
   * Resolve context for multiple pages of the same issue (batch).
   * Runs resolvals in parallel up to a concurrency cap.
   *
   * @param {string}   projectId
   * @param {string}   issueId
   * @param {string[]} pageUrls
   * @param {number}   concurrency
   * @returns {Promise<IssueContext[]>}
   */
  async resolveBatch(projectId, issueId, pageUrls, concurrency = 10) {
    const results = [];
    for (let i = 0; i < pageUrls.length; i += concurrency) {
      const slice = pageUrls.slice(i, i + concurrency);
      const batch = await Promise.all(
        slice.map(url => this.resolve(projectId, issueId, url))
      );
      results.push(...batch);
    }
    return results;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  async _fetchDataSources(projectId, pageUrl, dataSources) {
    // PAGE_DATA is always included regardless of what the registry declares.
    // It carries page_context (framework, cms, pageType) that _buildPageContext
    // needs for every issue type — including AI Visibility issues which only
    // list DATA_SOURCE.AI_VISIBILITY and therefore previously had no pageData.
    // Set deduplication means On-Page issues (which already list PAGE_DATA) are
    // unaffected — no extra query is added for them.
    const allSources = [...new Set([DATA_SOURCE.PAGE_DATA, ...dataSources])];

    const fetchTasks = allSources.map(source => {
      const extractor = EXTRACTOR_MAP[source];
      if (!extractor) return Promise.resolve({});
      return extractor.extract(projectId, pageUrl).catch(err => {
        console.warn(`[ISSUE_CONTEXT] Extractor ${source} failed:`, err.message);
        return {};
      });
    });

    const results = await Promise.all(fetchTasks);

    // Merge all extractor outputs into one flat object
    return Object.assign({}, ...results);
  }

  _pickIssueDoc(issueId, issueType, extracted) {
    if (issueType === 'on_page') {
      return extracted.issuesByCode?.[issueId] || null;
    }
    return extracted.issuesByRuleId?.[issueId] || null;
  }

  _buildPageContext(pageUrl, extracted) {
    const pageData       = extracted.pageData       || {};
    const visibilityData = extracted.visibilityData || {};
    const pageTypeProps  = visibilityData.page_type_properties || {};

    // PageDataExtractor normalizes framework/cms/pageType into flat strings,
    // resolving both the new structured page_context field AND legacy flat fields.
    // Prefer those normalized values; fall back to raw pageData fields.
    const framework = extracted.framework
      || (typeof pageData.framework === 'string' ? pageData.framework : pageData.framework?.key)
      || 'unknown';

    const cms = extracted.cms
      || (typeof pageData.cms === 'string' ? pageData.cms : pageData.cms?.name)
      || null;

    const pageType = pageTypeProps.detected_type
      || extracted.pageType
      || (typeof pageData.page_type === 'string' ? pageData.page_type : pageData.page_type?.name)
      || 'Unknown';

    return {
      pageUrl,
      pageType,
      framework,
      cms,
      canonicalUrl: pageData.canonical || null,
    };
  }

  // ─── V2 resolution path ────────────────────────────────────────────────────

  /**
   * Resolve context for a V2 hub issue (AISO-*, AEO-*, GEO-*).
   *
   * Queries ai_issues + ai_pages directly — no ResolverRegistry lookup.
   */
  async _resolveV2(projectId, issueId, pageUrl, startMs) {
    let issueDoc, pageDoc;

    try {
      ({ issueDoc, pageDoc } = await V2IssueExtractor.extract(projectId, issueId, pageUrl));
    } catch (err) {
      console.warn(`[ISSUE_CONTEXT] V2 extractor failed for ${issueId}:`, err.message);
      issueDoc = null;
      pageDoc  = null;
    }

    const { currentState, expectedState } = V2IssueResolver.resolve(issueDoc, issueId);
    const pageContext = this._buildV2PageContext(pageUrl, pageDoc);

    // Derive hub from the rule ID prefix (AISO → aiso, AEO → aeo, GEO → geo).
    const hub      = issueId.split('-')[0].toLowerCase();
    const category = issueDoc?.card     || hub;
    const severity = issueDoc?.severity || '';

    const context = {
      identity: {
        issueId,
        issueType:  'ai_visibility',
        category,
        severity,
        // Keep pipeline as 'ai_visibility' so CurrentStateRenderer shows the
        // correct '✦ AI Visibility' badge without needing a frontend change.
        // The specific hub (aiso/aeo/geo) is derivable from issueId itself.
        pipeline:   'ai_visibility',
        hub,
      },
      currentState,
      expectedState,
      pageContext,
      metadata: {
        projectId,
        resolvedAt:    new Date().toISOString(),
        resolutionMs:  Date.now() - startMs,
        dataSources:   ['ai_issues', 'ai_pages'],
        readinessScore: 0,
        missingSignals: [],
        warnings:       [],
      },
      recommendationReady: false,
    };

    const validation = IssueContextValidator.validate(context);
    context.metadata.readinessScore  = validation.readinessScore;
    context.metadata.missingSignals  = validation.missingSignals;
    context.metadata.warnings        = validation.warnings;
    context.recommendationReady      = validation.recommendationReady;

    console.log(
      `[ISSUE_CONTEXT] V2 resolved ${issueId} | page=${pageUrl} | ` +
      `readiness=${validation.readinessScore} | ${Date.now() - startMs}ms`
    );

    return context;
  }

  _buildV2PageContext(pageUrl, pageDoc) {
    return {
      pageUrl,
      pageType:     pageDoc?.page_type_properties?.detected_type || 'Unknown',
      framework:    pageDoc?.technical?.framework  || 'unknown',
      cms:          pageDoc?.technical?.cms        || null,
      canonicalUrl: pageDoc?.technical?.canonical_url || null,
    };
  }

  // ─── Unknown / fallback ────────────────────────────────────────────────────

  /**
   * An issue whose id has no resolver in the registry. It used to render as a red
   * "Not detected — No <id> was found on this page / Expected: Unknown issue type" card even
   * though the analyzer HAD found it. Show the finding that is actually stored (message,
   * detected and expected value) and say plainly that no detailed resolver exists.
   */
  async _unknownContext(projectId, issueId, pageUrl, startMs) {
    let stored = [];
    try {
      stored = await mongoose.connection.db.collection('seo_page_issues')
        .find({ projectId: new mongoose.Types.ObjectId(projectId), page_url: pageUrl, $or: [{ issue_code: issueId }, { rule_id: issueId }] })
        .project({ issue_message: 1, detected_value: 1, expected_value: 1, category: 1, severity: 1 })
        .limit(10)
        .toArray();
    } catch (err) {
      console.warn(`[ISSUE_CONTEXT] Could not read stored finding for unregistered ${issueId}: ${err.message}`);
    }

    const items = stored.flatMap((d) => {
      const detected = [].concat(d.detected_value ?? []).filter((v) => typeof v === 'string' && v).slice(0, 5);
      return [d.issue_message, ...detected].filter(Boolean);
    });
    const unique = [...new Set(items)];
    const first = stored[0] || null;

    const currentState = unique.length
      ? {
          displayType: 'list',
          rawValue: unique,
          formattedValue: unique,
          measurement: { value: unique.length, unit: 'items', threshold: null },
          affectedItems: unique,
          isAbsent: false,
        }
      : {
          displayType: 'absent',
          rawValue: null,
          formattedValue: null,
          measurement: { value: null, unit: null, threshold: null },
          affectedItems: [],
          isAbsent: true,
          checkedFor: issueId,
        };

    return {
      identity: { issueId, issueType: 'unknown', category: first?.category || '', severity: first?.severity || '', pipeline: 'unknown' },
      currentState,
      expectedState: { description: first?.expected_value ? String(first.expected_value) : 'See the issue description', measurement: {} },
      pageContext: { pageUrl, pageType: 'Unknown', framework: 'unknown', cms: null, canonicalUrl: null },
      metadata: {
        projectId,
        resolvedAt: new Date().toISOString(),
        resolutionMs: Date.now() - startMs,
        dataSources: unique.length ? ['seo_page_issues'] : [],
        readinessScore: 0,
        missingSignals: ['issueId not in registry'],
        warnings: ['No detailed resolver exists for this issue type yet — showing the stored finding only'],
      },
      recommendationReady: false,
    };
  }
}

/**
 * Returns true for V2 hub rule IDs: AISO-*, AEO-*, GEO-*.
 * These bypass the legacy ResolverRegistry and use the V2 path.
 */
function _isV2HubIssue(issueId) {
  return /^(AISO|AEO|GEO)-/i.test(issueId);
}

export default new IssueContextEngine();
