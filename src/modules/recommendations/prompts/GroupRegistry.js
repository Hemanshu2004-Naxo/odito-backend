/**
 * GroupRegistry
 *
 * Maps every known issue ID to one of 6 recommendation groups.
 * Each group uses a different Claude system role, context injection strategy,
 * and output format — routing is the only purpose of this file.
 *
 * ─────────────────────────────────────────────────────────────────────
 * GROUP  NAME                  PROMPT MODE(S)         MAX_TOKENS
 * ─────────────────────────────────────────────────────────────────────
 *   1    Text Optimization      content_rewrite         1200
 *   2    Content Optimization   content_rewrite         3200  // thin_content etc. rewrite full paragraphs, not a title/meta — 2000 was observed truncating at 100% utilization; live-verified need is ~3093
 *   3    Technical SEO          comparison_fix          1500
 *                               structural_fix
 *                               list_fix
 *   4    Schema                 element_add             2500
 *                               structural_fix
 *   5    Accessibility          element_add             2500
 *                               structural_fix
 *   6    AI Visibility Core     content_rewrite         2000
 *                               structural_fix
 *                               element_add
 *   7    Entity & E-E-A-T       element_add             1500
 *                               comparison_fix
 *                               list_fix
 *   8    AEO & Voice Search     content_rewrite         1800
 *                               element_add
 * ─────────────────────────────────────────────────────────────────────
 */

export const GROUP = {
  TEXT_OPTIMIZATION:    1,
  CONTENT_OPTIMIZATION: 2,
  TECHNICAL_SEO:        3,
  SCHEMA:               4,
  ACCESSIBILITY:        5,
  AI_VISIBILITY:        6,
  ENTITY_EEAT:          7,
  AEO_VOICE:            8,
};

export const GROUP_LABELS = {
  [GROUP.TEXT_OPTIMIZATION]:    'Text Optimization',
  [GROUP.CONTENT_OPTIMIZATION]: 'Content Optimization',
  [GROUP.TECHNICAL_SEO]:        'Technical SEO',
  [GROUP.SCHEMA]:               'Schema',
  [GROUP.ACCESSIBILITY]:        'Accessibility',
  [GROUP.AI_VISIBILITY]:        'AI Visibility Core',
  [GROUP.ENTITY_EEAT]:          'Entity & E-E-A-T',
  [GROUP.AEO_VOICE]:            'AEO & Voice Search',
};

/** Max output tokens per group — schema/content need more room than text rewrites. */
export const GROUP_MAX_TOKENS = {
  [GROUP.TEXT_OPTIMIZATION]:    1200,
  [GROUP.CONTENT_OPTIMIZATION]: 3200,  // live-verified: a real thin_content response needed 3093 output tokens and still truncated at 2800 — 3200 covers it with headroom; the retry-with-boosted-budget path (claudeService.js/recommendationService.js) is the remaining safety net beyond this
  [GROUP.TECHNICAL_SEO]:        1500,
  [GROUP.SCHEMA]:               3000,  // FAQ/Schema JSON-LD appears in both recommendedVersion AND implementationCode
  [GROUP.ACCESSIBILITY]:        2500,  // images_missing_alt_text was observed truncating at 100% on both 1200 and the 1.5x retry (1800); the full 9-field JSON with example <img> markup needs more than that
  [GROUP.AI_VISIBILITY]:        2000,
  [GROUP.ENTITY_EEAT]:          1500,
  [GROUP.AEO_VOICE]:            1800,
};

/** Issue-to-group mapping. */
const ISSUE_GROUP_MAP = {

  // ── GROUP 1: Text Optimization ──────────────────────────────────────────────
  title_missing:              GROUP.TEXT_OPTIMIZATION,
  title_too_short:            GROUP.TEXT_OPTIMIZATION,
  title_too_long:             GROUP.TEXT_OPTIMIZATION,
  title_pixel_length:         GROUP.TEXT_OPTIMIZATION,
  multiple_title_tags:        GROUP.TEXT_OPTIMIZATION,
  meta_description_missing:   GROUP.TEXT_OPTIMIZATION,
  meta_description_too_short: GROUP.TEXT_OPTIMIZATION,
  meta_description_too_long:  GROUP.TEXT_OPTIMIZATION,
  meta_description_ctr:       GROUP.TEXT_OPTIMIZATION,
  multiple_meta_descriptions: GROUP.TEXT_OPTIMIZATION,
  keyword_not_in_h1:          GROUP.TEXT_OPTIMIZATION,
  h1_missing:                 GROUP.TEXT_OPTIMIZATION,
  multiple_h1_tags:           GROUP.TEXT_OPTIMIZATION,
  heading_hierarchy_skipped:  GROUP.TEXT_OPTIMIZATION,

  // ── GROUP 2: Content Optimization ──────────────────────────────────────────
  thin_content:                     GROUP.CONTENT_OPTIMIZATION,
  service_pages_800_words:          GROUP.CONTENT_OPTIMIZATION,
  short_paragraphs_3_to_5_lines:    GROUP.CONTENT_OPTIMIZATION,
  semantic_subtopics_covered:       GROUP.CONTENT_OPTIMIZATION,
  statistics_have_source_links:     GROUP.CONTENT_OPTIMIZATION,
  bullet_numbered_lists_used:       GROUP.CONTENT_OPTIMIZATION,
  comparison_tables_present:        GROUP.CONTENT_OPTIMIZATION,
  conversational_tone:              GROUP.CONTENT_OPTIMIZATION,
  step_by_step_content:             GROUP.CONTENT_OPTIMIZATION,
  duplicate_content:                GROUP.CONTENT_OPTIMIZATION,

  // ── GROUP 3: Technical SEO ──────────────────────────────────────────────────
  canonical_tag_errors:             GROUP.TECHNICAL_SEO,
  og_tags_missing:                  GROUP.TECHNICAL_SEO,
  og_tags_incomplete:               GROUP.TECHNICAL_SEO,
  twitter_card_tags_missing:        GROUP.TECHNICAL_SEO,
  redirect_chains:                  GROUP.TECHNICAL_SEO,
  redirect_chains_crawlability:     GROUP.TECHNICAL_SEO,
  redirect_loop:                    GROUP.TECHNICAL_SEO,
  orphan_pages:                     GROUP.TECHNICAL_SEO,
  click_depth:                      GROUP.TECHNICAL_SEO,
  topic_clusters_internal_links:    GROUP.TECHNICAL_SEO,
  broken_links:                     GROUP.TECHNICAL_SEO,
  links_to_redirecting_urls:        GROUP.TECHNICAL_SEO,
  rel_nofollow_internal:            GROUP.TECHNICAL_SEO,
  non_seo_friendly_urls:            GROUP.TECHNICAL_SEO,
  long_urls:                        GROUP.TECHNICAL_SEO,
  double_slash_urls:                GROUP.TECHNICAL_SEO,
  low_code_to_html_ratio:           GROUP.TECHNICAL_SEO,
  https_not_enforced:               GROUP.TECHNICAL_SEO,
  mixed_http_https:                 GROUP.TECHNICAL_SEO,
  googlebot_js_rendering_blocked:   GROUP.TECHNICAL_SEO,
  robots_txt_blocking:              GROUP.TECHNICAL_SEO,
  meta_refresh:                     GROUP.TECHNICAL_SEO,
  navigation_visibility:            GROUP.TECHNICAL_SEO,
  custom_404_page:                  GROUP.TECHNICAL_SEO,
  '4xx_error_pages':                GROUP.TECHNICAL_SEO,
  '5xx_server_error':               GROUP.TECHNICAL_SEO,
  timeout_errors:                   GROUP.TECHNICAL_SEO,
  xml_sitemap_exists_valid:         GROUP.TECHNICAL_SEO,

  // ── GROUP 4: Schema ─────────────────────────────────────────────────────────
  schema_markup:                    GROUP.SCHEMA,
  organization_schema:              GROUP.SCHEMA,
  sameas_array:                     GROUP.SCHEMA,
  article_schema:                   GROUP.SCHEMA,
  faq_schema:                       GROUP.SCHEMA,
  primary_organization_schema:      GROUP.SCHEMA,
  schema_valid_jsonld:              GROUP.SCHEMA,
  correct_type:                     GROUP.SCHEMA,
  context_exactly_schema_org:       GROUP.SCHEMA,
  name_field_matches_brand:         GROUP.SCHEMA,
  url_points_to_canonical_homepage: GROUP.SCHEMA,
  logo_url_returns_200:             GROUP.SCHEMA,
  no_plugin_duplicate_schemas:      GROUP.SCHEMA,
  breadcrumblist_schema:            GROUP.SCHEMA,
  faq_schema_matches_content:       GROUP.SCHEMA,
  geo_coordinates_in_schema:        GROUP.SCHEMA,
  opening_hours_specification:      GROUP.SCHEMA,
  event_schema:                     GROUP.SCHEMA,
  aggregate_rating_schema:          GROUP.SCHEMA,
  product_schema:                    GROUP.SCHEMA,
  service_product_schema_with_offers:GROUP.SCHEMA,
  consistent_id_across_pages:       GROUP.SCHEMA,
  child_schemas_reference_main_id:  GROUP.SCHEMA,

  // ── GROUP 5: Accessibility ──────────────────────────────────────────────────
  form_labels:                      GROUP.ACCESSIBILITY,
  form_inputs_labels:               GROUP.ACCESSIBILITY,
  keyboard_accessibility:           GROUP.ACCESSIBILITY,
  focus_indicators:                 GROUP.ACCESSIBILITY,
  video_captions:                   GROUP.ACCESSIBILITY,
  tap_target_size:                  GROUP.ACCESSIBILITY,
  axe_violations:                   GROUP.ACCESSIBILITY,
  page_language:                    GROUP.ACCESSIBILITY,
  images_missing_alt_text:          GROUP.ACCESSIBILITY,
  broken_images:                    GROUP.ACCESSIBILITY,
  image_file_size:                  GROUP.ACCESSIBILITY,
  images_not_webp_format:           GROUP.ACCESSIBILITY,
  images_missing_dimensions:        GROUP.ACCESSIBILITY,
  images_without_lazy_loading:      GROUP.ACCESSIBILITY,

  // ── GROUP 6: AI Visibility Core ───────────────────────────────────────────
  // LLM readiness, citation signals, entity intro, semantic structure
  last_updated_date_visible:        GROUP.AI_VISIBILITY,
  only_one_primary_entity:          GROUP.AI_VISIBILITY,
  description_minimum_50_characters:GROUP.AI_VISIBILITY,
  semantic_html_tags_used:          GROUP.AI_VISIBILITY,
  clear_entity_first_150_words:     GROUP.AI_VISIBILITY,
  content_cites_sources:            GROUP.AI_VISIBILITY,
  topic_clusters_internal_links:    GROUP.AI_VISIBILITY,   // ai_visibility issueType wins over GROUP 3
  consistent_id_across_pages:       GROUP.AI_VISIBILITY,
  child_schemas_reference_main_id:  GROUP.AI_VISIBILITY,
  semantic_subtopics_covered:       GROUP.AI_VISIBILITY,
  statistics_have_source_links:     GROUP.AI_VISIBILITY,

  // ── GROUP 7: Entity & E-E-A-T ─────────────────────────────────────────────
  // NAP consistency, author signals, trust signals
  // STRICT HALLUCINATION GUARD — these issues involve real business data
  business_name_identical:          GROUP.ENTITY_EEAT,
  address_identical:                GROUP.ENTITY_EEAT,
  nap_matches_footer_contact:       GROUP.ENTITY_EEAT,
  no_entity_fragmentation:          GROUP.ENTITY_EEAT,
  about_contact_privacy_terms_pages:GROUP.ENTITY_EEAT,
  phone_e164_format:                GROUP.ENTITY_EEAT,
  visible_author_name:              GROUP.ENTITY_EEAT,
  person_schema_linked:                 GROUP.ENTITY_EEAT,
  person_schema_linked_to_organization: GROUP.ENTITY_EEAT,
  author_bio_with_credentials:      GROUP.ENTITY_EEAT,
  author_photo:                     GROUP.ENTITY_EEAT,
  dedicated_author_page:            GROUP.ENTITY_EEAT,
  business_registration_details:    GROUP.ENTITY_EEAT,
  google_maps_embed_correct:        GROUP.ENTITY_EEAT,
  sameas_array_links_active:        GROUP.ENTITY_EEAT,
  area_served_defined:              GROUP.ENTITY_EEAT,

  // ── GROUP 8: AEO & Voice Search ───────────────────────────────────────────
  // Answer Engine Optimization, conversational content, FAQ, voice intent
  faq_section_5_to_10_questions:    GROUP.AEO_VOICE,
  question_based_h2_headings:       GROUP.AEO_VOICE,
  first_60_words_direct_answer:     GROUP.AEO_VOICE,
  conversational_tone:              GROUP.AEO_VOICE,
  step_by_step_content:             GROUP.AEO_VOICE,
  bullet_numbered_lists_used:       GROUP.AEO_VOICE,
  comparison_tables_present:        GROUP.AEO_VOICE,

  // ── TECHNICAL CHECKS ──────────────────────────────────────────────────────
  // IDs come from technicalChecks.service.js check objects (check.id field).
  // Mapped to the most semantically appropriate group so Claude uses the
  // correct system prompt, context strategy, and output format.
  security_headers:                 GROUP.TECHNICAL_SEO,   // HTTP header config
  canonical_tags:                   GROUP.TECHNICAL_SEO,   // canonicalization
  h1_tags:                          GROUP.TEXT_OPTIMIZATION, // heading content
  structured_data:                  GROUP.SCHEMA,           // JSON-LD / schema
  mobile_friendliness:              GROUP.TECHNICAL_SEO,   // viewport / responsive
  ssl_certificate:                  GROUP.TECHNICAL_SEO,   // HTTPS / TLS
  noindex_key_pages:                GROUP.TECHNICAL_SEO,   // meta robots noindex
  noindex_tags:                     GROUP.TECHNICAL_SEO,   // alias used by some checks
  xml_sitemap:                      GROUP.TECHNICAL_SEO,   // sitemap.xml existence
  social_tags:                      GROUP.TECHNICAL_SEO,   // Open Graph / Twitter Card
  og_social_tags:                   GROUP.TECHNICAL_SEO,   // alternate alias
  og_tags:                          GROUP.TECHNICAL_SEO,   // Open Graph tags alias
  robots_txt:                       GROUP.TECHNICAL_SEO,   // robots.txt config
};

/**
 * Resolve the group for a given issueId.
 *
 * For legacy on-page / technical-check / ai_visibility issues: explicit map lookup.
 * For V2 hub issues (AISO-*, AEO-*, GEO-*): pattern-based routing by hub + card prefix.
 * This means new V2 rules added to the Python pipeline automatically route to the
 * correct prompt group with zero JS changes required.
 *
 * AISO card routing:
 *   A*  (authority)    → ENTITY_EEAT        — author/org/about-page signals
 *   CV* (coverage)     → CONTENT_OPTIMIZATION — word-count, internal links, sitemap
 *   C*  (citability)   → TECHNICAL_SEO       — canonical, noindex, js-render
 *   00* (crawlability) → TECHNICAL_SEO       — robots, llms.txt, broken URLs
 *
 * AEO-*  → AEO_VOICE   — FAQ, direct answers, voice search
 * GEO-*  → ENTITY_EEAT — NAP, coordinates, hreflang, knowledge graph
 *
 * @param {string} issueId
 * @returns {number} GROUP constant
 */
export function resolveGroup(issueId) {
  // Fast path: explicit registration (all legacy on-page / technical / ai_visibility issues)
  if (ISSUE_GROUP_MAP[issueId] != null) return ISSUE_GROUP_MAP[issueId];

  // V2 AISO-* pattern: route by card prefix (suffix after "AISO-")
  if (/^AISO-/i.test(issueId)) {
    const suffix = issueId.slice(5).toLowerCase(); // e.g. "a2", "cv1", "c3", "001"
    if (suffix.startsWith('a'))  return GROUP.ENTITY_EEAT;          // A1, A2, A3 — authority
    if (suffix.startsWith('cv')) return GROUP.CONTENT_OPTIMIZATION; // CV1, CV2, CV3 — coverage (must precede 'c')
    if (suffix.startsWith('c'))  return GROUP.TECHNICAL_SEO;        // C1, C2, C3 — citability
    return GROUP.TECHNICAL_SEO;                                     // 001-010 — crawlability
  }

  // V2 AEO-* → Answer Engine Optimization / Voice Search
  if (/^AEO-/i.test(issueId)) return GROUP.AEO_VOICE;

  // V2 GEO-* → Entity / E-E-A-T (NAP, coordinates, knowledge graph, hreflang)
  if (/^GEO-/i.test(issueId)) return GROUP.ENTITY_EEAT;

  // Unknown issue — broadest fallback
  return GROUP.TECHNICAL_SEO;
}

/**
 * Get the max output tokens for a given group.
 *
 * @param {number} group
 * @returns {number}
 */
export function resolveMaxTokens(group) {
  return GROUP_MAX_TOKENS[group] ?? 1500;
}
