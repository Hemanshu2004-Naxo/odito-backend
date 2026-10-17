import mongoose from 'mongoose';
import recommendationService from '../service/recommendationService.js';
import { ISSUE_SOURCE } from '../service/contextExtractor.js';
import Recommendation from '../model/Recommendation.js';
import { pickDisplayUrl } from '../../schema-evidence/schemaGraph.js';
import { BREADCRUMB_LIMITS, validateBreadcrumbHierarchy } from '../../schema-evidence/breadcrumbHierarchy.js';
import { saveUserBreadcrumbEvidence } from '../../schema-evidence/breadcrumbEvidenceStore.js';
import { saveConfirmedAddress } from '../../schema-evidence/organizationAddressStore.js';
import { SOURCE_LABEL as ADDRESS_SOURCE_LABEL, validateConfirmedAddressInput } from '../../schema-evidence/organizationAddress.js';

/**
 * Recommendation Controller
 * 
 * Express route handlers for the recommendation engine.
 * Supports both AI visibility issues and on-page SEO issues.
 */

/**
 * POST /recommendations/generate
 * 
 * Generate or retrieve a recommendation for an issue.
 * 
 * Body:
 *   - projectId (required): Project ID
 *   - issueId (required): Rule ID or issue code
 *   - pageUrl (optional): Page URL for context enrichment
 *   - issueSource (optional): 'ai_visibility' | 'on_page' (auto-detects if omitted)
 *   - ruleMetadata (optional): { title, description, recommendation, category, severity, difficulty }
 */
export async function generateRecommendation(req, res) {
  try {
    const { projectId, issueId, pageUrl, issueSource, ruleMetadata, issueContext, auditId } = req.body;

    console.log(`[RECOMMENDATION_CTRL] POST /generate | issueId=${issueId} | projectId=${projectId} | pageUrl=${pageUrl || 'none'} | auditId=${auditId || 'none'}`);

    if (!projectId || !issueId) {
      return res.status(400).json({
        success: false,
        message: 'projectId and issueId are required',
      });
    }

    // Validate issueSource if provided
    if (issueSource && !Object.values(ISSUE_SOURCE).includes(issueSource)) {
      return res.status(400).json({
        success: false,
        message: `issueSource must be one of: ${Object.values(ISSUE_SOURCE).join(', ')}`,
      });
    }

    const result = await recommendationService.getOrGenerate({
      projectId,
      issueId,
      pageUrl:     pageUrl     || null,
      issueSource: issueSource || null,
      ruleMetadata: ruleMetadata || {},
      issueContext: issueContext || null,
      auditId:     auditId     || null,
    });

    console.log(`[RECOMMENDATION_CTRL] Response | source=${result.source} | cached=${result.cached} | time=${result.generationTimeMs}ms`);

    return res.status(200).json({
      success: true,
      data: result.recommendation,
      meta: {
        source: result.source,
        cached: result.cached,
        generationTimeMs: result.generationTimeMs,
        // Present only for schema issues built from verified evidence (see schema-evidence/).
        ...(result.schemaEvidence ? { schemaEvidence: result.schemaEvidence } : {}),
      },
    });
  } catch (error) {
    // Deliberate, safe-to-show refusals (e.g. FAQ content found but its Q/A pairs
    // couldn't be reliably extracted) — relayed as-is instead of a generic 500.
    if (error?.userFacing) {
      console.warn(`[RECOMMENDATION_CTRL] Generate refused | code=${error.code}: ${error.message}`);
      return res.status(error.statusCode || 422).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }
    console.error('[RECOMMENDATION_CTRL] Generate error:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate recommendation',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined,
    });
  }
}

const MAX_BREADCRUMB_BODY_BYTES = 32 * 1024;
const MAX_ADDRESS_BODY_BYTES = 8 * 1024;
const RULE_METADATA_KEYS = ['title', 'description', 'category', 'severity'];

/**
 * POST /recommendations/organization-address
 *
 * "Confirm Address": the site owner confirms the postal address of the business (typed, or picked from a structured
 * address ODITO found), and the Organization recommendation is regenerated from it. The address is saved as
 * "confirmed by the owner" evidence — not as an externally verified fact — and only then used.
 *
 * Body: { projectId, pageUrl, address: { streetAddress, addressLocality, addressRegion?, postalCode?, addressCountry? }, basisSource? }
 *
 * Authentication and project ownership run before this handler (router.use(auth) + validateProjectAccess). The handler trusts
 * nothing else: the page must be one of THIS project's crawled pages, only the five PostalAddress fields are accepted and
 * re-validated here (street and city required, no markup, length-capped), and nothing is invented to fill the rest.
 * It starts no audit or job, fetches nothing, and does NOT touch the website: applying is a separate, approved step.
 */
export async function confirmOrganizationAddress(req, res) {
  try {
    const declared = Number(req.get?.('content-length') || 0);
    if (declared > MAX_ADDRESS_BODY_BYTES) {
      return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The submitted address is too large.' });
    }

    const { projectId, pageUrl, address, basisSource, ruleMetadata } = req.body || {};
    if (typeof pageUrl !== 'string' || !pageUrl.trim() || pageUrl.length > 2048) {
      return res.status(400).json({ success: false, code: 'PAGE_URL_REQUIRED', message: 'pageUrl is required.' });
    }

    let validated;
    try {
      validated = validateConfirmedAddressInput(address);
    } catch (validationError) {
      return res.status(422).json({ success: false, code: 'ADDRESS_INPUT_INVALID', field: validationError.field, message: validationError.message });
    }

    // The page must be one of THIS project's crawled pages (projectId was authorised by validateProjectAccess).
    const page = await mongoose.connection.db.collection('seo_page_data').findOne(
      { projectId: new mongoose.Types.ObjectId(String(projectId)), url: pageUrl },
      { projection: { url: 1 } },
    );
    if (!page) {
      return res.status(404).json({ success: false, code: 'PAGE_NOT_FOUND', message: 'This page is not part of the project\'s latest crawl, so its recommendation cannot be regenerated.' });
    }

    const source = typeof basisSource === 'string' && ADDRESS_SOURCE_LABEL[basisSource] ? basisSource : null;
    const saved = await saveConfirmedAddress({
      projectId, fields: validated.fields,
      basis: source ? 'selected_candidate' : 'typed', basisSource: source,
      userId: req.user?.id || req.userId || null,
    });

    const metadata = {};
    for (const key of RULE_METADATA_KEYS) {
      if (typeof ruleMetadata?.[key] === 'string') metadata[key] = ruleMetadata[key].slice(0, 300);
    }

    const result = await recommendationService.getOrGenerate({
      projectId, issueId: 'organization_schema', pageUrl: page.url, issueSource: ISSUE_SOURCE.ON_PAGE, ruleMetadata: metadata,
    });

    return res.status(200).json({
      success: true,
      data: result.recommendation,
      meta: {
        source: result.source,
        cached: result.cached,
        generationTimeMs: result.generationTimeMs,
        addressChanged: saved.changed,
        ...(result.schemaEvidence ? { schemaEvidence: result.schemaEvidence } : {}),
      },
    });
  } catch (error) {
    if (error?.userFacing) {
      return res.status(error.statusCode || 422).json({ success: false, message: error.message, code: error.code });
    }
    console.error('[RECOMMENDATION_CTRL] confirmOrganizationAddress error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to confirm the address' });
  }
}

/**
 * POST /recommendations/breadcrumb-hierarchy
 *
 * The site owner confirms the parent pages that lead to a page whose breadcrumb hierarchy the crawl could not
 * determine; Odito validates them and regenerates the BreadcrumbList recommendation deterministically.
 *
 * Body: { projectId, pageUrl, items: [{ name, url }], ruleMetadata? }
 *
 * Authentication (router.use(auth)) and project ownership (validateProjectAccess) run before this handler. The
 * handler then trusts NOTHING else in the body: the page must belong to the project (a stored crawl document),
 * the canonical URL comes from that document, and every item is re-validated server-side. It never starts an
 * audit or any job, and never fetches a submitted URL.
 */
export async function regenerateBreadcrumbHierarchy(req, res) {
  try {
    const declared = Number(req.get?.('content-length') || 0);
    if (declared > MAX_BREADCRUMB_BODY_BYTES) {
      return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The submitted hierarchy is too large.' });
    }

    const { projectId, pageUrl, items, ruleMetadata } = req.body || {};
    if (typeof pageUrl !== 'string' || !pageUrl.trim() || pageUrl.length > BREADCRUMB_LIMITS.maxUrlLength) {
      return res.status(400).json({ success: false, code: 'PAGE_URL_REQUIRED', message: 'pageUrl is required.' });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, code: 'ITEMS_REQUIRED', message: 'items must be a list of { name, url }.' });
    }

    // The page must be one of THIS project's crawled pages (projectId was authorised by validateProjectAccess).
    const page = await mongoose.connection.db.collection('seo_page_data').findOne(
      { projectId: new mongoose.Types.ObjectId(String(projectId)), url: pageUrl },
      { projection: { url: 1, canonical: 1 } },
    );
    if (!page) {
      return res.status(404).json({ success: false, code: 'PAGE_NOT_FOUND', message: 'This page is not part of the project\'s latest crawl, so its hierarchy cannot be verified.' });
    }

    const display = pickDisplayUrl({ canonical: Array.isArray(page.canonical) ? page.canonical[0] : page.canonical, pageUrl: page.url });
    const validation = validateBreadcrumbHierarchy({ items }, {
      canonicalUrl: display.trusted ? display.url : null,
      canonicalTrusted: display.trusted,
      pageUrl: page.url,
    });
    if (!validation.ok) {
      return res.status(422).json({
        success: false,
        code: 'BREADCRUMB_INPUT_INVALID',
        message: 'The breadcrumb hierarchy could not be validated. Nothing was generated.',
        errors: validation.errors,
        canonical: { url: display.url, trusted: display.trusted },
      });
    }

    // How each item came about (taken from a discovered trail / a suggestion accepted / typed / edited) is recorded for the audit trail only.
    const ORIGINS = new Set(['discovered', 'suggested', 'manual', 'edited']);
    const withOrigin = validation.items.map((it, i) => ({ ...it, origin: ORIGINS.has(items[i]?.origin) ? items[i].origin : 'manual' }));
    const saved = await saveUserBreadcrumbEvidence({
      projectId, pageUrl: page.url, items: withOrigin,
      canonicalUrl: display.trusted ? display.url : null,
      canonicalSource: validation.currentPage.source,
      userId: req.user?.id || req.userId || null,
    });

    const metadata = {};
    for (const key of RULE_METADATA_KEYS) {
      if (typeof ruleMetadata?.[key] === 'string') metadata[key] = ruleMetadata[key].slice(0, 300);
    }

    const result = await recommendationService.getOrGenerate({
      projectId, issueId: 'breadcrumblist_schema', pageUrl: page.url, issueSource: ISSUE_SOURCE.ON_PAGE, ruleMetadata: metadata,
    });

    return res.status(200).json({
      success: true,
      data: result.recommendation,
      meta: {
        source: result.source,
        cached: result.cached,
        generationTimeMs: result.generationTimeMs,
        evidenceChanged: saved.changed,
        warnings: validation.warnings,
        ...(result.schemaEvidence ? { schemaEvidence: result.schemaEvidence } : {}),
      },
    });
  } catch (error) {
    if (error?.userFacing) {
      return res.status(error.statusCode || 422).json({ success: false, message: error.message, code: error.code });
    }
    console.error('[RECOMMENDATION_CTRL] regenerateBreadcrumbHierarchy error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to regenerate the breadcrumb recommendation' });
  }
}

/**
 * POST /recommendations/invalidate/rule
 * 
 * Invalidate all cached recommendations for a specific rule.
 * Used when rule logic changes.
 * 
 * Body:
 *   - ruleId (required): Rule ID to invalidate
 *   - reason (optional): Invalidation reason
 */
export async function invalidateByRule(req, res) {
  try {
    const { ruleId, reason } = req.body;

    if (!ruleId) {
      return res.status(400).json({
        success: false,
        message: 'ruleId is required',
      });
    }

    const result = await recommendationService.invalidateByRule(ruleId, reason || 'rule_version_change');

    return res.status(200).json({
      success: true,
      data: {
        invalidated: result.modifiedCount,
        ruleId,
        reason: reason || 'rule_version_change',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Invalidate by rule error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to invalidate recommendations',
    });
  }
}

/**
 * POST /recommendations/invalidate/project
 * 
 * Invalidate all cached recommendations for a project.
 * Used for full refresh.
 * 
 * Body:
 *   - projectId (required): Project ID to invalidate
 *   - reason (optional): Invalidation reason
 */
export async function invalidateByProject(req, res) {
  try {
    const { projectId, reason } = req.body;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    const result = await recommendationService.invalidateByProject(projectId, reason || 'manual');

    return res.status(200).json({
      success: true,
      data: {
        invalidated: result.modifiedCount,
        projectId,
        reason: reason || 'manual',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Invalidate by project error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to invalidate recommendations',
    });
  }
}

/**
 * GET /recommendations/:id?projectId=
 *
 * Fetches one recommendation by id, scoped to the requesting project —
 * used by the WordPress apply-fix confirmation dialog to show the EXACT
 * recommendation content a Task is linked to (Task.recommendationId),
 * rather than trusting whatever the recommendation-generation mutation's
 * own local, ephemeral UI state happens to hold (which may not be the same
 * recommendation the task actually points to, or may not exist at all
 * after a page reload). validateProjectAccess() already confirms the
 * requesting user owns `projectId`; the projectId match below additionally
 * confirms this SPECIFIC recommendation belongs to that project, the same
 * cross-project check wordPressSeoFixService.validateFix() enforces
 * server-side before ever writing to WordPress — this is a read path, but
 * it must never leak a recommendation's content across projects either.
 */
export async function getRecommendationById(req, res) {
  try {
    const { recommendationId } = req.params;
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    const recommendation = await Recommendation.findById(recommendationId).lean();
    if (!recommendation || recommendation.projectId.toString() !== projectId.toString()) {
      return res.status(404).json({ success: false, message: 'Recommendation not found' });
    }

    return res.status(200).json({ success: true, data: recommendation });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] getRecommendationById error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch recommendation' });
  }
}

/**
 * GET /recommendations/stats/:projectId
 *
 * Get recommendation generation stats for a project.
 */
export async function getStats(req, res) {
  try {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    const stats = await recommendationService.getStats(projectId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Stats error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get recommendation stats',
    });
  }
}

/**
 * POST /recommendations/purge-fallbacks
 * 
 * One-time cleanup: invalidate all recommendations that were generated
 * by the fallback path (poisoned cache from before Claude was configured).
 * 
 * Body:
 *   - projectId (optional): Scope purge to a project. If omitted, purges ALL fallbacks.
 */
export async function purgeFallbacks(req, res) {
  try {
    const { projectId } = req.body;

    const filter = {
      invalidatedAt: null,
      $or: [
        { generatedBy: 'fallback' },
        // Also catch old poisoned entries that were stored as 'template' 
        // but contain the generic fallback text
        {
          generatedBy: 'template',
          'sections.recommendedFix': { $regex: /^Address this issue to improve/i },
        },
      ],
    };

    if (projectId) {
      filter.projectId = projectId;
    }

    const result = await Recommendation.updateMany(filter, {
      $set: {
        invalidatedAt: new Date(),
        invalidationReason: 'purge_fallback_cache',
      },
    });

    console.log(`[RECOMMENDATION] Purged ${result.modifiedCount} fallback cache entries`);

    return res.status(200).json({
      success: true,
      data: {
        purged: result.modifiedCount,
        reason: 'purge_fallback_cache',
        scope: projectId || 'all',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Purge fallbacks error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to purge fallback cache',
    });
  }
}
