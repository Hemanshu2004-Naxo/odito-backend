import Recommendation from '../model/Recommendation.js';
import { RECOMMENDATION_VERSION, GENERATION_SOURCE } from '../constants/recommendationTypes.js';
import fingerprintService from './fingerprintService.js';
import contextExtractor, { ISSUE_SOURCE } from './contextExtractor.js';
import templateService from './templateService.js';
import claudeService from './claudeService.js';
import recommendationNormalizer from './recommendationNormalizer.js';
import recommendationValidator from './recommendationValidator.js';
import RecommendationContextBuilder from '../context/RecommendationContextBuilder.js';
import ValidatorRegistry     from '../validators/ValidatorRegistry.js';
import ConfidenceCalculator  from '../normalizers/ConfidenceCalculator.js';
import IssueContextEngine    from '../../issue-context/service/IssueContextEngine.js';
import schemaEvidenceService from '../../schema-evidence/schemaEvidenceService.js';
import { applyGuardToSections } from '../../schema-evidence/schemaOutputGuard.js';
import { summarizeSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { markBreadcrumbEvidenceRegenerated } from '../../schema-evidence/breadcrumbEvidenceStore.js';
import schemaValidator from '../validators/SchemaValidator.js';
import {
  BreadcrumbRecommendationError,
  breadcrumbFingerprint,
  buildBreadcrumbSections,
} from './breadcrumbRecommendation.js';
import {
  OrganizationRecommendationError, ORGANIZATION_INTENT_ISSUES, organizationFingerprint, buildOrganizationSections,
} from './organizationRecommendation.js';
import { buildOrganizationAddressContract } from './organizationAddressContract.js';
import { isKnownIssue }      from '../../issue-context/service/ResolverRegistry.js';
import {
  RatingRecommendationError,
  assertRatingDetectionUsable,
  buildRatingSchemaSections,
  generatedFromDetection,
  ratingSchemaFingerprint,
} from './ratingSchemaRecommendation.js';
import {
  FaqRecommendationError,
  assertFaqDetectionUsable,
  buildFaqSchemaSections,
  faqSchemaFingerprint,
} from './faqSchemaRecommendation.js';
import { assertAltFindingActionable } from './imageAltScope.js';
import { assertSameAsEntityUsable, sameAsFingerprint, buildSameAsSections, SAMEAS_RECOMMENDATION_VERSION } from './sameAsRecommendation.js';
import { discoverSameAsProfiles } from '../../schema-evidence/sameAs/sameAsDiscovery.js';
import {
  AccessibilityRecommendationError,
  accessibilityFingerprint,
  assertAccessibilityAuditUsable,
  buildAccessibilitySections,
} from './accessibilityRecommendation.js';

/**
 * Recommendation Service — Orchestrator
 * 
 * GENERATION MODES (environment-aware):
 * 
 * DEVELOPMENT (NODE_ENV !== 'production'):
 *   1. Check cache → only serve if HIGH-QUALITY (Claude/hybrid generated)
 *   2. Skip low-quality cache (fallback/generic template)
 *   3. Call Claude FIRST
 *   4. Fall back to template only if Claude fails
 * 
 * PRODUCTION:
 *   1. Check cache → serve if valid AND high-quality
 *   2. Try high-quality template
 *   3. Call Claude for novel/complex cases
 *   4. Fallback only as last resort
 * 
 * DESIGN PRINCIPLES:
 * - Claude NEVER returns final DB shape
 * - Normalizer ALWAYS builds final structure
 * - pageUrl scopes element_add/list_fix/structural_fix fingerprints per-URL when available
 * - recommendationHash detects stale cache (template/prompt version change)
 * - Manual invalidation + TTL = dual cache control
 * - QUALITY-AWARE: detect and skip generic/poisoned cache entries
 */

// Cache TTL: 30 days
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Generic fallback text patterns that indicate poisoned/low-quality cache
const GENERIC_FALLBACK_PATTERNS = [
  'Address this issue to improve',
  'Improves overall AI visibility score',
  'No implementation example available',
  'affects your site\'s AI visibility and SEO performance',
];

class RecommendationService {

  /**
   * Generate or retrieve a recommendation for a given issue.
   * 
   * @param {Object} params
   * @param {string} params.projectId - Project ID
   * @param {string} params.issueId - Rule ID or issue code
   * @param {string} [params.pageUrl] - Optional page URL for context enrichment
   * @param {string} [params.issueSource] - 'ai_visibility' | 'on_page' | null (auto-detect)
   * @param {Object} [params.ruleMetadata] - { title, description, recommendation, category, severity }
   * @returns {Promise<Object>} { recommendation, source, cached }
   */
  async getOrGenerate(params) {
    const holder = { evidence: null };
    const result = await this._getOrGenerate({ ...params, _holder: holder });
    // Additive: a small, serialisable slice of the verified schema evidence (e.g. which breadcrumb state to show).
    if (holder.evidence && result && typeof result === 'object') {
      result.schemaEvidence = summarizeSchemaEvidence(holder.evidence);
      // The typed, validated address contract (what is missing, the evidence, the exact proposal, the diff and the action to
      // offer). Derived from the same evidence on every response — also for a cached recommendation — never from model text.
      const org = result.schemaEvidence.organization;
      if (org?.intent?.addressDemand) {
        org.addressFix = buildOrganizationAddressContract({ evidence: holder.evidence, projectId: params.projectId, issueId: params.issueId });
      }
    }
    return result;
  }

  /** @private — see getOrGenerate() */
  async _getOrGenerate({ projectId, issueId, pageUrl = null, issueSource = null, ruleMetadata = {}, issueContext = null, auditId = null, _holder = null }) {
    const startTime = Date.now();
    const isDev = process.env.NODE_ENV !== 'production';

    // V2 hub issues (AISO-*, AEO-*, GEO-*) bypass the legacy ResolverRegistry.
    // They are validated by pattern and resolved through IssueContextEngine's V2 path.
    // All other issue IDs must be explicitly registered to prevent stray requests.
    if (!isKnownIssue(issueId) && !_isV2HubIssue(issueId)) {
      console.warn(`[RECOMMENDATION] Registry lookup failed for issueId=${issueId} — throwing Unsupported issue type`);
      throw new Error('Unsupported issue type');
    }

    console.log(`\n[RECOMMENDATION] ═══════════════════════════════════════════════`);
    console.log(`[RECOMMENDATION] Request received | rule=${issueId} | project=${projectId}`);
    console.log(`[RECOMMENDATION] Mode: ${isDev ? 'DEVELOPMENT (Claude-first)' : 'PRODUCTION'}`);
    console.log(`[RECOMMENDATION] pageUrl=${pageUrl || 'none'} | issueSource=${issueSource || 'auto'}`);

    // ── Step 1: Extract context ─────────────────────────────────────────────
    // V2 hub issues use ai_pages for page context and ai_issues for sample URLs.
    // Legacy on-page / technical-check / ai_visibility issues use the existing path.
    let extraction;
    try {
      if (pageUrl) {
        const [pageContext, issueExtraction] = await Promise.all([
          _isV2HubIssue(issueId)
            ? contextExtractor.extractForV2Page(projectId, pageUrl)
            : contextExtractor.extract(projectId, pageUrl),
          contextExtractor.extractForIssue(projectId, issueId, issueSource),
        ]);
        extraction = {
          context: pageContext.context,
          sampleUrls: issueExtraction.sampleUrls,
          issueSource: issueExtraction.issueSource,
        };
      } else {
        extraction = await contextExtractor.extractForIssue(projectId, issueId, issueSource);
      }
    } catch (ctxError) {
      console.error(`[RECOMMENDATION] Context extraction failed:`, ctxError.message);
      extraction = {
        context: { pageType: 'Unknown', framework: 'unknown', cms: null, detectedSchemas: [], wordCount: 0 },
        sampleUrls: [],
        issueSource: issueSource || ISSUE_SOURCE.AI_VISIBILITY,
      };
    }

    const { context, sampleUrls } = extraction;
    const resolvedSource = extraction.issueSource || issueSource || ISSUE_SOURCE.AI_VISIBILITY;
    console.log(`[RECOMMENDATION] Context extracted | pageType=${context.pageType} | framework=${context.framework} | schemas=${(context.detectedSchemas || []).join(',')}`);
    console.log(`[RECOMMENDATION] Sample URLs: ${sampleUrls.length} found`);

    // ── faq_schema: deterministic, never LLM-generated ───────────────────────
    // The schema is built only from the FAQ Q/A pairs the crawler detected on
    // this exact page. Any caller-supplied issueContext is ignored on purpose —
    // the pairs must come from the server's own crawl data, not the request body.
    if (issueId === 'faq_schema') {
      return this._generateFaqSchemaRecommendation({
        projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
      });
    }

    // ── aggregate_rating_schema: deterministic, never LLM-generated ──────────
    // Built only from the rating the page displays and an entity already present
    // in its structured data. Caller-supplied issueContext is ignored for the
    // same reason as faq_schema above.
    if (issueId === 'aggregate_rating_schema') {
      return this._generateRatingSchemaRecommendation({
        projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
      });
    }

    // ── keyboard_accessibility: built from the audited elements, never LLM-guessed ──
    // The recommendation names the exact elements/selectors/stack the audit recorded.
    // Caller-supplied issueContext is ignored: the elements must come from the
    // server's own audit data, not the request body.
    if (issueId === 'keyboard_accessibility') {
      return this._generateAccessibilityRecommendation({
        projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
      });
    }

    // ── sameas_array: deterministic from DISCOVERED profile links, never LLM-guessed ─────────────────────────────
    // The model has nothing in its context that can confirm a profile URL, so it used to answer "not provided in context". The
    // profile links come from the site's own markup and pages (schema-evidence/sameAs/); the recommended structured data is the
    // Organization the site already publishes with only sameAs added. Kill switch: ODITO_SAMEAS_DETERMINISTIC=0.
    if (issueId === 'sameas_array' && process.env.ODITO_SAMEAS_DETERMINISTIC !== '0' && pageUrl) {
      return this._generateSameAsRecommendation({
        projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
      });
    }

    // ── Step 1b: Resolve IssueContext if not provided by caller ──────────────
    // When the frontend doesn't send issueContext (the common case), we resolve
    // it server-side using IssueContextEngine.  This gives ConfidenceCalculator
    // and PromptBuilder the full currentState / expectedState / pageContext data
    // they need to produce grounded, context-aware recommendations.
    let resolvedIssueContext = issueContext;
    // The frontend forwards only { currentState, expectedState, pageContext } — no
    // identity and no metadata (readiness). Using that as-is meant every
    // recommendation ran with readiness=0% and an empty identity (patched below).
    // A partial context is therefore treated as "not provided": the server's own
    // resolution of the same crawl data is authoritative and complete.
    const isPartialClientContext = !!issueContext && !issueContext.identity?.issueId && !issueContext.metadata;
    if ((!resolvedIssueContext || isPartialClientContext) && pageUrl) {
      try {
        console.log(`[RECOMMENDATION] Auto-resolving IssueContext | issueId=${issueId} | pageUrl=${pageUrl}`);
        resolvedIssueContext = await IssueContextEngine.resolve(projectId, issueId, pageUrl);
        console.log(`[RECOMMENDATION] IssueContext resolved | readiness=${resolvedIssueContext?.metadata?.readinessScore ?? 0}% | displayType=${resolvedIssueContext?.currentState?.displayType}`);
      } catch (iceErr) {
        console.warn(`[RECOMMENDATION] IssueContextEngine failed (non-fatal): ${iceErr.message}`);
        // Keep whatever the client sent (patched below) rather than dropping to nothing.
        resolvedIssueContext = isPartialClientContext ? issueContext : null;
      }
    }

    // ── images_missing_alt_text whose only flagged "image" was an analytics tracker: nothing to describe ──────────────
    // Refused deterministically (nothing generated, nothing stored, no model call): the model would otherwise invent image
    // names and alt texts for a picture that does not exist.
    if (issueId === 'images_missing_alt_text') assertAltFindingActionable(resolvedIssueContext);

    // Guard: patch empty identity.issueId from the service-level issueId.
    // Happens when the frontend sends the API response wrapper { success, data, meta }
    // instead of just the data payload, or sends a stale/partial IssueContext object.
    // Without this, resolveGroup('') falls back to TECHNICAL_SEO with the wrong token budget.
    if (resolvedIssueContext && !resolvedIssueContext.identity?.issueId) {
      console.warn(
        `[RECOMMENDATION] ⚠ issueContext.identity.issueId is empty — patching with issueId=${issueId}` +
        ` (frontend likely sent API wrapper instead of .data payload)`
      );
      resolvedIssueContext = {
        ...resolvedIssueContext,
        identity: { ...(resolvedIssueContext.identity || {}), issueId },
      };
    }

    // ── Step 1b-2: Verified schema evidence ─────────────────────────────────────
    // Organization / Article / BreadcrumbList recommendations are built from facts ODITO can
    // prove (the site's existing entity, a logo that was actually fetched and measured, the
    // canonical URL, the real breadcrumb hierarchy) instead of asking the model to supply a
    // logo URL it cannot know. Applies to legacy rule ids and V2 hub ids alike. Non-fatal: with
    // no evidence the prompt says so and the generator omits what it cannot prove.
    if (resolvedIssueContext && pageUrl && schemaEvidenceService.appliesTo(issueId)) {
      try {
        const schemaEvidence = await schemaEvidenceService.collectSchemaEvidence({ projectId, issueId, pageUrl });
        if (schemaEvidence) {
          resolvedIssueContext = { ...resolvedIssueContext, schemaEvidence };
          if (_holder) _holder.evidence = schemaEvidence;
          console.log(`[RECOMMENDATION] Schema evidence | kinds=${schemaEvidence.kinds.join(',')} | orgPresent=${schemaEvidence.organization.present} | logo=${schemaEvidence.organization.logo.status} | breadcrumb=${schemaEvidence.breadcrumb.hierarchy.status} | article=${schemaEvidence.article.applicable}`);
        }
      } catch (evErr) {
        console.warn(`[RECOMMENDATION] Schema evidence failed (non-fatal): ${evErr.message}`);
      }
    }

    // ── breadcrumblist_schema with an owner-confirmed hierarchy: deterministic, never LLM-generated ──
    // The trail is fully determined by the names/URLs the owner confirmed (and the canonical ODITO verified), so
    // the model is not involved at all. A page that ALREADY outputs a BreadcrumbList is a "conflict" and is
    // deliberately not handled here: generating a second entity would duplicate it, so it falls through to the
    // normal path, where the output guard drops any BreadcrumbList and the UI explains the conflict.
    if (issueId === 'breadcrumblist_schema' && resolvedIssueContext?.schemaEvidence?.breadcrumb?.hierarchy?.status === 'user_provided') {
      return this._generateBreadcrumbFromUserEvidence({
        projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
        evidence: resolvedIssueContext.schemaEvidence,
      });
    }

    // ── organization_schema / primary_organization_schema: deterministic from the SCHEMA INTENT ──────────
    // Which entity to recommend (Organization / LocalBusiness / Hospital / reuse the existing one / ask for a missing
    // fact) is decided from verified evidence — the page's markup, the site's entity and a Business Profile that matches
    // this website — not by the model and not by a constant. Without an intent (no evidence could be collected) the
    // normal path below still runs, with the original objective.
    // Kill switch: ODITO_ORG_SCHEMA_DETERMINISTIC=0 sends these issues back through the model path (the guard and the
    // validator still enforce the schema intent there).
    if (process.env.ODITO_ORG_SCHEMA_DETERMINISTIC !== '0' && ORGANIZATION_INTENT_ISSUES.has(issueId) && pageUrl && resolvedIssueContext?.schemaEvidence?.organization?.intent) {
      return this._generateOrganizationFromIntent({
        projectId, issueId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime,
        evidence: resolvedIssueContext.schemaEvidence,
      });
    }

    // ── Step 1c: Build RecommendationContext (context layer, Phase 2) ──────────
    // Transforms the raw IssueContext into a normalized, prompt-ready structure.
    // Zero DB calls — pure transformation on already-resolved data.
    let recommendationContext = null;
    if (resolvedIssueContext) {
      try {
        recommendationContext = RecommendationContextBuilder.build(resolvedIssueContext);
        console.log(`[RECOMMENDATION] RecommendationContext built | promptMode=${recommendationContext.recommendationObjective?.promptMode} | rich=${recommendationContext.builderMeta?.hasRichContext} | readiness=${recommendationContext.builderMeta?.issueContextReadiness}%`);
      } catch (rcbErr) {
        console.warn(`[RECOMMENDATION] RecommendationContextBuilder failed (non-fatal):`, rcbErr.message);
        // Graceful degradation — continue with legacy issueContext pass-through
      }
    }

    // ── Step 2: Compute fingerprint ─────────────────────────────────────────
    // pageUrl is forwarded so element_add / list_fix / structural_fix modes
    // produce URL-specific fingerprints and never serve a cached recommendation
    // intended for a different page.
    const rawValue = resolvedIssueContext?.currentState?.rawValue || null;
    const fingerprint = fingerprintService.computeFingerprint(issueId, context, rawValue, recommendationContext, auditId, pageUrl);
    const templateVersion = await templateService.getTemplateVersion(issueId);
    const promptGroup = recommendationContext?.recommendationObjective?.promptGroup ?? null;
    const recommendationHash = fingerprintService.computeRecommendationHash(
      fingerprint, templateVersion, RECOMMENDATION_VERSION, promptGroup
    );
    console.log(`[RECOMMENDATION] Fingerprint: ${fingerprint.slice(0, 16)}... | templateVer=${templateVersion} | recVer=${RECOMMENDATION_VERSION}`);

    // ── Step 3: Check cache ─────────────────────────────────────────────────
    const cached = await Recommendation.findValid(projectId, fingerprint, RECOMMENDATION_VERSION);

    if (cached && fingerprintService.isValid(cached, recommendationHash)) {
      const isLowQuality = this._isLowQualityCacheEntry(cached);
      const claudeAvailable = claudeService.isAvailable();

      console.log(`[RECOMMENDATION] Cache found | source=${cached.generatedBy} | lowQuality=${isLowQuality} | claudeAvailable=${claudeAvailable}`);

      // Serve cache ONLY if it's high-quality (Claude or real template)
      if (!isLowQuality) {
        console.log(`[RECOMMENDATION] ✓ Cache HIT — high quality | rule=${issueId} | source=${cached.generatedBy}`);
        return {
          recommendation: this._formatOutput(cached),
          source: cached.generatedBy,
          cached: true,
          generationTimeMs: Date.now() - startTime,
        };
      }

      // Low-quality cache — skip if Claude is available, regenerate
      if (claudeAvailable) {
        console.log(`[RECOMMENDATION] ⚠ Cache SKIP — low quality detected, will regenerate with Claude | rule=${issueId}`);
      } else {
        // Claude not available AND cache is low quality — serve it anyway (better than nothing)
        console.warn(`[RECOMMENDATION] ⚠ Serving low-quality cache (Claude unavailable) | rule=${issueId}`);
        return {
          recommendation: this._formatOutput(cached),
          source: cached.generatedBy,
          cached: true,
          generationTimeMs: Date.now() - startTime,
        };
      }
    } else {
      console.log(`[RECOMMENDATION] Cache MISS | rule=${issueId}`);
    }

    // ── Step 4: Claude generation (FIRST in dev mode) ────────────────────────
    // In development: always try Claude first for best quality.
    // In production: try template first, Claude for novel cases.
    
    if (isDev || !await this._hasHighQualityTemplate(issueId, context)) {
      const claudeResult = await this._tryClaudeGeneration({
        issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext,
        projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource,
        templateVersion, startTime, pageUrl,
      });
      if (claudeResult) return claudeResult;
    }

    // ── Step 5: Try template resolution (production path or Claude failure) ──
    const templateResult = await templateService.resolve(issueId, context);

    if (templateResult) {
      console.log(`[RECOMMENDATION] Template HIT | rule=${issueId}`);
      const normalizedSections = recommendationNormalizer.normalizeTemplate(templateResult.sections);
      const validation = recommendationValidator.validate(normalizedSections);

      if (validation.valid && !this._isGenericContent(normalizedSections)) {
        const stored = await this._store({
          projectId,
          fingerprint,
          recommendationHash,
          issueId,
          context,
          sampleUrls,
          sections: normalizedSections,
          generatedBy: GENERATION_SOURCE.TEMPLATE,
          templateVersion: templateResult.templateVersion,
          ruleMetadata,
          resolvedSource,
          pageUrl,
        });

        console.log(`[RECOMMENDATION] ✓ Template stored | rule=${issueId}`);
        return {
          recommendation: this._formatOutput(stored),
          source: GENERATION_SOURCE.TEMPLATE,
          cached: false,
          generationTimeMs: Date.now() - startTime,
        };
      }

      console.warn(`[RECOMMENDATION] Template rejected | valid=${validation.valid} | generic=${this._isGenericContent(normalizedSections)} | rule=${issueId}`);
    } else {
      console.log(`[RECOMMENDATION] Template MISS | rule=${issueId}`);
    }

    // ── Step 6: Claude (production path — if template failed) ────────────────
    if (!isDev) {
      const claudeResult = await this._tryClaudeGeneration({
        issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext,
        projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource,
        templateVersion, startTime, pageUrl,
      });
      if (claudeResult) return claudeResult;
    }

    // ── Step 7: Final fallback ───────────────────────────────────────────────
    console.warn(`[RECOMMENDATION] ⚠ All generation paths exhausted, using fallback | rule=${issueId}`);
    return this._generateFallback({
      projectId, fingerprint, recommendationHash, issueId,
      context, sampleUrls, ruleMetadata, resolvedSource, startTime, pageUrl,
    });
  }

  /**
   * breadcrumblist_schema built from the hierarchy the site owner confirmed. Everything goes through the same
   * safety pipeline as any generated schema — the output guard, then SchemaValidator against the evidence — and
   * a failure stores nothing. Re-requesting the same hierarchy is served from the existing record (same
   * fingerprint); it never creates a second one. Does not touch any Task: generating code is not implementing it.
   * @private
   */
  async _generateBreadcrumbFromUserEvidence({ projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime, evidence }) {
    const fingerprint = breadcrumbFingerprint(projectId, pageUrl, evidence);
    const recommendationHash = fingerprintService.computeRecommendationHash(fingerprint, 1, RECOMMENDATION_VERSION, null);

    const cached = await Recommendation.findValid(projectId, fingerprint, RECOMMENDATION_VERSION);
    if (cached && fingerprintService.isValid(cached, recommendationHash)) {
      return {
        recommendation: this._formatOutput(cached),
        source: GENERATION_SOURCE.TEMPLATE,
        cached: true,
        generationTimeMs: Date.now() - startTime,
      };
    }

    const built = buildBreadcrumbSections(evidence);
    const { sections } = applyGuardToSections(built, evidence);
    const validation = schemaValidator.validate(sections, {
      identity: { issueId: 'breadcrumblist_schema' },
      pageContext: { pageUrl: evidence.url.display },
      schemaEvidence: evidence,
    });
    if (!validation.valid || !validation.satisfiesConstraint) {
      throw new BreadcrumbRecommendationError(
        'BREADCRUMB_OUTPUT_INVALID',
        `The generated BreadcrumbList did not pass validation, so it was not saved: ${validation.errors.join(' ')}`
      );
    }

    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId: 'breadcrumblist_schema', context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: 1, ruleMetadata, resolvedSource, pageUrl,
    });
    await markBreadcrumbEvidenceRegenerated(projectId, pageUrl);

    console.log(`[RECOMMENDATION] ✓ BreadcrumbList built deterministically from owner-confirmed hierarchy | items=${evidence.breadcrumb.hierarchy.items.length} | page=${pageUrl}`);
    return {
      recommendation: this._formatOutput(stored),
      source: GENERATION_SOURCE.TEMPLATE,
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * organization_schema built from the schema intent. Same safety pipeline as every generated schema — output guard,
   * then SchemaValidator against the evidence — and a failure stores nothing. The cache key includes the intent, so a
   * recommendation made under a different intent (or before a fact appeared on the site) is never served; older
   * entries are simply bypassed, never deleted. Does not touch any Task.
   * @private
   */
  async _generateOrganizationFromIntent({ projectId, issueId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime, evidence }) {
    const fingerprint = organizationFingerprint(projectId, pageUrl, evidence);
    const recommendationHash = fingerprintService.computeRecommendationHash(fingerprint, 1, RECOMMENDATION_VERSION, null);

    const cached = await Recommendation.findValid(projectId, fingerprint, RECOMMENDATION_VERSION);
    if (cached && fingerprintService.isValid(cached, recommendationHash)) {
      return { recommendation: this._formatOutput(cached), source: GENERATION_SOURCE.TEMPLATE, cached: true, generationTimeMs: Date.now() - startTime };
    }

    const built = buildOrganizationSections(evidence);
    let sections = built;
    // An address finding is validated by its own strict contract inside buildOrganizationSections (the proposal must be
    // traceable to evidence and the entity must differ only by its address). The generic validator below is for whole
    // generated entities and would judge, and strip, properties the site already has: the opposite of a minimal change.
    if (evidence.organization.intent.action === 'generate' && !evidence.organization.intent.addressDemand) {
      sections = applyGuardToSections(built, evidence).sections;
      const validation = schemaValidator.validate(sections, {
        identity: { issueId },
        pageContext: { pageUrl: evidence.url.display },
        schemaEvidence: evidence,
      });
      if (!validation.valid || !validation.satisfiesConstraint) {
        throw new OrganizationRecommendationError(
          'ORGANIZATION_OUTPUT_INVALID',
          `The generated ${evidence.organization.intent.type} markup did not pass validation, so it was not saved: ${validation.errors.join(' ')}`
        );
      }
    }

    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId, context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: 1, ruleMetadata, resolvedSource, pageUrl,
    });

    const i = evidence.organization.intent;
    console.log(`[RECOMMENDATION] ✓ ${i.type} recommendation built deterministically | intent=${i.intent} | action=${i.action} | scope=${i.scope} | page=${pageUrl}`);
    return { recommendation: this._formatOutput(stored), source: GENERATION_SOURCE.TEMPLATE, cached: false, generationTimeMs: Date.now() - startTime };
  }

  /**
   * sameas_array recommendation built from discovered, evidence-backed profile links (see sameAsRecommendation.js). Throws
   * SameAsRecommendationError (nothing stored) when there is no single Organization entity to attach them to.
   * @private
   */
  async _generateSameAsRecommendation({ projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime }) {
    const discovery = await discoverSameAsProfiles({ projectId, pageUrl });
    assertSameAsEntityUsable(discovery);

    const fingerprint = sameAsFingerprint(projectId, pageUrl, discovery);
    const recommendationHash = fingerprintService.computeRecommendationHash(fingerprint, 1, RECOMMENDATION_VERSION, null);

    const cached = await Recommendation.findValid(projectId, fingerprint, RECOMMENDATION_VERSION);
    if (cached && fingerprintService.isValid(cached, recommendationHash)) {
      return { recommendation: this._formatOutput(cached), source: GENERATION_SOURCE.TEMPLATE, cached: true, generationTimeMs: Date.now() - startTime };
    }

    const sections = buildSameAsSections(discovery);
    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId: 'sameas_array', context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: SAMEAS_RECOMMENDATION_VERSION, ruleMetadata, resolvedSource, pageUrl,
    });

    console.log(`[RECOMMENDATION] ✓ sameAs recommendation built deterministically | state=${discovery.state} | candidates=${discovery.candidates.length} | page=${pageUrl}`);
    return { recommendation: this._formatOutput(stored), source: GENERATION_SOURCE.TEMPLATE, cached: false, generationTimeMs: Date.now() - startTime };
  }

  /**
   * faq_schema recommendation: FAQPage JSON-LD built from detected pairs only.
   * Throws FaqRecommendationError (nothing stored) when the page has no
   * reliably-extracted FAQ, so a fabricated schema can never be produced.
   * @private
   */
  async _generateFaqSchemaRecommendation({ projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime }) {
    if (!pageUrl) {
      throw new FaqRecommendationError('FAQ_PAGE_REQUIRED', 'A page URL is required to generate FAQPage schema from that page\'s FAQ content.', 400);
    }

    const issueContext = await IssueContextEngine.resolve(projectId, 'faq_schema', pageUrl);
    const detection = issueContext?.faqDetection;
    assertFaqDetectionUsable(detection);

    const sections = buildFaqSchemaSections(detection);
    const fingerprint = faqSchemaFingerprint(projectId, pageUrl, detection.content.pairs);
    const recommendationHash = fingerprintService.computeRecommendationHash(
      fingerprint, 1, RECOMMENDATION_VERSION, null
    );

    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId: 'faq_schema', context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: 1, ruleMetadata, resolvedSource, pageUrl,
    });

    console.log(`[RECOMMENDATION] ✓ FAQ schema built deterministically | pairs=${detection.content.pairs.length} | page=${pageUrl}`);
    return {
      recommendation: this._formatOutput(stored),
      source: GENERATION_SOURCE.TEMPLATE,
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * aggregate_rating_schema recommendation: AggregateRating JSON-LD built from
   * verified page data only. Throws RatingRecommendationError (nothing stored)
   * when reliable rating data or a mergeable target entity is unavailable.
   * @private
   */
  async _generateRatingSchemaRecommendation({ projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime }) {
    if (!pageUrl) {
      throw new RatingRecommendationError('RATING_PAGE_REQUIRED', 'A page URL is required to generate AggregateRating schema from that page\'s rating.', 400);
    }

    const issueContext = await IssueContextEngine.resolve(projectId, 'aggregate_rating_schema', pageUrl);
    const detection = issueContext?.ratingDetection;
    assertRatingDetectionUsable(detection);

    const sections = buildRatingSchemaSections(detection);
    const fingerprint = ratingSchemaFingerprint(projectId, pageUrl, generatedFromDetection(detection));
    const recommendationHash = fingerprintService.computeRecommendationHash(
      fingerprint, 1, RECOMMENDATION_VERSION, null
    );

    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId: 'aggregate_rating_schema', context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: 1, ruleMetadata, resolvedSource, pageUrl,
    });

    console.log(`[RECOMMENDATION] ✓ AggregateRating schema built deterministically | target=${detection.targetSchemaType} | page=${pageUrl}`);
    return {
      recommendation: this._formatOutput(stored),
      source: GENERATION_SOURCE.TEMPLATE,
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * keyboard_accessibility recommendation: built from the exact elements, selectors
   * and technology the keyboard/focus audit recorded. Throws
   * AccessibilityRecommendationError (nothing stored) when the audit is missing,
   * outdated (counts only) or found nothing to fix — with a message that says
   * precisely what is missing, never a generic "no example available".
   * @private
   */
  async _generateAccessibilityRecommendation({ projectId, pageUrl, context, sampleUrls, resolvedSource, ruleMetadata, startTime }) {
    if (!pageUrl) {
      throw new AccessibilityRecommendationError('ACCESSIBILITY_PAGE_REQUIRED', 'A page URL is required to generate a keyboard accessibility recommendation from that page\'s audit.', 400);
    }

    const issueContext = await IssueContextEngine.resolve(projectId, 'keyboard_accessibility', pageUrl);
    const audit = issueContext?.accessibilityAudit;
    assertAccessibilityAuditUsable(audit);

    const sections = buildAccessibilitySections(audit);
    const fingerprint = accessibilityFingerprint(projectId, pageUrl, audit);
    const recommendationHash = fingerprintService.computeRecommendationHash(
      fingerprint, 1, RECOMMENDATION_VERSION, null
    );

    const stored = await this._store({
      projectId, fingerprint, recommendationHash, issueId: 'keyboard_accessibility', context,
      sampleUrls, sections, generatedBy: GENERATION_SOURCE.TEMPLATE,
      templateVersion: 1, ruleMetadata, resolvedSource, pageUrl,
    });

    console.log(`[RECOMMENDATION] ✓ Accessibility recommendation built from audit | elements=${sections.sourceAttribution.contextSources.auditedElements} | tech=${audit.technology?.kind} | page=${pageUrl}`);
    return {
      recommendation: this._formatOutput(stored),
      source: GENERATION_SOURCE.TEMPLATE,
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Attempt Claude generation. Returns result object or null on failure.
   * @private
   */
  async _tryClaudeGeneration({ issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext, projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource, templateVersion, startTime, pageUrl = null }) {
    if (!claudeService.isAvailable()) {
      console.warn(`[RECOMMENDATION] Claude not available — API key missing | rule=${issueId}`);
      return null;
    }

    // ── Attempt generation up to 2 times (initial + 1 repair retry) ─────
    // Retry triggers when the context-aware validator flags satisfiesConstraint=false,
    // OR when attempt 1 was truncated (hit max_tokens before finishing valid JSON).
    // Attempt 2 uses either a targeted repair prompt (constraint failure) or the
    // same prompt with a boosted token budget (truncation) — never both at once.
    let prevRawOutput  = null;   // Claude's first attempt raw output (string)
    let prevWarnings   = [];     // validation warnings from attempt 1
    let maxTokensOverride = null; // set when attempt 1 was truncated, so attempt 2 gets more room

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[RECOMMENDATION] ──── Claude Generation (attempt ${attempt}) ────`);
        const promptMode = recommendationContext?.recommendationObjective?.promptMode || 'structural';
        console.log(`[CLAUDE] rule=${issueId} | promptMode=${promptMode} | attempt=${attempt}`);

        // On attempt 2, pass the repair hint so claudeService uses the repair prompt.
        // Repair hint is only for constraint-validation failures — not timeouts/network
        // errors/truncation (a repair prompt is longer than the original, which would
        // make a truncation failure MORE likely to recur, not less).
        const repairHint = (attempt === 2 && prevWarnings.length > 0 && prevRawOutput)
          ? { previousOutput: prevRawOutput, failureReasons: prevWarnings }
          : null;

        const claudeResult = await claudeService.generate(issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext, repairHint, maxTokensOverride);

        console.log(`[CLAUDE] ✓ Response received | tokens: in=${claudeResult.tokensUsed.input} out=${claudeResult.tokensUsed.output} | time=${claudeResult.generationTimeMs}ms | group=${claudeResult.promptGroup ?? 'legacy'}`);

        // ── Step 1: Raw output structural check ────────────────────────────
        const rawValidation = recommendationValidator.validateRawAIOutput(claudeResult.rawOutput);
        if (!rawValidation.usable) {
          console.warn(`[RECOMMENDATION] Claude output unusable (attempt ${attempt}) | missing=[${rawValidation.missingFields.join(',')}] | rule=${issueId}`);
          if (attempt === 2) return null;
          continue;
        }

        // ── Step 2: Normalize output → sections ────────────────────────────
        let sections = recommendationNormalizer.normalize(
          claudeResult.rawOutput, context, ruleMetadata, recommendationContext
        );

        // ── Step 2b: Schema output guard ───────────────────────────────────
        // Anything the model wrote that is not backed by the site's own markup or a verified
        // asset (an unfetchable logo, an invented phone/address/profile, an unverified date,
        // a breadcrumb parent that does not exist) is removed and reported, never published.
        if (recommendationContext?.schemaEvidence) {
          const guarded = applyGuardToSections(sections, recommendationContext.schemaEvidence);
          sections = guarded.sections;
          if (guarded.report?.removed?.length) {
            console.log(`[SCHEMA_GUARD] rule=${issueId} | removed=${guarded.report.removed.map((r) => `${r.node}.${r.field}`).join(', ')}`);
          }
        }

        // ── Step 3: Structural section integrity check ─────────────────────
        const structuralValidation = recommendationValidator.validate(sections);
        if (!structuralValidation.valid) {
          console.warn(`[RECOMMENDATION] Normalized sections invalid (attempt ${attempt}) | errors=[${structuralValidation.errors.join(',')}] | rule=${issueId}`);
          if (attempt === 2) return null;
          continue;
        }

        // ── Step 4: Context-aware content validation ───────────────────────
        // Only runs when RecommendationContext is available (context-aware path).
        // Validates constraint satisfaction, grounding, hallucination detection.
        let contextValidation = { valid: true, errors: [], warnings: [], satisfiesConstraint: true };
        const promptGroup = claudeResult.promptGroup;

        if (recommendationContext && promptGroup != null) {
          contextValidation = ValidatorRegistry.validate(sections, recommendationContext, promptGroup);
          console.log(`[VALIDATOR] Group ${promptGroup} | valid=${contextValidation.valid} | satisfies=${contextValidation.satisfiesConstraint} | warnings=${contextValidation.warnings.length}`);

          if (!contextValidation.satisfiesConstraint && attempt === 1) {
            // Capture failure reasons for repair prompt on attempt 2
            prevRawOutput = JSON.stringify(claudeResult.rawOutput);
            prevWarnings  = [...contextValidation.warnings, ...contextValidation.errors];
            console.warn(`[RECOMMENDATION] Constraint not satisfied (attempt ${attempt}) — retrying with repair prompt | rule=${issueId}`);
            console.warn(`[RECOMMENDATION] Repair reasons: ${prevWarnings.join(' | ')}`);
            continue;
          }

          if (!contextValidation.valid) {
            console.warn(`[RECOMMENDATION] Context validation failed after ${attempt} attempt(s) — falling back | rule=${issueId}`);
            if (attempt === 2) return null;
            continue;
          }
        }

        // ── Step 5: Compute ConfidenceScore ───────────────────────────────
        let confidence = null;
        if (recommendationContext) {
          try {
            confidence = ConfidenceCalculator.calculate(recommendationContext, claudeResult.rawOutput);
            console.log(`[CONFIDENCE] overall=${confidence.overall} | tier=${confidence.tier} | rule=${issueId}`);
            sections.confidence = confidence;
          } catch (confErr) {
            console.warn('[CONFIDENCE] Calculation failed (non-fatal):', confErr.message);
          }
        }

        // ── Step 6: Build SourceAttribution ──────────────────────────────
        const sourceAttribution = this._buildSourceAttribution({
          claudeResult,
          recommendationContext,
          cacheStatus: 'miss',
        });
        sections.sourceAttribution = sourceAttribution;

        // ── Step 7: Store ─────────────────────────────────────────────────
        const stored = await this._store({
          projectId, fingerprint, recommendationHash, issueId, context,
          sampleUrls, sections, generatedBy: GENERATION_SOURCE.CLAUDE,
          templateVersion, ruleMetadata, resolvedSource,
          claudeModelUsed: claudeResult.modelUsed,
          tokensUsed:      claudeResult.tokensUsed,
          generationTimeMs:claudeResult.generationTimeMs,
          pageUrl,
        });

        console.log(`[RECOMMENDATION] ✓ Stored | rule=${issueId} | attempt=${attempt} | tier=${confidence?.tier ?? 'n/a'} | time=${Date.now() - startTime}ms`);
        console.log(`[RECOMMENDATION] ═══════════════════════════════════════════════\n`);

        return {
          recommendation: this._formatOutput(stored),
          source:         GENERATION_SOURCE.CLAUDE,
          cached:         false,
          generationTimeMs: Date.now() - startTime,
        };

      } catch (error) {
        const errCode = error.claudeErrorCode || error.message;
        console.error(
          `[CLAUDE] ✗ Generation FAILED (attempt ${attempt}) | rule=${issueId}` +
          ` | code=${errCode} | retryable=${_isRetryableError(error)}`
        );

        if (attempt === 2 || !_isRetryableError(error)) return null;

        // Truncation retry needs more room, not just another try at the same
        // ceiling — 1.5x the budget that just ran out, capped well under
        // Sonnet's output limit.
        if (errCode === 'CLAUDE_TRUNCATED') {
          const previousBudget = error.attemptedMaxTokens || maxTokensOverride;
          if (previousBudget) {
            maxTokensOverride = Math.min(Math.round(previousBudget * 1.5), 4096);
            console.log(`[CLAUDE] Truncated — retrying with boosted budget | rule=${issueId} | ${previousBudget} → ${maxTokensOverride}`);
          }
        }

        // Wait before retry — duration depends on error type (timeout vs rate limit vs network)
        const delayMs = claudeService.retryDelayFor(error, attempt);
        if (delayMs) {
          console.log(`[CLAUDE] Retry delay | rule=${issueId} | delayMs=${delayMs} | code=${errCode}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    return null;
  }

  /**
   * Build a SourceAttribution record for audit history.
   * @private
   */
  _buildSourceAttribution({ claudeResult, recommendationContext, cacheStatus }) {
    const rc = recommendationContext;
    return {
      generatedBy:  GENERATION_SOURCE.CLAUDE,
      promptPath:   claudeResult.promptPath || 'legacy_structural',
      promptGroup:  claudeResult.promptGroup ?? null,
      contextSources: {
        issueContextReadiness: rc?.builderMeta?.issueContextReadiness ?? 0,
        hasRichContext:        rc?.builderMeta?.hasRichContext ?? false,
        sectionsPopulated:     rc?.builderMeta?.sectionsPopulated ?? [],
        contextBuiltAt:        rc?.builderMeta?.builtAt ?? null,
        dataSources:           [],
      },
      modelUsed:      claudeResult.modelUsed,
      tokensUsed:     claudeResult.tokensUsed,
      generationMs:   claudeResult.generationTimeMs,
      cacheStatus,
    };
  }

  /**
   * Invalidate recommendations by rule (when rule logic changes).
   */
  async invalidateByRule(ruleId, reason = 'rule_version_change') {
    const result = await Recommendation.invalidateByRule(ruleId, reason);
    console.log(`[RECOMMENDATION] Invalidated ${result.modifiedCount} recommendations for rule=${ruleId}`);
    return result;
  }

  /**
   * Invalidate all recommendations for a project.
   */
  async invalidateByProject(projectId, reason = 'manual') {
    const result = await Recommendation.invalidateByProject(projectId, reason);
    console.log(`[RECOMMENDATION] Invalidated ${result.modifiedCount} recommendations for project=${projectId}`);
    return result;
  }

  /**
   * Get recommendation stats for a project.
   */
  async getStats(projectId) {
    const total = await Recommendation.countDocuments({ projectId });
    const bySource = await Recommendation.aggregate([
      { $match: { projectId: new (await import('mongoose')).default.Types.ObjectId(projectId) } },
      { $group: { _id: '$generatedBy', count: { $sum: 1 } } },
    ]);
    const invalidated = await Recommendation.countDocuments({ projectId, invalidatedAt: { $ne: null } });

    return {
      total,
      bySource: Object.fromEntries(bySource.map(s => [s._id, s.count])),
      invalidated,
      active: total - invalidated,
    };
  }

  // ── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Store a recommendation in the cache (upsert by fingerprint).
   * @private
   */
  async _store({
    projectId, fingerprint, recommendationHash, issueId, context,
    sampleUrls, sections, generatedBy, templateVersion, ruleMetadata,
    resolvedSource, claudeModelUsed = null, tokensUsed = { input: 0, output: 0 },
    generationTimeMs = 0, pageUrl = null,
  }) {
    const doc = {
      projectId,
      fingerprint,
      recommendationHash,
      recommendationVersion: RECOMMENDATION_VERSION,
      ruleId: issueId,
      issueCode: resolvedSource === ISSUE_SOURCE.ON_PAGE ? issueId : null,
      category: ruleMetadata.category || 'unknown',
      severity: ruleMetadata.severity || null,
      pageUrl: pageUrl || null,
      context,
      sampleUrls: (sampleUrls || []).slice(0, 10),
      sections,
      generatedBy,
      claudeModelUsed,
      tokensUsed,
      generationTimeMs,
      ruleVersion: 1,
      templateVersion: templateVersion || 1,
      invalidatedAt: null,
      invalidationReason: null,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    };

    const stored = await Recommendation.findOneAndUpdate(
      { projectId, fingerprint },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return stored;
  }

  /**
   * Generate a fallback recommendation from rule metadata when Claude fails.
   * @private
   */
  async _generateFallback({
    projectId, fingerprint, recommendationHash, issueId,
    context, sampleUrls, ruleMetadata, resolvedSource, startTime, pageUrl = null,
  }) {
    console.warn(`[RECOMMENDATION] ⚠ Using fallback for rule=${issueId} — Claude not available or failed`);

    const fallbackRaw = {
      whyThisMatters: ruleMetadata.description || `This issue (${issueId}) affects your site's AI visibility and SEO performance.`,
      recommendedFix: ruleMetadata.recommendation || 'Address this issue to improve your SEO and AI visibility scores.',
      implementationCode: null,
      impacts: ['Improves overall AI visibility score', 'Enhances search engine understanding'],
      recovery: null,
      difficulty: ruleMetadata.difficulty || 'medium',
      estimatedFixTime: '15 minutes',
    };

    const normalizedSections = recommendationNormalizer.normalize(fallbackRaw, context, ruleMetadata);

    // IMPORTANT: Mark as 'fallback' — NOT template.
    // This allows cache logic to skip stale fallback entries when Claude becomes available.
    const stored = await this._store({
      projectId,
      fingerprint,
      recommendationHash,
      issueId,
      context,
      sampleUrls,
      sections: normalizedSections,
      generatedBy: GENERATION_SOURCE.FALLBACK,
      templateVersion: 1,
      ruleMetadata,
      resolvedSource,
      pageUrl,
    });

    return {
      recommendation: this._formatOutput(stored),
      source: 'fallback',
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Detect whether a cached recommendation is low-quality (generic fallback content).
   * Catches BOTH new 'fallback' entries AND old poisoned 'template' entries.
   * @private
   */
  _isLowQualityCacheEntry(cached) {
    // An alt-text recommendation made before per-image proposals existed cannot feed the WordPress image fix: regenerate it
    // (once; the new one always carries the field, even when empty).
    if (cached.ruleId === 'images_missing_alt_text' && cached.sections?.imageAltProposals === undefined) {
      return true;
    }

    // Explicit fallback source
    if (cached.generatedBy === GENERATION_SOURCE.FALLBACK || cached.generatedBy === 'fallback') {
      return true;
    }

    // Claude-generated entries are always high quality
    if (cached.generatedBy === GENERATION_SOURCE.CLAUDE) {
      return false;
    }

    // For 'template' entries — inspect content for generic fallback patterns
    const sections = cached.sections;
    if (!sections) return true;

    return this._isGenericContent(sections);
  }

  /**
   * Check if sections contain generic/placeholder content.
   * @private
   */
  _isGenericContent(sections) {
    if (!sections) return true;

    const textsToCheck = [
      sections.recommendedFix || '',
      sections.whyThisMatters || '',
      (sections.implementationExample?.content) || '',
      ...(sections.expectedImpact || []),
    ].join(' ');

    for (const pattern of GENERIC_FALLBACK_PATTERNS) {
      if (textsToCheck.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a high-quality template exists for this rule (not generic).
   * Used in production mode to decide template-first vs Claude-first.
   * @private
   */
  async _hasHighQualityTemplate(issueId, context) {
    const templateResult = await templateService.resolve(issueId, context);
    if (!templateResult) return false;

    // Check if template content is generic
    const sections = templateResult.sections;
    if (!sections) return false;

    return !this._isGenericContent(sections);
  }

  /**
   * Format a recommendation document for API response.
   * @private
   */
  _formatOutput(doc) {
    const s = doc.sections || {};
    return {
      id:                    doc._id,
      ruleId:                doc.ruleId,
      issueCode:             doc.issueCode,
      category:              doc.category,
      severity:              doc.severity,
      context:               doc.context,
      sampleUrls:            doc.sampleUrls,
      generatedBy:           doc.generatedBy,
      recommendationVersion: doc.recommendationVersion,
      createdAt:             doc.createdAt,
      updatedAt:             doc.updatedAt,
      // Core sections
      sections: {
        whyThisMatters:        s.whyThisMatters,
        recommendedFix:        s.recommendedFix,
        implementationExample: s.implementationExample,
        expectedImpact:        s.expectedImpact,
        estimatedRecovery:     s.estimatedRecovery,
        difficulty:            s.difficulty,
        estimatedFixTime:      s.estimatedFixTime,
        recommendedVersion:    s.recommendedVersion    || null,
        contentRewrite:        s.contentRewrite        || null,
      },
      // images_missing_alt_text: structured per-image proposals (null for every other recommendation and for older alt ones).
      imageAltProposals: s.imageAltProposals || null,
      // Phase 3 extended fields (surface at top level for frontend convenience)
      beforeState:       s.beforeState       || null,
      afterState:        s.afterState        || null,
      changeSummary:     s.changeSummary     || null,
      confidence:        s.confidence        || null,
      sourceAttribution: s.sourceAttribution || null,
      detectedContext:   s.detectedContext   || null,
    };
  }
}

/**
 * Returns true for V2 hub rule IDs: AISO-*, AEO-*, GEO-*.
 * These bypass the legacy ResolverRegistry and use the V2 extraction + context path.
 * Mirrors the identical check in IssueContextEngine._isV2HubIssue().
 */
function _isV2HubIssue(issueId) {
  return /^(AISO|AEO|GEO)-/i.test(issueId);
}

/**
 * Returns true for transient failures where a retry is likely to succeed.
 * CLAUDE_INVALID_JSON and CLAUDE_EMPTY_RESPONSE are structural — retrying
 * the same prompt with the same model will almost certainly produce the same
 * bad output, so we skip to fallback immediately. CLAUDE_TRUNCATED is
 * different: it means the response was cut off by max_tokens, not that
 * Claude produced bad content — retrying with a larger budget (see the
 * maxTokensOverride logic above) has a real chance of succeeding.
 */
function _isRetryableError(error) {
  const code = error.claudeErrorCode || error.message;
  return (
    code === 'CLAUDE_TIMEOUT'       ||
    code === 'CLAUDE_OVERLOADED'    ||
    code === 'CLAUDE_RATE_LIMITED'  ||
    code === 'CLAUDE_NETWORK_ERROR' ||
    code === 'CLAUDE_TRUNCATED'
  );
}

export default new RecommendationService();
