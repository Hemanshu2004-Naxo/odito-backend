/**
 * AI Campaign Generation — configuration (Phase 2).
 *
 * Every knob for the Claude campaign-generation layer lives here so nothing
 * is hardcoded across the codebase. Env overrides follow the repo's existing
 * conventions (see config/env.js, middleware/authRateLimiters.js):
 *   - read at module load, plain `process.env.X || default`
 *   - a numeric helper that rejects non-positive / non-finite values
 *
 * The model is intentionally NOT pinned in code — models change over time.
 * Precedence: CLAUDE_CAMPAIGN_MODEL → CLAUDE_MODEL (the value the existing
 * recommendations Claude integration already uses) → a sane default.
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// ── Claude model + call budget ────────────────────────────────────────────
export const CLAUDE_CAMPAIGN_MODEL =
  process.env.CLAUDE_CAMPAIGN_MODEL ||
  process.env.CLAUDE_MODEL ||
  'claude-sonnet-4-6';

export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

// A single generation is one Claude call. 90s matches the existing
// recommendations Claude timeout (Sonnet worst-case queue + inference + net).
export const GENERATION_TIMEOUT_MS = num(process.env.AI_CAMPAIGN_TIMEOUT_MS, 90_000);

// Max output tokens for the campaign JSON. 3–8 ad groups with keywords + RSA
// assets comfortably fits well under this.
export const GENERATION_MAX_OUTPUT_TOKENS = num(process.env.AI_CAMPAIGN_MAX_OUTPUT_TOKENS, 8_000);

// Conservative retry policy — only TRANSIENT provider failures are retried
// (see claudeCampaignProvider.retryDelayFor). Never retried: auth failure,
// invalid request, malformed output, structure-validation failure.
export const GENERATION_MAX_RETRIES = num(process.env.AI_CAMPAIGN_MAX_RETRIES, 2);
export const GENERATION_RETRY_BASE_MS = num(process.env.AI_CAMPAIGN_RETRY_BASE_MS, 1_500);

// ── Campaign brief input limits (validated BEFORE any Claude call) ─────────
export const BRIEF_LIMITS = Object.freeze({
  businessNameMax: 150,
  businessDescriptionMax: 1_500,
  targetAudienceMax: 500,
  additionalInstructionsMax: 2_000,
  landingPageUrlMax: 2_000,
  // Sanity guard only — NOT a business rule. Currency-agnostic upper bound
  // on the daily budget in MAJOR currency units (e.g. 100000 covers
  // ₹100,000/day and $100,000/day). Tune per deployment.
  dailyBudgetMajorMax: num(process.env.AI_CAMPAIGN_MAX_DAILY_BUDGET, 100_000),
  // Whole serialized brief size guard against prompt-bloat / token abuse.
  totalSerializedMax: num(process.env.AI_CAMPAIGN_MAX_BRIEF_BYTES, 12_000),
});

// ── Generated-campaign size limits ───────────────────────────────────────
// Initial generation limits — NOT immutable Google Ads limits. Headline /
// description per-ad counts deliberately align with RSA_LIMITS in
// aiCampaignEnums.js (3–15 headlines, 2–4 descriptions), which the strict
// structure validator enforces as the final authority.
export const CAMPAIGN_LIMITS = Object.freeze({
  adGroupsMin: num(process.env.AI_CAMPAIGN_ADGROUPS_MIN, 3),
  adGroupsMax: num(process.env.AI_CAMPAIGN_ADGROUPS_MAX, 8),
  keywordsPerGroupMin: num(process.env.AI_CAMPAIGN_KEYWORDS_MIN, 5),
  keywordsPerGroupMax: num(process.env.AI_CAMPAIGN_KEYWORDS_MAX, 20),
  negativeKeywordsMin: num(process.env.AI_CAMPAIGN_NEGATIVES_MIN, 5),
  negativeKeywordsMax: num(process.env.AI_CAMPAIGN_NEGATIVES_MAX, 20),
  adsPerGroupMin: num(process.env.AI_CAMPAIGN_ADS_MIN, 1),
  adsPerGroupMax: num(process.env.AI_CAMPAIGN_ADS_MAX, 3),
  headlinesPerAdMin: 3,
  headlinesPerAdMax: 15,
  descriptionsPerAdMin: 2,
  descriptionsPerAdMax: 4,
});

// ── RSA creative-quality targets ──────────────────────────────────────────
// Distinct from RSA_LIMITS/CAMPAIGN_LIMITS above on purpose: those are the
// outer bounds Google Ads itself enforces (a campaign with 3 headlines is
// still a VALID Google Ads campaign). These are Odito's own, stricter
// pre-publish quality bar — the fix for the reported "Average Ad Strength"
// issue, where a generation that produced only 6 headlines / 3 descriptions
// was Google-API-valid but creatively thin. `campaignGenerationService.js`
// enforces `*QualityMin` (via creativeQualityValidator.js) before a
// generation is allowed to reach `ready`; it never rejects an otherwise-
// valid MANUALLY-edited draft a user intentionally trimmed down (Phase 1/3
// CRUD keeps using the looser RSA_LIMITS only — see campaignDraftService.js).
export const RSA_QUALITY_TARGETS = Object.freeze({
  headlinesTarget: num(process.env.AI_CAMPAIGN_HEADLINES_TARGET, 15),
  headlinesQualityMin: num(process.env.AI_CAMPAIGN_HEADLINES_QUALITY_MIN, 12),
  descriptionsTarget: num(process.env.AI_CAMPAIGN_DESCRIPTIONS_TARGET, 4),
  descriptionsQualityMin: num(process.env.AI_CAMPAIGN_DESCRIPTIONS_QUALITY_MIN, 4),
  adsPerGroupTarget: num(process.env.AI_CAMPAIGN_ADS_TARGET, 2),
});

// ── Campaign extension asset targets ──────────────────────────────────────
// `sitelinksTarget` is aspirational — Odito has no page-discovery/crawl
// pipeline feeding campaign generation today (confirmed: campaignContextBuilder.js
// only ever knows the single submitted landing page URL + the project's
// main website URL), so the ACTUAL number of sitelinks a generation can
// safely produce is capped by how many genuinely distinct, already-trusted
// URLs exist for this project (realistically 1-2 right now) — see
// sitelinkResolver.js. This target exists so that IF Odito later adds real
// page discovery, generation automatically scales toward it with no code
// change here.
export const ASSET_TARGETS = Object.freeze({
  sitelinksTarget: num(process.env.AI_CAMPAIGN_SITELINKS_TARGET, 6),
  calloutsTarget: num(process.env.AI_CAMPAIGN_CALLOUTS_TARGET, 4),
  calloutsMin: num(process.env.AI_CAMPAIGN_CALLOUTS_MIN, 2),
  structuredSnippetValuesTarget: num(process.env.AI_CAMPAIGN_SNIPPET_VALUES_TARGET, 4),
  structuredSnippetValuesMin: num(process.env.AI_CAMPAIGN_SNIPPET_VALUES_MIN, 3),
});

// ── Bounded creative repair (spec: never infinite, never a second silent
// generation contract) ────────────────────────────────────────────────────
export const MAX_CREATIVE_REPAIR_ATTEMPTS = num(process.env.AI_CAMPAIGN_MAX_CREATIVE_REPAIRS, 2);

// ── Rate limiting (see middleware/aiCampaignRateLimiter.js) ───────────────
export const RATE_LIMIT = Object.freeze({
  enabled: process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED !== 'false',
  windowMs: num(process.env.AI_CAMPAIGN_GENERATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.AI_CAMPAIGN_GENERATE_MAX, 10),
});

// ── Default bidding strategy per objective ────────────────────────────────
// A starting point the user (Phase 3) or a later phase can change; Claude
// may also suggest one, but only from BIDDING_STRATEGIES.
export const DEFAULT_BIDDING_STRATEGY_BY_OBJECTIVE = Object.freeze({
  LEADS: 'MAXIMIZE_CONVERSIONS',
  SALES: 'MAXIMIZE_CONVERSIONS',
  WEBSITE_TRAFFIC: 'MAXIMIZE_CLICKS',
  AWARENESS: 'MAXIMIZE_CLICKS',
});

export const DEFAULT_LANGUAGE = Object.freeze({ code: 'en', name: 'English' });
