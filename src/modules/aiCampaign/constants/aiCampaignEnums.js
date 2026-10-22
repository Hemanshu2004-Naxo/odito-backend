/**
 * AI Campaign Builder — shared enums, controlled vocabularies, and the
 * status transition table.
 *
 * Single source of truth for every finite-value field on AiCampaignDraft.
 * The model, the request validators, and the structure validator all import
 * from here so a value can never be "valid" in one layer and rejected in
 * another.
 *
 * Where a value maps onto a real Google Ads API enum, the SAME spelling is
 * used deliberately (BROAD/PHRASE/EXACT, RESPONSIVE_SEARCH_AD,
 * MAXIMIZE_CONVERSIONS, …) so Phase 6 publishing can hand these straight to
 * the existing google-ads-api client with no translation layer. This module
 * does NOT import anything from the Google Ads modules — it only reuses the
 * vocabulary, not the code (see src/modules/app_user/model/GoogleAdsKeyword.js,
 * which independently defines the same match-type strings for synced data).
 */

// ── Draft lifecycle ────────────────────────────────────────────────────────
// draft → generating → ready → validated → publishing → published, plus a
// terminal `failed`. Phase 1 only ever creates drafts in `draft`; the later
// states and the transition machine below exist so no schema/data rewrite is
// needed when Phases 2/5/6 start driving them.
export const DRAFT_STATUSES = [
  'draft',
  'generating',
  'ready',
  'validated',
  'publishing',
  'published',
  'failed',
];

export const DEFAULT_DRAFT_STATUS = 'draft';

/**
 * Allowed forward status transitions. A small local table — same approach as
 * modules/tasks/model/Task.js (VALID_TRANSITIONS) and
 * modules/social_meta/model/SocialImportBatch.js (STATUS_TRANSITIONS) — not a
 * state-machine dependency.
 *
 * Phase 1 never exposes a status mutation endpoint (PATCH rejects `status`
 * outright), so nothing calls canTransitionDraftStatus() in production yet.
 * It is unit-tested and ready for Phase 2 (generating), Phase 5 (validated)
 * and Phase 6 (publishing/published).
 */
export const DRAFT_STATUS_TRANSITIONS = Object.freeze({
  draft: ['generating', 'ready'],
  generating: ['ready', 'failed'],
  ready: ['validated', 'generating', 'failed'],
  validated: ['publishing', 'ready', 'failed'],
  // `failed` -> `publishing` (Phase 6, spec §43 — a genuine, narrow, additive
  // gap): a campaign that failed partway through publishing (some Google Ads
  // resources may already exist — see AiCampaignPublishAttempt) must be able
  // to retry publishing directly. Routing it back through `draft`/`generating`
  // first would be semantically wrong (the campaign CONTENT didn't fail,
  // only the publish attempt did) and would force an unrelated re-generation
  // just to re-attempt the exact same publish. campaignPublishService.js is
  // the only caller that ever exercises this edge, and only when a
  // retryable AiCampaignPublishAttempt already exists for the draft's
  // current version — never a bare status flip.
  publishing: ['published', 'failed'],
  published: [],
  failed: ['draft', 'generating', 'publishing'],
});

/**
 * True if `to` is a permitted next status from `from`. A no-op
 * (from === to) is always allowed so an idempotent re-write never trips the
 * check. An unknown `from` has no legal transitions.
 */
export function canTransitionDraftStatus(from, to) {
  if (from === to) return true;
  return (DRAFT_STATUS_TRANSITIONS[from] || []).includes(to);
}

// ── Campaign objective ─────────────────────────────────────────────────────
export const CAMPAIGN_OBJECTIVES = [
  'LEADS',
  'SALES',
  'WEBSITE_TRAFFIC',
  'AWARENESS',
];

// ── Bidding strategy ───────────────────────────────────────────────────────
// Only strategies the existing Google Ads Search integration can actually
// publish. Additional strategies can be appended here with zero impact on
// existing documents (enum widening is non-breaking).
export const BIDDING_STRATEGIES = [
  'MAXIMIZE_CONVERSIONS',
  'MAXIMIZE_CONVERSION_VALUE',
  'MAXIMIZE_CLICKS',
  'TARGET_CPA',
  'TARGET_ROAS',
];

// ── Location targeting ─────────────────────────────────────────────────────
export const LOCATION_TYPES = [
  'CITY',
  'REGION',
  'COUNTRY',
  'POSTAL_CODE',
];

// ── Keyword / negative-keyword match types ─────────────────────────────────
// Same spelling as Google Ads' KeywordMatchType and as the already-synced
// GoogleAdsKeyword model. UNKNOWN/UNSPECIFIED are intentionally NOT accepted
// here — a human/AI-authored draft keyword must have a real, publishable
// match type.
export const KEYWORD_MATCH_TYPES = [
  'BROAD',
  'PHRASE',
  'EXACT',
];

// ── Ad types ───────────────────────────────────────────────────────────────
// Foundation supports Responsive Search Ads only. The field is an enum so
// PERFORMANCE_MAX / RESPONSIVE_DISPLAY_AD / etc. can be added later without
// touching existing docs.
export const AD_TYPES = [
  'RESPONSIVE_SEARCH_AD',
];

export const DEFAULT_AD_TYPE = 'RESPONSIVE_SEARCH_AD';

// ── AI provider (aiMetadata) ───────────────────────────────────────────────
// Claude is the only provider Phase 2 will wire up, but the field is
// provider-agnostic from day one.
export const AI_PROVIDERS = [
  'CLAUDE',
  'OPENAI',
  'GEMINI',
];

// ── Change-history vocabulary ──────────────────────────────────────────────
export const CHANGE_SOURCES = ['AI', 'USER', 'SYSTEM'];
export const CHANGE_ACTIONS = ['CREATE', 'UPDATE', 'DELETE'];

// ── Responsive Search Ad limits (Google Ads hard limits) ───────────────────
// Enforced by the structure validator, not the Mongoose schema, so a
// partially-built Phase 2/3 draft can still be persisted and iterated on.
export const RSA_LIMITS = Object.freeze({
  HEADLINE_MAX_CHARS: 30,
  DESCRIPTION_MAX_CHARS: 90,
  PATH_MAX_CHARS: 15,
  HEADLINES_MIN: 3,
  HEADLINES_MAX: 15,
  DESCRIPTIONS_MIN: 2,
  DESCRIPTIONS_MAX: 4,
});

// ── Campaign-level extension assets (Google Ads hard limits) ───────────────
// Sitelinks/callouts/structured snippets are campaign-scoped in Odito's
// model (one campaign here = one generated Search campaign; ad-group-level
// duplication of the same extensions would be wasteful and isn't how most
// advertisers configure them). See googleAdsPublishProvider.js for how these
// map onto Google's actual Asset / CampaignAsset resources.
export const ASSET_LIMITS = Object.freeze({
  SITELINK_TEXT_MAX_CHARS: 25,
  SITELINK_DESCRIPTION_MAX_CHARS: 35,
  CALLOUT_TEXT_MAX_CHARS: 25,
  SNIPPET_VALUE_MAX_CHARS: 25,
});

// Google Ads' own fixed structured-snippet header vocabulary (NOT enforced
// by the google-ads-api SDK itself — `header` is an unconstrained string at
// the protobuf level, confirmed by inspecting the installed SDK's type
// definitions — so Odito enforces it here instead of trusting Claude to
// pick a real one). Source: Google Ads Help — "About structured snippet
// extensions". A header outside this list is rejected outright, never
// silently coerced.
export const STRUCTURED_SNIPPET_HEADERS = [
  'Amenities',
  'Brands',
  'Courses',
  'Degree programs',
  'Destinations',
  'Featured hotels',
  'Insurance coverage',
  'Models',
  'Neighborhoods',
  'Service catalog',
  'Shows',
  'Styles',
  'Types',
];

// ── Money ──────────────────────────────────────────────────────────────────
// See AiCampaignDraft.js for the full rationale. Budgets are stored as an
// integer number of MICROS (millionths of the currency's major unit),
// mirroring Google Ads' `amount_micros` exactly.
export const MICROS_PER_UNIT = 1_000_000;

// ISO 4217 alpha-3 — shape only (3 uppercase letters). We deliberately do
// NOT ship a hardcoded country/currency allow-list here: Odito must support
// international campaigns and the connected Google Ads account is the real
// authority on billing currency.
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

// ISO 3166-1 alpha-2 — shape only (2 uppercase letters).
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

// BCP-47-ish language code — 2–3 letter primary subtag, optional region
// subtag (e.g. `en`, `en-US`, `pt-BR`). Shape only.
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

// Google Ads customer IDs are 10 digits, no dashes.
export const GOOGLE_ADS_CUSTOMER_ID_PATTERN = /^\d{10}$/;
