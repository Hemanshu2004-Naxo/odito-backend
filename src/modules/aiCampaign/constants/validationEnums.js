/**
 * Pre-publish validation — controlled vocabulary (Phase 5).
 *
 * Single source of truth for the severity/category taxonomy every
 * validation issue uses. Kept intentionally small and extensible (spec §6
 * — "only create categories that correspond to actual rules").
 */

// ── Severity ───────────────────────────────────────────────────────────
// error   — blocks publishing (readiness = 'blocked' if any exist)
// warning — visible, does not block readiness
// info    — informational only (e.g. "18 keywords configured")
export const ISSUE_SEVERITIES = ['error', 'warning', 'info'];

// ── Category ───────────────────────────────────────────────────────────
export const ISSUE_CATEGORIES = [
  'structure',
  'campaign',
  'budget',
  'bidding',
  'location',
  'language',
  'ad_groups',
  'keywords',
  'negative_keywords',
  'ads',
  'landing_page',
  'business_consistency',
  'duplicates',
  'policy',
  'google_ads',
  // Sitelinks/callouts/structured snippets (Phase 9, RSA/Ad-Strength quality
  // work) — campaign-level, not ad-group-level, so 'ads' doesn't fit.
  'assets',
];

// Order the "Campaign readiness" checklist renders in — a human reviewing
// a campaign thinks top-down: campaign shape, then targeting, then content,
// then the account it will actually publish to.
export const CATEGORY_DISPLAY_ORDER = [
  'structure',
  'campaign',
  'budget',
  'bidding',
  'location',
  'language',
  'ad_groups',
  'keywords',
  'negative_keywords',
  'ads',
  'assets',
  'landing_page',
  'duplicates',
  'business_consistency',
  'policy',
  'google_ads',
];

export const CATEGORY_LABELS = Object.freeze({
  structure: 'Campaign structure',
  campaign: 'Campaign settings',
  budget: 'Budget',
  bidding: 'Bidding strategy',
  location: 'Target location',
  language: 'Language',
  ad_groups: 'Ad groups',
  keywords: 'Keywords',
  negative_keywords: 'Negative keywords',
  ads: 'Ads',
  assets: 'Sitelinks, callouts & snippets',
  landing_page: 'Landing page',
  business_consistency: 'Business consistency',
  duplicates: 'Duplicate content',
  policy: 'Policy concerns',
  google_ads: 'Google Ads account',
});

/**
 * Single source of truth for "which readiness values exist" — mirrors the
 * READY/BLOCKED contract from spec §3/§4. `status` on a validation result
 * is always one of these two; there is no in-between state.
 */
export const READINESS_STATUSES = ['ready', 'blocked'];

// Bumped whenever the rule set changes in a way that could change a
// previously-computed result — recorded on every persisted validation
// result (same pattern as Phase 2/4's PROMPT_VERSION).
export const VALIDATION_VERSION = 'campaign-validation-v1';
