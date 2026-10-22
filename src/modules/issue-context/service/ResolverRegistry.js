/**
 * ResolverRegistry
 *
 * Central mapping of every supported issue_code / rule_id to:
 *   - resolver   : which grouped resolver class handles it
 *   - dataSources: which extractors to invoke (parallel fetch)
 *   - displayType: how CurrentState should be rendered in the UI
 *   - issueType  : 'on_page' | 'ai_visibility'
 *
 * Adding a new issue = adding one entry here.
 * No other file needs to change.
 */

export const RESOLVER = {
  CONTENT:       'ContentResolver',
  IMAGE:         'ImageResolver',
  SCHEMA:        'SchemaResolver',
  ACCESSIBILITY: 'AccessibilityResolver',
  TECHNICAL:     'TechnicalResolver',
  ENTITY:        'EntityResolver',
};

export const DATA_SOURCE = {
  PAGE_DATA:    'page_data',
  AI_VISIBILITY:'ai_visibility',
  HEADLESS:     'headless',
  CRAWL_GRAPH:  'crawl_graph',
  TECHNICAL:    'technical',
};

export const DISPLAY_TYPE = {
  TEXT:   'text',
  METRIC: 'metric',
  CODE:   'code',
  TABLE:  'table',
  TREE:   'tree',
  CHAIN:  'chain',
  ABSENT: 'absent',
  LIST:   'list',
};

/**
 * Each entry:
 * {
 *   resolver    : RESOLVER.*
 *   dataSources : DATA_SOURCE[]
 *   displayType : DISPLAY_TYPE.*
 *   issueType   : 'on_page' | 'ai_visibility'
 * }
 */
const REGISTRY = {

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — CONTENT
  // ─────────────────────────────────────────────────────────
  title_missing:              { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.ABSENT,  issueType: 'on_page' },
  title_too_short:            { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  title_too_long:             { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  multiple_title_tags:        { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.LIST,    issueType: 'on_page' },
  meta_description_missing:   { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.ABSENT,  issueType: 'on_page' },
  meta_description_too_short: { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  meta_description_too_long:  { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  multiple_meta_descriptions:  { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.LIST,    issueType: 'on_page' },
  h1_missing:                 { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.ABSENT,  issueType: 'on_page' },
  multiple_h1_tags:           { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.LIST,    issueType: 'on_page' },
  heading_hierarchy_skipped:  { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TREE,    issueType: 'on_page' },
  thin_content:               { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  keyword_not_in_h1:          { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  duplicate_content:          { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.LIST,    issueType: 'on_page' },
  title_pixel_length:         { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },
  meta_description_ctr:       { resolver: RESOLVER.CONTENT,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,    issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — IMAGES
  // ─────────────────────────────────────────────────────────
  images_missing_alt_text:    { resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },
  broken_images:              { resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.LIST,    issueType: 'on_page' },
  image_file_size:            { resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },
  images_not_webp_format:     { resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },
  images_missing_dimensions:  { resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },
  images_without_lazy_loading:{ resolver: RESOLVER.IMAGE,    dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — ACCESSIBILITY
  // ─────────────────────────────────────────────────────────
  // The Python rule (FormLabelsRule) emits `form_labels`. `form_inputs_labels` was the name
  // registered here, so the real issue was "not in registry" (Unknown issue type / Not detected /
  // no recommendation). Both are kept: the old name is an alias, never emitted.
  form_labels:                { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },
  form_inputs_labels:         { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },
  keyboard_accessibility:     { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  focus_indicators:           { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  page_language:              { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.PAGE_DATA],                                   displayType: DISPLAY_TYPE.TEXT,   issueType: 'on_page' },
  video_captions:             { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.PAGE_DATA, DATA_SOURCE.HEADLESS],             displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  tap_target_size:            { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },
  axe_violations:             { resolver: RESOLVER.ACCESSIBILITY, dataSources: [DATA_SOURCE.HEADLESS],                                    displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — TECHNICAL / LINKS / REDIRECTS / CRAWLABILITY
  // ─────────────────────────────────────────────────────────
  broken_links:               { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  links_to_redirecting_urls:  { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  rel_nofollow_internal:      { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  orphan_pages:               { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  click_depth:                { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.CHAIN,  issueType: 'on_page' },
  redirect_chains:            { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.CHAIN,  issueType: 'on_page' },
  redirect_chains_crawlability:{ resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                    displayType: DISPLAY_TYPE.CHAIN,  issueType: 'on_page' },
  redirect_loop:              { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.CHAIN,  issueType: 'on_page' },
  meta_refresh:               { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.CODE,   issueType: 'on_page' },
  canonical_tag_errors:       { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },
  robots_txt_blocking:        { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL],                                       displayType: DISPLAY_TYPE.CODE,   issueType: 'on_page' },
  https_not_enforced:         { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  googlebot_js_rendering_blocked: { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL],                                   displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  mixed_http_https:           { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  non_seo_friendly_urls:      { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.TEXT,   issueType: 'on_page' },
  double_slash_urls:          { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.TEXT,   issueType: 'on_page' },
  low_code_to_html_ratio:     { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.METRIC, issueType: 'on_page' },
  long_urls:                  { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.TEXT,   issueType: 'on_page' },
  navigation_visibility:      { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.ABSENT, issueType: 'on_page' },
  custom_404_page:            { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.ABSENT, issueType: 'on_page' },
  '4xx_error_pages':          { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  '5xx_server_error':         { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  timeout_errors:             { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.CRAWL_GRAPH],                                     displayType: DISPLAY_TYPE.LIST,   issueType: 'on_page' },
  og_tags_missing:            { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.ABSENT, issueType: 'on_page' },
  og_tags_incomplete:         { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.TABLE,  issueType: 'on_page' },
  twitter_card_tags_missing:  { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                                       displayType: DISPLAY_TYPE.ABSENT, issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — SCHEMA
  // ─────────────────────────────────────────────────────────
  schema_markup:              { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  organization_schema:        { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  sameas_array:               { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  article_schema:             { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  faq_schema:                 { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  product_schema:             { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  breadcrumblist_schema:      { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  deprecated_schema_types:    { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  duplicate_schema_formats:   { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.CODE,    issueType: 'on_page' },
  invalid_schema_type:        { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },
  schema_type_conflict:       { resolver: RESOLVER.SCHEMA,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TABLE,   issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // ON-PAGE — ENTITY / EEAT
  // ─────────────────────────────────────────────────────────
  author_name_bio:            { resolver: RESOLVER.ENTITY,   dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.ABSENT,  issueType: 'on_page' },

  // ─────────────────────────────────────────────────────────
  // AI VISIBILITY — AI IMPACT
  // ─────────────────────────────────────────────────────────
  primary_organization_schema:    { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  schema_valid_jsonld:            { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  correct_type:                   { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  context_exactly_schema_org:     { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  name_field_matches_brand:       { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  url_points_to_canonical_homepage:{ resolver: RESOLVER.SCHEMA, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  // Emitted by python page_analysis LogoUrlReturns200Rule (schema_rules.py) - an on-page finding with the
  // broken logo URL as its detected value. (It was registered as an AI-visibility id that no rule emitted.)
  logo_url_returns_200:           { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.PAGE_DATA],  displayType: DISPLAY_TYPE.TEXT,   issueType: 'on_page' },
  xml_sitemap_exists_valid:       { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL, DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  robots_txt_non_blocking:        { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL, DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  no_plugin_duplicate_schemas:    { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  semantic_html_tags_used:        { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  breadcrumblist_schema:          { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,   issueType: 'ai_visibility' },
  faq_schema_matches_content:     { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },

  // AI VISIBILITY — CITATION PROBABILITY
  business_name_identical:        { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },
  address_identical:              { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },
  nap_matches_footer_contact:     { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },
  no_entity_fragmentation:        { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  about_contact_privacy_terms_pages:{ resolver: RESOLVER.ENTITY,dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  phone_e164_format:              { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  visible_author_name:            { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  person_schema_linked:               { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.PAGE_DATA],    displayType: DISPLAY_TYPE.CODE, issueType: 'on_page' },
  person_schema_linked_to_organization:{ resolver: RESOLVER.ENTITY, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE, issueType: 'ai_visibility' },
  author_bio_with_credentials:    { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  author_photo:                   { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  dedicated_author_page:          { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  business_registration_details:  { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  google_maps_embed_correct:      { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },

  // AI VISIBILITY — LLM READINESS
  service_pages_800_words:        { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  topic_clusters_internal_links:  { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.AI_VISIBILITY, DATA_SOURCE.CRAWL_GRAPH], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  webp_avif_images_lazy_loading:  { resolver: RESOLVER.IMAGE,   dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },
  clear_entity_first_150_words:   { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  sameas_array_links_active:      { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  geo_coordinates_in_schema:      { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  description_minimum_50_characters:{ resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  area_served_defined:            { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  last_updated_date_visible:      { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  semantic_subtopics_covered:     { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  statistics_have_source_links:   { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  short_paragraphs_3_to_5_lines:  { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },

  // AI VISIBILITY — AEO
  first_60_words_direct_answer:   { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TEXT,   issueType: 'ai_visibility' },
  faq_section_5_to_10_questions:  { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  question_based_h2_headings:     { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  content_cites_sources:          { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },

  // AI VISIBILITY — TOPICAL AUTHORITY
  only_one_primary_entity:        { resolver: RESOLVER.ENTITY,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  consistent_id_across_pages:     { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.LIST,   issueType: 'ai_visibility' },
  child_schemas_reference_main_id:{ resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.TABLE,  issueType: 'ai_visibility' },
  opening_hours_specification:    { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  event_schema:                   { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'ai_visibility' },
  aggregate_rating_schema:        { resolver: RESOLVER.SCHEMA,  dataSources: [DATA_SOURCE.PAGE_DATA, DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.ABSENT, issueType: 'on_page' },
  service_product_schema_with_offers:{ resolver: RESOLVER.SCHEMA, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.CODE,  issueType: 'ai_visibility' },

  // AI VISIBILITY — VOICE INTENT
  bullet_numbered_lists_used:     { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  comparison_tables_present:      { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  conversational_tone:            { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },
  step_by_step_content:           { resolver: RESOLVER.CONTENT, dataSources: [DATA_SOURCE.AI_VISIBILITY], displayType: DISPLAY_TYPE.METRIC, issueType: 'ai_visibility' },

  // ─────────────────────────────────────────────────────────
  // TECHNICAL CHECKS
  // IDs match check.id values returned by technicalChecks.service.js.
  // TechnicalResolver + TechnicalReportExtractor is the primary path;
  // PAGE_DATA is added for checks that are per-page rather than domain-level.
  // ─────────────────────────────────────────────────────────
  security_headers:    { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL, DATA_SOURCE.PAGE_DATA], displayType: DISPLAY_TYPE.LIST,   issueType: 'technical_check' },
  canonical_tags:      { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.TABLE,  issueType: 'technical_check' },
  h1_tags:             { resolver: RESOLVER.CONTENT,   dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.LIST,   issueType: 'technical_check' },
  structured_data:     { resolver: RESOLVER.SCHEMA,    dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.CODE,   issueType: 'technical_check' },
  mobile_friendliness: { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL, DATA_SOURCE.PAGE_DATA], displayType: DISPLAY_TYPE.LIST,   issueType: 'technical_check' },
  ssl_certificate:     { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL],                        displayType: DISPLAY_TYPE.TEXT,   issueType: 'technical_check' },
  noindex_key_pages:   { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.LIST,   issueType: 'technical_check' },
  noindex_tags:        { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.LIST,   issueType: 'technical_check' },
  xml_sitemap:         { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL],                        displayType: DISPLAY_TYPE.ABSENT, issueType: 'technical_check' },
  og_tags:             { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.ABSENT, issueType: 'technical_check' },
  social_tags:         { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.ABSENT, issueType: 'technical_check' },
  og_social_tags:      { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.PAGE_DATA],                        displayType: DISPLAY_TYPE.ABSENT, issueType: 'technical_check' },
  robots_txt:          { resolver: RESOLVER.TECHNICAL, dataSources: [DATA_SOURCE.TECHNICAL],                        displayType: DISPLAY_TYPE.CODE,   issueType: 'technical_check' },
};

/**
 * Lookup an issue definition.
 * Returns null for unknown issue IDs — engine handles gracefully.
 */
export function getRegistryEntry(issueId) {
  return REGISTRY[issueId] || null;
}

/**
 * Returns true if the issueId is registered.
 */
export function isKnownIssue(issueId) {
  return issueId in REGISTRY;
}

export default REGISTRY;
