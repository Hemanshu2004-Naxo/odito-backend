/**
 * Shared mapping between an issue's issueKey (== Python's rule_id /
 * issue_code) and the structured before/after snapshot "type" it produces.
 *
 * Kept in one place so TaskHistoryService (before-capture, expected-after
 * derivation) and TaskVerificationService (actual-after resolution) never
 * drift out of sync with each other or with the Python-side before_snapshot
 * shapes in
 * python_workers/scraper/workers/seo/page_analysis/rules/categories/*.py.
 *
 * Only the issue types with real structured before-value capture are
 * listed here. Everything else resolves to null, meaning: no value-diff
 * verification, use the existing presence/absence check.
 *
 * 'same_as' and 'breadcrumb' are SITE-SCOPED (not page-scoped like every
 * type above them) — see providerCapabilityRegistry.js's `scope` field.
 * The snapshot type system itself doesn't need to know about scope; it
 * only needs a name TaskHistoryService/TaskVerificationService can both
 * switch on, same as every page-scoped type.
 */
const ISSUE_KEY_TO_SNAPSHOT_TYPE = {
  title_missing: 'title',
  title_too_short: 'title',
  title_too_long: 'title',
  meta_description_missing: 'meta_description',
  meta_description_too_short: 'meta_description',
  meta_description_too_long: 'meta_description',
  h1_missing: 'h1',
  multiple_h1_tags: 'h1',
  images_missing_alt_text: 'image_alt',
  canonical_tag_errors: 'canonical',
  noindex_key_pages: 'robots',
  noindex_tags: 'robots',
  sameas_array: 'same_as',
  breadcrumblist_schema: 'breadcrumb',
  // Page-scoped, but written through the Bridge's dedicated FAQ-schema route
  // (not an SEO-plugin field) — see wordPressSeoFixService.js's `channel`.
  faq_schema: 'faq_schema',
  // Same channel model: written through the Bridge's own /rating-schema route.
  aggregate_rating_schema: 'aggregate_rating',
  // Keyboard/focus audit findings (missing focus indicator, focus trap, unreachable
  // elements). Page-scoped; the value is the exact list of audited elements, so
  // verification re-tests THOSE selectors rather than "the issue vanished".
  keyboard_accessibility: 'keyboard_accessibility',
};

export function inferSnapshotType(issueKey) {
  return ISSUE_KEY_TO_SNAPSHOT_TYPE[issueKey] || null;
}

export default { inferSnapshotType };
