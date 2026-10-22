/**
 * Issue Metadata Configuration
 * Maps issue_code → difficulty level for the On-Page Issues dashboard.
 * Default difficulty is "medium" if not listed here.
 */

export const ISSUE_METADATA = {
  // Easy fixes
  META_DESC_MISSING: { difficulty: "easy" },
  META_DESC_TOO_SHORT: { difficulty: "easy" },
  META_DESC_TOO_LONG: { difficulty: "easy" },
  TITLE_MISSING: { difficulty: "easy" },
  TITLE_TOO_SHORT: { difficulty: "easy" },
  TITLE_TOO_LONG: { difficulty: "easy" },
  H1_MISSING: { difficulty: "easy" },
  MULTIPLE_H1: { difficulty: "easy" },
  IMAGES_MISSING_ALT: { difficulty: "easy" },
  SOCIAL_TAGS_MISSING: { difficulty: "easy" },
  NOINDEX_ON_KEY_PAGE: { difficulty: "easy" },
  MULTIPLE_TITLE_TAGS: { difficulty: "easy" },

  // Medium fixes
  CANONICAL_MISSING: { difficulty: "medium" },
  CANONICAL_MISMATCH: { difficulty: "medium" },
  INTERNAL_LINKS_NONE: { difficulty: "medium" },
  EXTERNAL_LINKS_NONE: { difficulty: "medium" },

  // Hard fixes
  SCHEMA_MISSING: { difficulty: "hard" },
  STRUCTURED_DATA_MISSING: { difficulty: "hard" },
  CONTENT_TOO_SHORT: { difficulty: "hard" },
  PAGE_SPEED_SLOW: { difficulty: "hard" },
  MOBILE_FRIENDLY_ISSUES: { difficulty: "hard" },
};

/**
 * Canonical display titles for issue codes.
 * Keys match the Python rule_id values (lowercase snake_case).
 * Used to ensure the UI never shows evidence values (URLs, selectors) as headings.
 *
 * Most rules emit exactly one finding type and use a plain string here.
 *
 * A rule whose evaluate() can emit multiple, genuinely different-severity
 * finding types under the same rule_id (e.g. "entity schema entirely
 * missing" vs "entity schema present but missing a recommended field") may
 * instead use:
 *   {
 *     default: "<title shown when no more specific entry matches>",
 *     byDataPath: { "<issue.data_path value>": "<title for that finding>" },
 *   }
 * `resolveIssueTitle()` in onPageIssuesService.js resolves either shape —
 * see that function for the exact fallback order. This keeps per-subtype
 * titles centralized and reusable instead of string-matching issue_message
 * in the frontend.
 */
export const CANONICAL_ISSUE_TITLES = {
  // Image rules
  images_missing_alt_text:        "Images Missing Alt Text",
  broken_images:                  "Broken Images",
  image_file_size:                "Large Image Files",
  images_not_webp_format:         "Images Not in Modern Format",
  images_missing_dimensions:      "Images Missing Dimensions",
  images_without_lazy_loading:    "Below-fold Images Without Lazy Loading",

  // Content rules
  title_missing:                  "Page Title Missing",
  title_too_short:                "Page Title Too Short",
  title_too_long:                 "Page Title Too Long",
  meta_description_missing:       "Meta Description Missing",
  meta_description_too_short:     "Meta Description Too Short",
  meta_description_too_long:      "Meta Description Too Long",
  h1_missing:                     "H1 Tag Missing",
  multiple_h1:                    "Multiple H1 Tags",
  content_too_short:              "Content Too Short",
  duplicate_content:              "Duplicate Content",

  // Link rules
  broken_links:                   "Broken Links",
  internal_links_none:            "No Internal Links",
  external_links_none:            "No External Links",
  nofollow_all_links:             "All Links Are Nofollow",

  // Schema / structured data
  schema_missing:                 "Schema Markup Missing",
  schema_invalid:                 "Schema Markup Invalid",
  structured_data_missing:        "Structured Data Missing",
  // organization_schema emits three finding types under one rule_id — see
  // OrganizationSchemaRule.evaluate() (schema_rules.py). Only the "entirely
  // missing" case is a true "Missing ... Schema" finding; the other two mean
  // a valid Organization/LocalBusiness schema WAS found. Docs written before
  // this split (no data_path match, or missing data_path entirely on very
  // old documents) fall back to `default`, which preserves the pre-fix title.
  organization_schema: {
    default: "Missing Organization or LocalBusiness Schema",
    byDataPath: {
      "structured_data.organization.missing_fields": "Incomplete Organization Schema",
      "structured_data.organization.incomplete":      "Organization Schema Recommendations",
    },
  },
  article_schema:                 "Article Schema Missing or Incomplete",
  breadcrumblist_schema:          "BreadcrumbList Schema Missing",
  product_schema:                 "Product Schema Missing",
  aggregate_rating_schema:        "AggregateRating Schema Missing",
  sameas_array:                   "sameAs Array Missing or Incomplete",
  deprecated_schema_types:        "Deprecated Schema Type Used",
  duplicate_schema_formats:       "Duplicate Schema Formats",
  invalid_schema_type:            "Invalid Schema Type for Page",
  schema_type_conflict:           "Conflicting Schema Types Detected",

  // Crawlability / technical
  noindex_key_pages:              "Noindex on Key Pages",
  canonical_missing:              "Canonical Tag Missing",
  canonical_mismatch:             "Canonical Tag Mismatch",
  multiple_title_tags:            "Multiple Title Tags",
  redirect_chain:                 "Redirect Chain Detected",
  mixed_content:                  "Mixed Content (HTTP/HTTPS)",

  // Social / OG
  og_tags_missing:                "Open Graph Tags Missing",
  twitter_card_missing:           "Twitter Card Tags Missing",
  social_tags_missing:            "Social Tags Missing",

  // Accessibility
  form_labels_missing:            "Form Labels Missing",
  keyboard_navigation:            "Keyboard Navigation Issues",

  // EEAT
  author_info_missing:            "Author Information Missing",
  publication_date_missing:       "Publication Date Missing",
};

export const DEFAULT_DIFFICULTY = "medium";

/**
 * Severity → difficulty, used only when a rule has no explicit ISSUE_METADATA
 * entry above. Difficulty and severity are independent concepts in the
 * product model (e.g. a medium-severity missing meta description is an EASY
 * fix; a high-severity broken canonical can be a MEDIUM fix) — this map is
 * deliberately just a reasonable default for issue types nobody has
 * classified yet, not a claim that severity determines difficulty.
 */
const SEVERITY_TO_DIFFICULTY = {
  high: 'hard',
  critical: 'hard',
  medium: 'medium',
  warning: 'medium',
  low: 'easy',
  info: 'easy',
  none: 'easy', // Technical Checks' "OK" status carries severity 'none' — nothing to fix.
};

/**
 * Single resolver for "how hard is this issue to fix" — used by both
 * On-Page Issues (onPageIssuesService.js) and Technical Checks
 * (technicalChecks.service.js). Previously each of technicalChecks.service.js's
 * 10 check functions duplicated an identical inline severity→difficulty
 * switch statement; this replaces all of them with one place to change.
 *
 * Resolution order: explicit per-rule ISSUE_METADATA[issue_code].difficulty
 * (the actual, curated answer) → severity-based default (a reasonable
 * guess for anything not yet curated) → DEFAULT_DIFFICULTY.
 *
 * @param {{ issue_code?: string, severity?: string }} params
 * @returns {'easy'|'medium'|'hard'}
 */
export function resolveIssueDifficulty({ issue_code, severity } = {}) {
  const meta = issue_code ? ISSUE_METADATA[issue_code] : null;
  if (meta && meta.difficulty) return meta.difficulty;

  const bySeverity = SEVERITY_TO_DIFFICULTY[severity?.toLowerCase()];
  return bySeverity || DEFAULT_DIFFICULTY;
}

/**
 * AI confidence fallback values when not stored in the database.
 * Maps severity → confidence percentage.
 */
export const AI_CONFIDENCE_FALLBACK = {
  high: 90,
  medium: 70,
  low: 50,
};
