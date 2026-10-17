import {
  normalizeTextValue,
  canonicalValuesMatch,
  extractCanonicalUrlValue,
  normalizeRobotsValue,
  robotsValuesMatch,
  normalizeSchemaUrlValue,
  normalizeBreadcrumbEnableValue,
} from '../../tasks/service/valueNormalization.js';
import { parseFaqPageJsonLd, faqPairsMatch } from '../../tasks/service/faqSchema.js';
import { parseAggregateRatingJsonLd, ratingsEqual } from '../../tasks/service/aggregateRatingSchema.js';
import { extractH1TextValue } from '../../tasks/service/h1Value.js';

/**
 * ProviderCapabilityRegistry
 *
 * The single source of truth for "which SEO fields can Odito safely
 * automate through the WordPress SEO Bridge, and how." Every other file
 * that needs to know an issue's field type, its WordPress-side name, or how
 * to normalize/validate/compare its value reads from HERE — this is what
 * keeps Rank-Math-specific (or Yoast/AIOSEO/SEOPress-specific) field names
 * out of controllers and out of wordPressSeoFixService.js's own logic.
 *
 * IMPORTANT — this registry does NOT decide whether a given WordPress site
 * currently supports a field; that is a live, per-connection fact reported
 * by the Bridge's own /capabilities endpoint (see oditoSeoBridgeService.js)
 * and depends on which SEO plugin is active there. This registry decides
 * something narrower and static: whether Odito's OWN codebase has a
 * complete, verified write -> read-back -> crawler-verify implementation
 * for a field AT ALL, for ANY provider. A field with `supported: false`
 * here is never offered for auto-apply regardless of what any live site
 * reports, because Odito has no way to safely drive it yet.
 *
 * SCOPE — most fields are `scope: 'post'` (implied — the field omits
 * `scope`), meaning the Bridge writes to one specific WordPress post/page.
 * `scope: 'site'` fields (same_as, breadcrumb_schema) instead write to
 * site-wide WordPress options via the Bridge's /seo/site routes — no post
 * ID is ever resolved or required for these. See
 * wordPressSeoFixService.js's `config.scope === 'site'` branches.
 *
 * HOW same_as/breadcrumb_schema moved from unsupported to supported: real
 * research against the connected naxonify.com Rank Math installation
 * (its actual PHP source, cloned from github.com/rankmath/seo-by-rank-math
 * and read directly — not guessed, and not from secondary documentation)
 * found the exact, confirmed storage mechanism for both:
 *   - Organization/Knowledge Graph fields (including the 3 sources that
 *     compose sameAs: social_url_facebook, twitter_author_names,
 *     social_additional_profiles) live in the `rank-math-options-titles`
 *     WordPress option — confirmed via Rank Math's own
 *     rank-math/set-website-identity ability class.
 *   - The breadcrumbs on/off toggle lives in the `rank-math-options-general`
 *     option's `breadcrumbs` key — confirmed via Rank Math's own
 *     rank-math/set-breadcrumb-settings ability class, and its
 *     JsonLD::can_add_breadcrumb() showing BreadcrumbList output is gated
 *     entirely on this one setting.
 * This is a genuinely new Bridge surface (RankMathProvider::get_site_schema/
 * update_site_schema_field, gated behind manage_options — see
 * class-security.php), not an extension of the per-post one, exactly as
 * anticipated when these were first marked unsupported.
 *
 * `same_as`'s write is narrowly scoped to the social_additional_profiles
 * bucket only — it can never touch/delete the Facebook or Twitter fields, so
 * an existing social profile can never be destroyed through this capability
 * (see RankMathProvider::update_same_as). The URLs are ENTERED BY THE SITE
 * OWNER, never taken from the AI recommendation (which is told to say "not
 * provided in context" rather than invent one): wordPressSeoFixService's
 * applySameAsFix() validates them, merges them one at a time with the
 * existing additional profiles, and reads the result back.
 *
 * Remaining `supported: false` entries and why:
 *
 * organization_schema IS supported since Bridge 1.4.0, but NOT as a single-value field: the issue describes
 * a multi-field entity, so it has its own typed channel (../schemaFix/ — `typedFix: true`). A planner turns the verified
 * schema INTENT plus Rank Math's live Knowledge Graph / Local SEO settings into the minimal list of field changes
 * (name, logo, business type — never an existing value, never an unproven or address-less physical type); the
 * user previews and approves exactly that plan; each field is written with compare-and-set and read back; a failure
 * restores what was already written; the rendered page is verified separately by the crawler. The Bridge field
 * `type` (Rank Math `local_business_type`) only renders while Rank Math's Local SEO module is on — the planner
 * blocks the type change otherwise. sameas_array remains its own single-value capability.
 *   - person_schema: rendered from the POST'S AUTHOR'S WordPress user
 *     account (@id is the author archive URL, e.g.
 *     https://naxonify.com/author/<slug>/) — i.e. PER-USER data (a `name`
 *     from wp_users.display_name, a `description` from user meta, a
 *     `sameAs` from THREE user meta keys), not site-wide options and not
 *     post meta. Automating this safely requires resolving post_author from
 *     the post, verifying that user belongs to the same site, and — most
 *     importantly — a genuinely new PERMISSION model (editing another
 *     user's profile fields requires WordPress's edit_users capability,
 *     which the Bridge's existing edit_post-based per-post check and its
 *     manage_options-based site check both under- or over-specify). This is
 *     real, buildable, confirmed-storage-format work, deliberately deferred
 *     to keep this pass's blast radius (and its live-testing risk against a
 *     real user account) contained — not a guess or an oversight.
 *
 * faq_schema IS supported, through a different mechanism than the fields
 * above (and than Rank Math's own FAQ block, which lives in the post BODY as
 * serialized Gutenberg markup — editing that is arbitrary content replacement,
 * which this project's non-goals exclude). Instead the Bridge owns a small,
 * dedicated per-post store: it validates a FAQPage JSON-LD object, keeps only
 * its Question/Answer pairs in one post-meta key of its own, and renders the
 * JSON-LD in wp_head. That never touches post content or any SEO plugin's
 * data, works whichever SEO plugin (or none) is active, and is fully
 * read-back-able and verifiable: the crawler's own `structured_data` for the
 * page is compared, pair by pair, to the pairs the schema was generated from
 * (which are themselves only ever the FAQ pairs the crawler saw on the page —
 * see faqSchema.js). Odito's own writes are limited to that one key, so
 * removing the schema is a matter of removing that key.
 */

const PERSON_UNSUPPORTED_REASON =
  "Person/Author schema is not applied automatically. Checked against Rank Math 1.0.278's own source " +
  "(includes/modules/schema/snippets/class-author.php): the author entity is rendered from the post author's WordPress USER " +
  '(display name, bio, profile URLs, avatar) — per-user data that needs a new edit_user permission model and an ' +
  'owner-supplied value for every field (Odito never invents a bio or a profile). More importantly, the audit issues that ' +
  'point here do not map to what those fields can change: author_info_missing only checks that an author byline is VISIBLE ' +
  'in the page text, and person_schema_linked expects a jobTitle that Rank Math does not publish from any user field. ' +
  'Writing user data would therefore not resolve them. Edit the author profile in WordPress (Users → Profile) and the ' +
  'author byline in the template.';

/**
 * @typedef {Object} FieldCapability
 * @property {boolean} supported - whether Odito's codebase can drive this field end to end, for any provider
 * @property {string[]} issueCodes - issue keys (== Python rule_id) this field can remediate
 * @property {string} bridgeField - the field name sent over the wire to/from the Odito SEO Bridge (never a provider-specific meta key)
 * @property {string} snapshotType - the issueSnapshotTypes.js type this field's before/after values are captured as
 * @property {(raw: string) => any|null} [normalizeRecommendation] - parse+validate a Recommendation's recommendedVersion/contentRewrite.optimized into this field's internal value shape; null means "not a usable value, refuse the write"
 * @property {(a: any, b: any) => boolean} [valuesMatch] - type-aware equality between two internal values (current vs desired, or expected vs crawled)
 * @property {boolean} immediateVerificationSupported - whether a live re-read after write can confirm persistence (Level 1)
 * @property {boolean} crawlerVerificationSupported - whether TaskVerificationService's recrawl-based comparison (Level 2) is wired up for this type
 * @property {string} [unsupportedReason] - present only when supported:false — shown to the user, never fabricated
 */

/** @type {Record<string, FieldCapability>} */
export const CAPABILITY_REGISTRY = {
  title: {
    supported: true,
    issueCodes: ['title_missing', 'title_too_short', 'title_too_long'],
    bridgeField: 'title',
    snapshotType: 'title',
    normalizeRecommendation: (raw) => (typeof raw === 'string' && raw.trim() ? raw.trim() : null),
    valuesMatch: (a, b) => !!a && !!b && normalizeTextValue(a) === normalizeTextValue(b),
    immediateVerificationSupported: true,
    crawlerVerificationSupported: true,
  },
  meta_description: {
    supported: true,
    issueCodes: ['meta_description_missing', 'meta_description_too_short', 'meta_description_too_long'],
    bridgeField: 'meta_description',
    snapshotType: 'meta_description',
    normalizeRecommendation: (raw) => (typeof raw === 'string' && raw.trim() ? raw.trim() : null),
    valuesMatch: (a, b) => !!a && !!b && normalizeTextValue(a) === normalizeTextValue(b),
    immediateVerificationSupported: true,
    crawlerVerificationSupported: true,
  },
  canonical: {
    supported: true,
    issueCodes: ['canonical_tag_errors'],
    bridgeField: 'canonical',
    snapshotType: 'canonical',
    normalizeRecommendation: extractCanonicalUrlValue,
    valuesMatch: canonicalValuesMatch,
    immediateVerificationSupported: true,
    // Level 2 for canonical is necessarily two-layered: a persisted meta
    // value does not by itself prove Rank Math rendered a <link> tag from
    // it (the exact production bug this whole field's validation exists to
    // prevent) — TaskVerificationService's value_diff against the
    // crawler's OWN parsed `canonical` column is what actually closes that
    // gap, same mechanism as every other crawler-verified field here.
    crawlerVerificationSupported: true,
  },
  robots: {
    supported: true,
    issueCodes: ['noindex_key_pages', 'noindex_tags'],
    bridgeField: 'robots',
    snapshotType: 'robots',
    normalizeRecommendation: normalizeRobotsValue,
    valuesMatch: robotsValuesMatch,
    immediateVerificationSupported: true,
    crawlerVerificationSupported: true,
  },

  // ── Site-scoped schema (scope: 'site') — writes to WordPress OPTIONS via
  // the Bridge's /seo/site routes, never post meta. See this file's
  // docblock for the real source research behind both entries below.
  same_as: {
    supported: true,
    scope: 'site',
    // Two paths share this capability. The older owner-typed apply (wordPressSeoFixService.applySameAsFix, body without a plan
    // fingerprint) is unchanged. The preview -> approve -> apply path (schemaFix/ — `typedFix: true`, ledger, per-URL compare, rollback,
    // immediate rendered-JSON-LD check) plans the SAME Bridge add/remove operations from links that were discovered on the site or
    // typed by the owner and then explicitly approved (schema-evidence/sameAs/); no URL ever comes from model text.
    typedFix: true,
    provider: 'rank_math',
    issueCodes: ['sameas_array'],
    bridgeField: { entity: 'organization', field: 'sameAs' },
    snapshotType: 'same_as',
    normalizeRecommendation: normalizeSchemaUrlValue,
    // "Matches" means the URL is present in the CURRENT full sameAs array —
    // not array equality — since Odito only adds the owner's URLs and must
    // never treat an unrelated addition/removal by the site owner as a
    // mismatch. (The write path itself takes owner-entered URLs — see
    // applySameAsFix; this normalizer/matcher only serves the legacy,
    // recommendation-derived value.)
    valuesMatch: (expectedUrl, actualSameAsArray) =>
      !!expectedUrl && Array.isArray(actualSameAsArray) && actualSameAsArray.includes(expectedUrl),
    immediateVerificationSupported: true,
    crawlerVerificationSupported: true,
  },
  breadcrumb_schema: {
    supported: true,
    scope: 'site',
    // Two paths share this capability. The older generic apply (wordPressSeoFixService, body without a plan fingerprint) is unchanged. The
    // preview -> approve -> apply path (schemaFix/ - `typedFix: true`, ledger, rollback, per-page rendered verification) switches the SAME Rank
    // Math setting on, but only for a trail the owner confirmed AND only when the trail Rank Math would build for the page equals it
    // (schemaFix/breadcrumbFixPlan.js). Otherwise: the JSON-LD and manual steps, never an Apply button.
    typedFix: true,
    provider: 'rank_math',
    issueCodes: ['breadcrumblist_schema'],
    bridgeField: { entity: 'breadcrumbs', field: 'enabled' },
    snapshotType: 'breadcrumb',
    normalizeRecommendation: normalizeBreadcrumbEnableValue,
    valuesMatch: (expectedEnabled, actualEnabled) => expectedEnabled === actualEnabled,
    immediateVerificationSupported: true,
    // Level 2 verification confirms BreadcrumbList JSON-LD is actually
    // rendered — a site-level toggle flip alone (Level 1) doesn't prove
    // Rank Math emitted the schema, same two-layer reasoning as canonical.
    crawlerVerificationSupported: true,
  },
  // AggregateRating for a rating the page already displays, attached to an
  // entity (Product/Service/LocalBusiness/Organization) that already exists in
  // the page's schema, by @id. Written through the Bridge's own /rating-schema
  // route — same channel model as faq_schema, independent of the SEO plugin.
  aggregate_rating: {
    supported: true,
    issueCodes: ['aggregate_rating_schema'],
    bridgeField: 'aggregate_rating',
    snapshotType: 'aggregate_rating',
    // A usable value is a rating JSON-LD node on an entity with an absolute @id
    // and a name, returned as {target, rating}; null means "refuse the write".
    normalizeRecommendation: (raw) => parseAggregateRatingJsonLd(raw),
    // Same entity (@id) AND the same figures — exact numeric equality.
    valuesMatch: (a, b) => !!a?.target?.id && a.target.id === b?.target?.id && ratingsEqual(a.rating, b.rating),
    immediateVerificationSupported: true,
    // TaskVerificationService requires a VALID AggregateRating with the generated
    // figures on that entity in the re-crawled page.
    crawlerVerificationSupported: true,
  },

  // ── Page CONTENT (not an SEO-plugin field) — the H1. Written by the WordPress content
  // adapters (../content/) through WordPress core REST: no SEO plugin, no Bridge, no meta key.
  // `supported` here means Odito's code has a complete write -> read-back -> rendered-page ->
  // crawler-verify implementation; whether a GIVEN PAGE can be changed is decided per page by
  // its builder's adapter (only Divi today — Elementor/Gutenberg/classic HTML are detected
  // and declined with a reason). h1_missing only: multiple_h1_tags shares the snapshot type
  // but is never auto-fixed (choosing which H1 to change is a human decision).
  h1: {
    supported: true,
    channel: 'content',
    provider: 'wordpress_content',
    scope: 'post',
    operation: 'set_h1',
    issueCodes: ['h1_missing'],
    bridgeField: null,
    snapshotType: 'h1',
    // The recommendation is often "<h1>Title</h1>": the usable value is its plain text.
    normalizeRecommendation: (raw) => extractH1TextValue(raw),
    valuesMatch: (a, b) => normalizeTextValue(a) === normalizeTextValue(b),
    immediateVerificationSupported: true,
    // TaskVerificationService requires the recrawled page to have exactly one H1 with that text.
    crawlerVerificationSupported: true,
  },

  // ── Schema — architecture present for Organization's individual fields
  // and Person, writes intentionally withheld. Every reason below is
  // backed by real inspection of Rank Math's own PHP source and a live
  // installation's rendered JSON-LD, not a guess (see the file-level
  // docblock above for the full research summary).
  // Typed multi-field fix (see the docblock): the value is NOT parsed from the recommendation text — it is planned from
  // verified evidence + live Rank Math state (schemaFix/organizationFixPlan.js), so there is no normalizeRecommendation /
  // valuesMatch pair to declare. Verification: saved state read back immediately (Level 1); rendered entity checked by
  // TaskVerificationService's schema gate and the fix's own re-verify (Level 2).
  organization_schema: {
    supported: true,
    typedFix: true,
    scope: 'site',
    channel: 'schema_fix',
    provider: 'rank_math',
    minBridgeCapability: 'organization_type',
    // The structured business address (the "missing address" finding) needs a newer Bridge than name/logo/type: Bridge 1.6.0
    // (supports.organization_address), AND Rank Math's Local SEO module, which is what publishes it. The planner holds the address
    // back — never the other fields — when either is missing.
    fieldMinBridgeCapability: { address: 'organization_address' },
    issueCodes: ['organization_schema'],
    bridgeField: { entity: 'organization', fields: ['name', 'logo', 'type', 'address'] },
    snapshotType: null,
    immediateVerificationSupported: true,
    crawlerVerificationSupported: true,
  },
  person_schema: {
    supported: false,
    issueCodes: ['author_info_missing'],
    bridgeField: null,
    snapshotType: null,
    unsupportedReason: PERSON_UNSUPPORTED_REASON,
    immediateVerificationSupported: false,
    crawlerVerificationSupported: false,
  },
  // Page-scoped (no `scope: 'site'`) but written through the Bridge's own
  // /faq-schema/{postId} route rather than /seo/{postId} — see the docblock
  // above and wordPressSeoFixService.js's `channel: 'faq_schema'`.
  faq_schema: {
    supported: true,
    issueCodes: ['faq_schema'],
    bridgeField: 'faq_schema',
    snapshotType: 'faq_schema',
    // A usable value is a FAQPage JSON-LD string with a Question+Answer for
    // every entry, returned as its pair list; null means "refuse the write".
    normalizeRecommendation: (raw) => parseFaqPageJsonLd(raw),
    // Order-insensitive question+answer equality (see faqSchema.faqPairsMatch).
    valuesMatch: faqPairsMatch,
    immediateVerificationSupported: true,
    // TaskVerificationService compares the crawled FAQPage's pairs with the
    // pairs the schema was generated from, and only verifies on a match.
    crawlerVerificationSupported: true,
  },
};

/** @returns {FieldCapability|null} */
export function getCapabilityForField(field) {
  return CAPABILITY_REGISTRY[field] || null;
}

/** @returns {{field: string, capability: FieldCapability}|null} the field type an issueKey maps to, or null if none does */
export function getCapabilityForIssue(issueKey) {
  for (const [field, capability] of Object.entries(CAPABILITY_REGISTRY)) {
    if (capability.issueCodes.includes(issueKey)) {
      return { field, capability };
    }
  }
  return null;
}

/** Every field currently supported end to end (for any provider) — used to build safe default/status responses. */
export function listSupportedFields() {
  return Object.entries(CAPABILITY_REGISTRY)
    .filter(([, capability]) => capability.supported)
    .map(([field]) => field);
}

export default { CAPABILITY_REGISTRY, getCapabilityForField, getCapabilityForIssue, listSupportedFields };
