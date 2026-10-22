/**
 * campaignGenerationService — orchestrates Claude campaign generation
 * (spec §17 / §18 / §32 / §34).
 *
 *   validate brief → resolve Google Ads account → create draft (generating)
 *   → build safe context → call Claude → map output → validate structure
 *   → persist → record AI metadata → ready
 *
 * On ANY failure the draft is moved to `failed` and a safe error record is
 * written — a draft is NEVER left stuck in `generating`, and NEVER becomes
 * `ready` unless Claude returned, the output parsed, the strict structure
 * validation passed, and the campaign persisted.
 *
 * Domain boundary (spec §34): this service owns intent/strategy/lifecycle.
 * Claude only produces a draft. Nothing here touches the Google Ads API.
 *
 * The controller stays thin — it does auth + response shaping only and calls
 * generateCampaign(). Prompt construction, the Claude call, structure
 * validation and MongoDB writes all live below or in the collaborators.
 */

import { randomUUID } from 'node:crypto';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ValidationError } from '../../../utils/ErrorUtil.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';

import campaignDraftService from './campaignDraftService.js';
import { validateAndNormalizeBrief } from './campaignBriefValidator.js';
import { buildGenerationContext } from './campaignContextBuilder.js';
import { mapGeneratedCampaign } from './generatedCampaignMapper.js';
import { resolveTrustedSitelinkUrls } from './sitelinkResolver.js';
import { validateCampaignDraftStructure } from '../validator/campaignStructureValidator.js';
import { validateCreativeQuality, validateCampaignAssets } from '../validator/creativeQualityValidator.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from '../prompts/generateCampaignPrompt.js';
import realClaudeProvider from '../providers/claudeCampaignProvider.js';
import { DEFAULT_BIDDING_STRATEGY_BY_OBJECTIVE, DEFAULT_LANGUAGE, MAX_CREATIVE_REPAIR_ATTEMPTS } from '../constants/generationConfig.js';
import { GOOGLE_ADS_CUSTOMER_ID_PATTERN } from '../constants/aiCampaignEnums.js';

const GOOGLE_ADS_PURPOSE = 'google_ads';

/**
 * Provider seam. `generateCampaign()` uses, in order: an explicit `provider`
 * argument → this override → the real Claude provider. The override exists
 * so controller/route-level tests (which cannot pass an argument through the
 * HTTP layer) can inject MockClaudeCampaignProvider. Production code never
 * calls setProviderOverride.
 */
let _providerOverride = null;
export function setProviderOverride(provider) { _providerOverride = provider || null; }
export function resetProviderOverride() { _providerOverride = null; }

/**
 * Classified, client-safe generation failure. `.code` is machine-readable,
 * `.httpStatus` is what the controller should return, `.message` is safe to
 * show a user, `.details` (optional) carries our OWN validator messages only.
 */
export class CampaignGenerationError extends Error {
  constructor(code, httpStatus, message, details = null) {
    super(message);
    this.name = 'CampaignGenerationError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.type = 'CAMPAIGN_GENERATION_ERROR';
    if (details) this.details = details;
  }
}

// Provider error code → safe client-facing failure.
function classifyProviderError(error) {
  const code = error?.code || error?.message;
  switch (code) {
    case 'CLAUDE_NOT_CONFIGURED':
      return new CampaignGenerationError('AI_UNAVAILABLE', 503, 'AI campaign generation is not configured on this server.');
    case 'CLAUDE_TIMEOUT':
      return new CampaignGenerationError('AI_TIMEOUT', 504, 'AI campaign generation timed out. Please try again.');
    case 'CLAUDE_RATE_LIMITED': {
      const e = new CampaignGenerationError('AI_RATE_LIMITED', 503, 'AI campaign generation is busy. Please retry shortly.');
      if (error.retryAfter) e.retryAfter = error.retryAfter;
      return e;
    }
    case 'CLAUDE_OVERLOADED':
      return new CampaignGenerationError('AI_OVERLOADED', 503, 'The AI provider is temporarily overloaded. Please retry shortly.');
    case 'CLAUDE_AUTH':
      return new CampaignGenerationError('AI_PROVIDER_ERROR', 502, 'The AI provider rejected the request.');
    case 'CLAUDE_BAD_OUTPUT':
      return new CampaignGenerationError('AI_BAD_OUTPUT', 502, 'The AI returned an unusable response. Please try again.');
    case 'CLAUDE_NETWORK_ERROR':
      return new CampaignGenerationError('AI_PROVIDER_ERROR', 502, 'Could not reach the AI provider. Please try again.');
    default:
      if (typeof code === 'string' && code.startsWith('CLAUDE_HTTP_')) {
        return new CampaignGenerationError('AI_PROVIDER_ERROR', 502, 'The AI provider returned an error.');
      }
      return new CampaignGenerationError('GENERATION_FAILED', 500, 'Campaign generation failed. Please try again.');
  }
}

/**
 * A SANITIZED structural diagnostic of a mapped (pre-validation) campaign —
 * shapes, counts, and text LENGTHS only, never the generated ad copy itself
 * (headlines/descriptions/keyword text). Safe to log at any verbosity: no
 * business content, no PII, no provider payload. Exists so a
 * CAMPAIGN_STRUCTURE_INVALID failure is diagnosable from logs alone —
 * without re-calling Claude and without dumping generated copy.
 */
function summarizeGeneratedStructure(mapped) {
  const adGroups = Array.isArray(mapped?.adGroups) ? mapped.adGroups : [];
  return {
    campaignKeys: mapped?.campaign ? Object.keys(mapped.campaign) : [],
    adGroupCount: adGroups.length,
    adGroups: adGroups.map((ag) => {
      const ads = Array.isArray(ag.ads) ? ag.ads : [];
      const headlineLengths = ads.flatMap((ad) => (Array.isArray(ad.headlines) ? ad.headlines.map((h) => h?.text?.length ?? 0) : []));
      const descriptionLengths = ads.flatMap((ad) => (Array.isArray(ad.descriptions) ? ad.descriptions.map((d) => d?.text?.length ?? 0) : []));
      return {
        keywordCount: Array.isArray(ag.keywords) ? ag.keywords.length : 0,
        negativeKeywordCount: Array.isArray(ag.negativeKeywords) ? ag.negativeKeywords.length : 0,
        keywordMatchTypes: [...new Set((ag.keywords || []).map((k) => k.matchType))],
        adCount: ads.length,
        headlineCounts: ads.map((ad) => (Array.isArray(ad.headlines) ? ad.headlines.length : 0)),
        descriptionCounts: ads.map((ad) => (Array.isArray(ad.descriptions) ? ad.descriptions.length : 0)),
        maxHeadlineLength: headlineLengths.length ? Math.max(...headlineLengths) : 0,
        maxDescriptionLength: descriptionLengths.length ? Math.max(...descriptionLengths) : 0,
      };
    }),
  };
}

/** Build a minimal, Phase-1-valid campaign skeleton from the brief. */
function buildSkeletonCampaign(brief, project) {
  const namedBy = brief.businessName || project?.project_name || 'Campaign';
  return {
    name: `${namedBy} — ${brief.location.name}`.slice(0, 255),
    objective: brief.campaignGoal,
    dailyBudget: brief.dailyBudget, // major units; campaignDraftService → micros
    currency: brief.currency,
    biddingStrategy: DEFAULT_BIDDING_STRATEGY_BY_OBJECTIVE[brief.campaignGoal] || 'MAXIMIZE_CONVERSIONS',
    locations: [{ name: brief.location.name, countryCode: brief.location.countryCode, type: brief.location.type }],
    languages: [{ ...DEFAULT_LANGUAGE }],
  };
}

/**
 * Resolve the Google Ads customer id the draft must carry. Explicit override
 * (validated) wins; otherwise the project's connected `google_ads` account.
 */
async function resolveGoogleAdsCustomerId({ userId, projectId, override }) {
  if (override != null && String(override).trim() !== '') {
    const cleaned = String(override).replace(/[\s-]/g, '');
    if (!GOOGLE_ADS_CUSTOMER_ID_PATTERN.test(cleaned)) {
      throw new ValidationError('googleAdsCustomerId must be a 10-digit Google Ads customer ID (no dashes)');
    }
    return cleaned;
  }
  const conn = await GoogleConnection.findActiveConnection(userId, projectId, GOOGLE_ADS_PURPOSE);
  const fromConn = conn?.google_ads_customer_id ? String(conn.google_ads_customer_id).replace(/[\s-]/g, '') : null;
  if (fromConn && GOOGLE_ADS_CUSTOMER_ID_PATTERN.test(fromConn)) return fromConn;

  throw new ValidationError(
    'This project has no connected Google Ads account. Connect a Google Ads account, or pass googleAdsCustomerId, before generating a campaign.',
  );
}

/**
 * Generate a campaign draft from a brief.
 *
 * @param {object} args
 * @param {string} args.projectId               authorized project id
 * @param {string|import('mongoose').Types.ObjectId} args.userId  authenticated user id
 * @param {object} args.project                 the authorized SeoProject (req.project)
 * @param {object} args.brief                   raw campaign brief from the request
 * @param {string} [args.googleAdsCustomerId]   optional explicit account override
 * @param {object} [args.provider]              provider impl (defaults to the real Claude provider; tests inject a mock)
 * @returns {Promise<{ draft: object, generationId: string, generation: object }>}
 * @throws {ValidationError|CampaignGenerationError}
 */
export async function generateCampaign({
  projectId,
  userId,
  project,
  brief,
  googleAdsCustomerId = null,
  provider = null,
}) {
  const activeProvider = provider || _providerOverride || realClaudeProvider;

  // ── 1. Validate the brief (no Claude call if this throws) ──────────────
  const normalizedBrief = validateAndNormalizeBrief(brief);

  // ── 1b. Fail fast on a misconfigured server — before creating any draft.
  if (!activeProvider.isAvailable()) {
    throw new CampaignGenerationError('AI_UNAVAILABLE', 503, 'AI campaign generation is not configured on this server.');
  }

  // ── 2. Resolve the Google Ads customer id ─────────────────────────────
  const customerId = await resolveGoogleAdsCustomerId({ userId, projectId, override: googleAdsCustomerId });

  // ── 3. Create the draft (status: draft) then move it to generating ────
  const skeleton = buildSkeletonCampaign(normalizedBrief, project);
  let draft = await campaignDraftService.createDraft({
    projectId,
    userId,
    googleAdsCustomerId: customerId,
    campaign: skeleton,
    adGroups: [],
  });
  draft = await campaignDraftService.transitionStatus(draft._id, 'generating');

  const generationId = `gen-${randomUUID()}`;
  const startedAt = Date.now();
  LoggerUtil.info('AI campaign generation started', {
    generationId,
    draftId: draft._id.toString(),
    projectId: String(projectId),
    objective: normalizedBrief.campaignGoal,
    promptVersion: PROMPT_VERSION,
    briefFields: Object.keys(brief || {}), // field names only — never values
  });

  try {
    // ── 4. Build safe context + prompts ────────────────────────────────
    const context = buildGenerationContext({ project, brief: normalizedBrief });
    const system = buildSystemPrompt();

    // The ONLY source of truth for which URLs a sitelink may point at (see
    // sitelinkResolver.js) — computed once, outside the repair loop, since
    // it depends only on the brief/context, never on what Claude returns.
    const { urls: trustedSitelinkUrls } = resolveTrustedSitelinkUrls({ brief: normalizedBrief, context });

    // ── 5-7. Call Claude → map → validate, with a BOUNDED creative-quality
    // repair loop (spec §20/§21). Structural (shape) failures are NEVER
    // retried here — a malformed tool call is a different failure class
    // than "valid but creatively thin", and campaignStructureValidator.js
    // remains the one final SHAPE authority. Only creativeQualityValidator.js
    // issues (too few headlines/descriptions, near-duplicates, template
    // repetition, missing keyword coverage, sitelink/callout/snippet
    // problems) trigger a repair attempt: the SAME generation request is
    // re-sent to Claude with an appended <previous_attempt_feedback> block
    // (see generateCampaignPrompt.js) rather than inventing a second,
    // narrower "fix just this asset" API — reusing the existing single-call
    // architecture exactly as the spec permits when targeted repair doesn't
    // fit cleanly. Hard cap: MAX_CREATIVE_REPAIR_ATTEMPTS additional calls,
    // never infinite; if still invalid after that, generation fails with an
    // accurate reason instead of silently persisting weak creative.
    let mapped;
    let normalizedForValidation;
    let structuralSummary;
    let providerResult;
    let repairAttempts = 0;
    let qualityIssues = [];
    let qualityMetrics = null;
    let repairFeedback = [];

    for (;;) {
      const user = buildUserPrompt({ brief: normalizedBrief, context, repairFeedback });

      // ── 5. Call Claude ────────────────────────────────────────────────
      providerResult = await activeProvider.generateCampaign({ system, user, generationId });

      // ── 6. Map output onto the Phase 1 draft shape (model never trusted)
      mapped = mapGeneratedCampaign({
        parsed: providerResult.parsed,
        brief: normalizedBrief,
        context,
      });

      // Claude regularly overshoots the RSA character limits by a small
      // margin despite prompt guidance (Anthropic's tool-use maxLength is a
      // nudge, not a guarantee) — the mapper trims those deterministically at
      // a word boundary rather than failing the whole generation. Visible,
      // never silent: logged with lengths only, never the generated text.
      if (mapped.truncations.length > 0) {
        LoggerUtil.info('AI campaign generation trimmed over-length assets', {
          generationId,
          draftId: draft._id.toString(),
          repairAttempt: repairAttempts,
          count: mapped.truncations.length,
          truncations: mapped.truncations,
        });
      }

      // ── 7. Strict structure validation — the FINAL authority ───────────
      // Validate the EXACT shape that will be persisted: run it through the
      // Phase 1 normalizers (major-unit budget → integer micros, code casing,
      // stable ids) first, so campaignStructureValidator sees dailyBudgetMicros
      // just as it does for a normal create/update. Nothing is persisted yet —
      // a failure here leaves the draft as an empty skeleton in `generating`,
      // which the catch block then flips to `failed`.
      structuralSummary = summarizeGeneratedStructure(mapped);

      try {
        normalizedForValidation = {
          campaign: campaignDraftService._internals.normalizeCampaignInput(mapped.campaign),
          adGroups: campaignDraftService._internals.normalizeAdGroups(mapped.adGroups) ?? [],
        };
      } catch (normErr) {
        const genErr = new CampaignGenerationError(
          'CAMPAIGN_STRUCTURE_INVALID',
          422,
          'The generated campaign did not pass Odito validation. Please try again.',
          [normErr.message],
        );
        genErr.structuralSummary = structuralSummary;
        throw genErr;
      }
      const structResult = validateCampaignDraftStructure(normalizedForValidation, {
        requireAdGroups: true,
        strictRsa: true,
      });
      if (!structResult.valid) {
        const genErr = new CampaignGenerationError(
          'CAMPAIGN_STRUCTURE_INVALID',
          422,
          'The generated campaign did not pass Odito validation. Please try again.',
          structResult.errors,
        );
        genErr.structuralSummary = structuralSummary;
        throw genErr;
      }

      // ── 7b. Odito's own creative-quality gate (spec §20/§21) ───────────
      const rsaQuality = validateCreativeQuality(normalizedForValidation);
      const assetQuality = validateCampaignAssets(normalizedForValidation.campaign, { trustedUrls: trustedSitelinkUrls });
      qualityIssues = [...rsaQuality.issues, ...assetQuality.issues];
      qualityMetrics = rsaQuality.metrics;

      if (qualityIssues.length === 0) break;

      if (repairAttempts >= MAX_CREATIVE_REPAIR_ATTEMPTS) {
        const genErr = new CampaignGenerationError(
          'CREATIVE_QUALITY_INVALID',
          422,
          'The generated campaign did not meet Odito\'s creative-quality bar after retrying. Please try again.',
          qualityIssues.map((i) => i.message),
        );
        genErr.structuralSummary = structuralSummary;
        genErr.qualityMetrics = qualityMetrics;
        throw genErr;
      }

      repairAttempts += 1;
      repairFeedback = qualityIssues.map((i) => i.message);
      LoggerUtil.info('AI campaign generation requesting creative-quality repair', {
        generationId,
        draftId: draft._id.toString(),
        repairAttempt: repairAttempts,
        issueCount: qualityIssues.length,
        issueCodes: [...new Set(qualityIssues.map((i) => i.code))],
      });
    }

    if (repairAttempts > 0) {
      LoggerUtil.info('AI campaign generation creative-quality repair succeeded', {
        generationId,
        draftId: draft._id.toString(),
        repairAttempts,
      });
    }

    // ── 8. Persist the generated campaign (campaignDraftService re-normalizes
    //      and re-validates leniently on its own — that is fine, we have
    //      already proven the strict shape above) ─────────────────────────
    await campaignDraftService.updateDraft(draft._id, {
      updates: { campaign: mapped.campaign, adGroups: mapped.adGroups },
      userId,
    });

    // ── 9. Record AI provenance ───────────────────────────────────────
    await campaignDraftService.recordAiGeneration(draft._id, {
      provider: 'CLAUDE',
      model: providerResult.model,
      promptVersion: PROMPT_VERSION,
      generationId,
      usage: providerResult.usage,
      generationDurationMs: providerResult.durationMs ?? (Date.now() - startedAt),
    });

    // ── 10. → ready (only now) ────────────────────────────────────────
    const ready = await campaignDraftService.transitionStatus(draft._id, 'ready');

    LoggerUtil.info('AI campaign generation completed', {
      generationId,
      draftId: ready._id.toString(),
      status: ready.status,
      model: providerResult.model,
      adGroups: ready.adGroups.length,
      durationMs: Date.now() - startedAt,
      inputTokens: providerResult.usage?.inputTokens ?? null,
      outputTokens: providerResult.usage?.outputTokens ?? null,
      repairAttempts,
      creativeQualityMetrics: qualityMetrics,
      assetObservability: mapped.assetObservability,
    });

    return {
      draft: ready,
      generationId,
      generation: {
        status: ready.status,
        model: providerResult.model,
        promptVersion: PROMPT_VERSION,
        durationMs: Date.now() - startedAt,
        repairAttempts,
        assetObservability: mapped.assetObservability,
      },
    };
  } catch (rawError) {
    const failure = rawError instanceof CampaignGenerationError
      ? rawError
      : (rawError?.type === 'VALIDATION_ERROR' ? rawError : classifyProviderError(rawError));

    // Never let bookkeeping mask the real failure.
    await campaignDraftService.transitionStatus(draft._id, 'failed').catch((e) => {
      LoggerUtil.error('Failed to mark draft failed after generation error', e, { draftId: draft._id.toString(), generationId });
    });
    await campaignDraftService.recordAiGenerationError(draft._id, {
      generationId,
      code: failure.code || failure.type || 'GENERATION_FAILED',
      message: failure.message,
    }).catch(() => {});

    // Safe, structured diagnostics only — `failure.details` is always our
    // OWN validator's error strings (e.g. "adGroups[0].ads[0].headlines[2]
    // .text must be at most 30 characters"), never raw Claude/provider
    // content, and `structuralSummary` (see summarizeGeneratedStructure)
    // carries shapes/counts/lengths only, never generated ad copy text.
    //
    // `claudeProviderDetail`: when the underlying failure is an Anthropic
    // HTTP-level rejection (CLAUDE_HTTP_4xx/5xx — e.g. a malformed request,
    // an invalid/retired model id, a bad tool schema), claudeCampaignProvider.js
    // already captures `httpStatus` + a 300-char `bodySnippet` of Anthropic's
    // own error response on the thrown error — that detail was previously
    // discarded here (LoggerUtil.error only serializes name/message/stack
    // off the error object), leaving a CLAUDE_HTTP_400 completely
    // undiagnosable from logs alone. Anthropic's error body is a safe,
    // already-truncated, provider-authored diagnostic (never a Google/OAuth
    // credential, never generated ad copy) — logging it here (server-side
    // only) is exactly what claudeCampaignProvider.js's own "never surfaced
    // to the client" comment anticipates as its intended use.
    const claudeProviderDetail = rawError?.httpStatus
      ? { httpStatus: rawError.httpStatus, bodySnippet: rawError.bodySnippet || null }
      : null;

    LoggerUtil.error('AI campaign generation failed', rawError, {
      generationId,
      draftId: draft._id.toString(),
      code: failure.code || 'GENERATION_FAILED',
      durationMs: Date.now() - startedAt,
      validationErrors: failure.details || null,
      structuralSummary: failure.structuralSummary || null,
      creativeQualityMetrics: failure.qualityMetrics || null,
      claudeProviderDetail,
    });

    failure.draftId = draft._id.toString();
    failure.generationId = generationId;
    throw failure;
  }
}

export default { generateCampaign, CampaignGenerationError };
