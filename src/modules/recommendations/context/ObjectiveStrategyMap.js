/**
 * ObjectiveStrategyMap
 *
 * Maps every known issue ID to a precise RecommendationObjective.
 * This is the single source of truth for:
 *   - What action to take (expand / shorten / fix / add / generate …)
 *   - What element to act on ("meta description", "canonical URL", …)
 *   - What constraint must be satisfied ("120-160 characters", …)
 *   - What surrounding context to preserve ("brand voice + primary keyword")
 *   - What the success criterion looks like in one sentence
 *   - Which prompt mode to use in Phase 3
 *
 * IMPORTANT: promptMode controls which Claude prompt template gets selected.
 *   content_rewrite  — Claude improves existing text (before/after expected)
 *   element_add      — Claude writes a new element from scratch
 *   structural_fix   — Claude explains how to fix a structural problem
 *   comparison_fix   — Claude resolves a mismatch between two values
 *   list_fix         — Claude addresses a list of items to fix/add
 */

import { PROMPT_MODE, OBJECTIVE_ACTION } from './RecommendationContextSchema.js';

/**
 * Get the objective strategy for a given issueId.
 * Falls back to a derived default if the issue is unknown.
 *
 * @param {string} issueId
 * @param {object} normalizedCurrentState  — from DisplayTypeNormalizer
 * @param {object} normalizedExpectedState — from DisplayTypeNormalizer
 * @param {object} [issueContext]          — raw IssueContext (for enriched constraints)
 * @returns {{ action, target, constraint, preserveContext, successCriteria, promptMode }}
 */
export function resolveObjective(issueId, normalizedCurrentState, normalizedExpectedState, issueContext) {
  const es = normalizedExpectedState || {};
  const cs = normalizedCurrentState  || {};

  // Build a dynamic range string from expected state (used in constraints)
  const range = es.targetRange || es.description || '';

  const entry = STRATEGY_MAP[issueId];
  if (entry) {
    return typeof entry === 'function'
      ? entry(cs, es, range, issueContext)
      : { ...entry };
  }

  return _defaultStrategy(issueId, cs, es, range);
}

// ── Organization / LocalBusiness objective ───────────────────────────────────
// The target schema type is NOT a constant: it comes from the schema intent that ODITO resolved from verified
// evidence (see schema-evidence/schemaIntent.js). Without an intent (no crawl data) the original wording is kept.

const _ORG_FACT_RULES = 'plus ONLY the logo, contact details and profiles listed as VERIFIED in the evidence (omit everything else)';
const _ORG_PRESERVE = 'reuse the existing organization @id and properties; never invent a logo URL, phone number, address or social profile';

function _organizationObjective(issueContext) {
  const intent = issueContext?.schemaEvidence?.organization?.intent;
  if (!intent) {
    return {
      action:          OBJECTIVE_ACTION.ADD,
      target:          'Organization schema',
      constraint:      `valid Organization JSON-LD with name and url, ${_ORG_FACT_RULES}`,
      preserveContext: _ORG_PRESERVE,
      successCriteria: 'Organization schema is valid, describes the organization once, and contains only verified values',
      promptMode:      PROMPT_MODE.ELEMENT_ADD,
    };
  }
  const typeLabel = intent.type;
  if (intent.action === 'reuse' || intent.action === 'reference') {
    return {
      action:          OBJECTIVE_ACTION.ALIGN,
      target:          `existing ${typeLabel} entity`,
      constraint:      'do NOT generate a new entity; explain how the existing one is reused',
      preserveContext: `${_ORG_PRESERVE}; keep the existing type ${typeLabel}`,
      successCriteria: 'No duplicate entity is created; the site keeps exactly one business entity',
      promptMode:      PROMPT_MODE.ELEMENT_ADD,
    };
  }
  if (intent.action === 'needs_input') {
    return {
      action:          OBJECTIVE_ACTION.ADD,
      target:          `${typeLabel} schema`,
      constraint:      `no JSON-LD until the owner supplies: ${(intent.missing || []).map((m) => m.label).join(', ')}`,
      preserveContext: _ORG_PRESERVE,
      successCriteria: 'The missing facts are requested; nothing is guessed',
      promptMode:      PROMPT_MODE.ELEMENT_ADD,
    };
  }
  return {
    action:          OBJECTIVE_ACTION.ADD,
    target:          `${typeLabel} schema`,
    constraint:      `valid ${typeLabel} JSON-LD with name and url${intent.type !== 'Organization' ? ' and the verified address' : ''}, ${_ORG_FACT_RULES}`,
    preserveContext: `${_ORG_PRESERVE}${intent.id ? `; reuse @id ${intent.id}` : ''}`,
    successCriteria: `${typeLabel} schema is valid, describes the business once, uses @type ${typeLabel}, and contains only verified values`,
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  };
}

// ── Strategy Map ─────────────────────────────────────────────────────────────

const STRATEGY_MAP = {

  // ─── Meta Description ──────────────────────────────────────────────────────

  meta_description_missing: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'meta description',
    constraint:      '120–160 characters',
    preserveContext: 'aligned with page title and primary keyword',
    successCriteria: 'A unique meta description of 120–160 characters exists on the page',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  meta_description_too_short: (cs, es) => ({
    action:          OBJECTIVE_ACTION.EXPAND,
    target:          'meta description',
    constraint:      es.targetRange || '120–160 characters',
    preserveContext: `while keeping the same intent${cs.rawText ? ` as: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: `Meta description is ${es.targetRange || '120–160 characters'} and contains the primary keyword`,
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  meta_description_too_long: (cs, es) => ({
    action:          OBJECTIVE_ACTION.SHORTEN,
    target:          'meta description',
    constraint:      es.targetRange || 'under 160 characters',
    preserveContext: `without losing keywords or call-to-action${cs.rawText ? `. Current: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: `Meta description is ${es.targetRange || 'under 160 characters'} with all key intent preserved`,
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  meta_description_ctr: (cs) => ({
    action:          OBJECTIVE_ACTION.IMPROVE,
    target:          'meta description',
    constraint:      'includes a power word, question, or CTA; 120–160 characters',
    preserveContext: `keep brand voice${cs.rawText ? `. Current: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: 'Meta description drives clicks: contains CTA or question, within 120–160 chars',
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  multiple_meta_descriptions: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'duplicate meta descriptions',
    constraint:      'exactly one unique meta description per page',
    preserveContext: 'keep the most complete/descriptive version',
    successCriteria: 'Only one meta description tag exists; others are removed',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  // ─── Title ─────────────────────────────────────────────────────────────────

  title_missing: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'title tag',
    constraint:      '30–60 characters, includes primary keyword',
    preserveContext: 'derived from page topic and H1',
    successCriteria: 'A unique, keyword-rich title tag of 30–60 characters exists',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  title_too_short: (cs, es) => ({
    action:          OBJECTIVE_ACTION.EXPAND,
    target:          'title tag',
    constraint:      es.targetRange || '30–60 characters',
    preserveContext: `keep brand, keyword, and page topic${cs.rawText ? `. Current: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: `Title is ${es.targetRange || '30–60 characters'} and includes the primary keyword`,
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  title_too_long: (cs, es) => ({
    action:          OBJECTIVE_ACTION.SHORTEN,
    target:          'title tag',
    constraint:      es.targetRange || '60 characters or fewer',
    preserveContext: `preserve brand name and primary keyword${cs.rawText ? `. Current: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: `Title is ${es.targetRange || '60 characters or fewer'} without losing keyword or brand`,
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  title_pixel_length: (cs) => ({
    action:          OBJECTIVE_ACTION.SHORTEN,
    target:          'title tag',
    constraint:      'renders within 600px on desktop (≈60 characters)',
    preserveContext: `keep primary keyword and brand intact${cs.rawText ? `. Current: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: 'Title renders without truncation in Google SERPs (≤600px / ≤60 characters)',
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  multiple_title_tags: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'duplicate title tags',
    constraint:      'exactly one title tag per page',
    preserveContext: 'keep the most descriptive title',
    successCriteria: 'Only one title tag exists on the page',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  // ─── Content ───────────────────────────────────────────────────────────────

  thin_content: (cs, es) => ({
    action:          OBJECTIVE_ACTION.EXPAND,
    target:          'page content',
    constraint:      es.targetRange || '300+ words of meaningful content',
    preserveContext: `keep topic focus and existing structure${cs.rawText ? `. Current excerpt: "${_preview(cs.rawText, 120)}"` : ''}`,
    successCriteria: `Page has ${es.targetRange || '300+ words'} of substantive, SEO-relevant content`,
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  service_pages_800_words: {
    action:          OBJECTIVE_ACTION.EXPAND,
    target:          'service page content',
    constraint:      '800+ words covering benefits, process, FAQs, and CTAs',
    preserveContext: 'keep service-specific details and brand voice',
    successCriteria: 'Service page has 800+ words with clear value proposition',
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  },

  description_minimum_50_characters: {
    action:          OBJECTIVE_ACTION.EXPAND,
    target:          'schema description field',
    constraint:      '50+ characters',
    preserveContext: 'accurately describe the entity (brand/product)',
    successCriteria: 'Schema description field has 50+ characters with accurate entity information',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  // ─── H1 / Headings ─────────────────────────────────────────────────────────

  h1_missing: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'H1 heading',
    constraint:      'one H1 matching the page topic and primary keyword',
    preserveContext: 'consistent with title tag',
    successCriteria: 'Exactly one H1 exists containing the primary keyword',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  multiple_h1_tags: (cs) => ({
    action:          OBJECTIVE_ACTION.REMOVE,
    target:          'duplicate H1 tags',
    constraint:      'exactly one H1 per page; extras converted to H2 or H3',
    preserveContext: `current H1 list: ${cs.listItems ? cs.listItems.slice(0, 3).map(h => `"${_preview(h, 40)}"`).join(', ') : 'see detected values'}`,
    successCriteria: 'Only one H1 tag; all others demoted to appropriate heading levels',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  }),

  keyword_not_in_h1: (cs) => ({
    action:          OBJECTIVE_ACTION.IMPROVE,
    target:          'H1 heading',
    constraint:      'primary keyword included naturally',
    preserveContext: `keep heading intent intact${cs.rawText ? `. Current H1: "${_preview(cs.rawText, 60)}"` : ''}`,
    successCriteria: 'H1 heading contains the primary keyword without sounding forced',
    promptMode:      PROMPT_MODE.CONTENT_REWRITE,
  }),

  heading_hierarchy_skipped: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'heading hierarchy',
    constraint:      'sequential H1 → H2 → H3 structure with no skipped levels',
    preserveContext: 'keep all heading text; only adjust heading levels',
    successCriteria: 'All heading levels are sequential with no skipped levels',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  // ─── Canonical ─────────────────────────────────────────────────────────────

  canonical_tag_errors: (cs) => {
    const rows  = cs.tableRows || [];
    const puRow = rows.find(r => r.pageUrl != null) || rows[0] || {};
    const pageUrl      = puRow.pageUrl || puRow.value || '';
    const canonicalUrl = puRow.canonicalUrl || '';
    const status       = puRow.matchStatus  || '';

    return {
      action:          OBJECTIVE_ACTION.ALIGN,
      target:          'canonical URL tag',
      constraint:      'self-referencing canonical pointing to this page\'s preferred URL',
      preserveContext: `page URL: "${_preview(pageUrl, 80)}"${canonicalUrl ? `, current canonical: "${_preview(canonicalUrl, 80)}"` : ''}${status ? `, status: ${status}` : ''}`,
      successCriteria: 'Canonical URL matches the page\'s preferred URL exactly',
      promptMode:      PROMPT_MODE.COMPARISON_FIX,
    };
  },

  // ─── Open Graph ────────────────────────────────────────────────────────────

  og_tags_missing: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'Open Graph meta tags',
    constraint:      'og:title, og:description, og:image, og:url, og:type all present',
    preserveContext: 'values derived from page title, meta description, and featured image',
    successCriteria: 'All 5 core OG properties are present and non-empty',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  og_tags_incomplete: (cs) => {
    const rows    = cs.tableRows || [];
    const missing = rows.filter(r => _isMissingRow(r)).map(r => r.field || r.Field || '').filter(Boolean);
    const present = rows.filter(r => !_isMissingRow(r)).map(r => r.field || r.Field || '').filter(Boolean);

    return {
      action:          OBJECTIVE_ACTION.FIX,
      target:          `missing OG properties: ${missing.join(', ') || 'unknown'}`,
      constraint:      'each OG field must have a non-empty, accurate value',
      preserveContext: `present fields: ${present.join(', ') || 'none'} — use these as context for missing ones`,
      successCriteria: `All missing OG fields (${missing.join(', ')}) are added with accurate content-specific values`,
      promptMode:      PROMPT_MODE.COMPARISON_FIX,
    };
  },

  // ─── Orphan / Links ────────────────────────────────────────────────────────

  orphan_pages: (cs) => {
    const isPotentialLinkers = cs.label === 'Potential Linking Pages' || cs._isOrphan;
    const items = cs.listItems || [];

    return {
      action:          OBJECTIVE_ACTION.ADD,
      target:          'inbound internal links',
      constraint:      'at least one inbound internal link from a relevant page',
      preserveContext: isPotentialLinkers && items.length > 0
        ? `potential linker pages (parent/sibling URLs): ${items.slice(0, 3).join(', ')}`
        : 'link from the most relevant parent or sibling page',
      successCriteria: 'Page has at least one inbound internal link from a related page',
      promptMode:      PROMPT_MODE.LIST_FIX,
    };
  },

  click_depth: (cs) => {
    const hops  = cs.chainHops || [];
    const depth = cs.measurement?.value;
    const threshold = cs.measurement?.threshold || 3;
    const excess = depth != null && depth > threshold ? depth - threshold : null;

    return {
      action:          OBJECTIVE_ACTION.REDUCE,
      target:          'click depth from homepage',
      constraint:      `≤${threshold} clicks from homepage`,
      preserveContext: hops.length > 1
        ? `current path: ${hops.join(' → ')} (${depth} clicks)`
        : `current depth: ${depth != null ? depth : 'unknown'} clicks`,
      successCriteria: `Page reachable in ≤${threshold} clicks${excess ? ` (currently ${excess} too deep)` : ''}`,
      promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
    };
  },

  topic_clusters_internal_links: (cs) => {
    const items  = cs.listItems || [];
    const count  = cs.measurement?.value ?? items.length;
    const needed = (cs.measurement?.threshold || 5) - count;

    return {
      action:          OBJECTIVE_ACTION.ADD,
      target:          'topical internal links',
      constraint:      'at least 5 internal links to topically related pages',
      preserveContext: items.length > 0
        ? `current links: ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` +${items.length - 3} more` : ''}`
        : 'no internal links currently detected',
      successCriteria: `Page has 5+ topical internal links${needed > 0 ? ` (needs ${needed} more)` : ''}`,
      promptMode:      PROMPT_MODE.LIST_FIX,
    };
  },

  // ─── Images ────────────────────────────────────────────────────────────────

  images_missing_alt_text: {
    action:          OBJECTIVE_ACTION.GENERATE,
    target:          'alt text for images',
    constraint:      'descriptive, keyword-relevant, under 125 characters per image',
    preserveContext: 'based on image filename, surrounding content, and page context',
    successCriteria: 'All images have descriptive alt text conveying image content and purpose',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  broken_images: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'broken image URLs',
    constraint:      'all images return HTTP 200',
    preserveContext: 'replace with working URLs or remove broken references',
    successCriteria: 'No broken image references on the page',
    promptMode:      PROMPT_MODE.LIST_FIX,
  },

  // ─── Technical / Crawlability ───────────────────────────────────────────────

  broken_links: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'broken internal links (404)',
    constraint:      'all internal links return HTTP 200',
    preserveContext: 'update destination URLs or remove dead links',
    successCriteria: 'No 404 links on the page',
    promptMode:      PROMPT_MODE.LIST_FIX,
  },

  redirect_chains: {
    action:          OBJECTIVE_ACTION.REDUCE,
    target:          'redirect chain',
    constraint:      'maximum 1 redirect hop (A → B only)',
    preserveContext: 'update source URLs to point directly to the final destination',
    successCriteria: 'All internal links point directly to their final destination URL',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  non_seo_friendly_urls: {
    action:          OBJECTIVE_ACTION.FIX,
    target:          'URL structure',
    constraint:      'lowercase, hyphenated, no query params or special characters',
    preserveContext: 'set up 301 redirect from old URL to new',
    successCriteria: 'URL is clean, readable, and SEO-friendly',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  long_urls: {
    action:          OBJECTIVE_ACTION.SHORTEN,
    target:          'URL',
    constraint:      '115 characters or fewer',
    preserveContext: 'keep keyword-rich path segments',
    successCriteria: 'URL is 115 characters or fewer',
    promptMode:      PROMPT_MODE.STRUCTURAL_FIX,
  },

  // ─── Schema ────────────────────────────────────────────────────────────────

  schema_markup: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'JSON-LD structured data',
    constraint:      'valid Schema.org type appropriate for this page',
    preserveContext: 'match detected page type (Service, Article, Product, etc.)',
    successCriteria: 'Valid JSON-LD structured data present matching the page content',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  organization_schema: (cs, es, range, issueContext) => _organizationObjective(issueContext),
  primary_organization_schema: (cs, es, range, issueContext) => _organizationObjective(issueContext),
  'aiso-a1': (cs, es, range, issueContext) => _organizationObjective(issueContext),
  'geo-s5': (cs, es, range, issueContext) => _organizationObjective(issueContext),

  product_schema: (cs) => ({
    action:          cs.isAbsent ? OBJECTIVE_ACTION.ADD : OBJECTIVE_ACTION.FIX,
    target:          cs.isAbsent ? 'Product schema' : 'Offer block in Product schema',
    constraint:      'Product schema with name, description, brand, and at least one Offer (price, priceCurrency, availability)',
    preserveContext: cs.isAbsent
      ? 'derive product name, description, and brand from page title, H1, and content'
      : 'preserve existing Product schema fields — only add the missing Offers block',
    successCriteria: 'Product schema is present with name, description, brand, and at least one Offer containing price and availability',
    promptMode:      cs.isAbsent ? PROMPT_MODE.ELEMENT_ADD : PROMPT_MODE.STRUCTURAL_FIX,
  }),

  sameas_array: {
    action:          OBJECTIVE_ACTION.ADD,
    target:          'sameAs array in Organization schema',
    constraint:      'array with 2+ verified social profile URLs (LinkedIn, Twitter/X, Facebook, etc.)',
    preserveContext: 'preserve all existing Organization schema fields — only add the sameAs property',
    successCriteria: 'Organization schema includes a sameAs array with 2+ valid social profile URLs',
    promptMode:      PROMPT_MODE.ELEMENT_ADD,
  },

  person_schema_linked: (cs) => ({
    action:          cs.isAbsent ? OBJECTIVE_ACTION.ADD : OBJECTIVE_ACTION.FIX,
    target:          'Person schema',
    constraint:      'Person schema must include: real human name, worksFor referencing Organization @id, jobTitle, and sameAs with social/profile URLs',
    preserveContext: cs.isAbsent
      ? 'derive author identity from existing Organization schema, About page content, or page metadata'
      : 'preserve all existing Person schema fields — only add or correct missing/invalid properties',
    successCriteria: 'Person schema has a real human name, worksFor linking to Organization @id, and jobTitle',
    promptMode:      cs.isAbsent ? PROMPT_MODE.ELEMENT_ADD : PROMPT_MODE.STRUCTURAL_FIX,
  }),
};

// ── Default strategy derivation ───────────────────────────────────────────────

function _defaultStrategy(issueId, cs, es, range) {
  const label = cs.label || _humanize(issueId);
  const action = cs.isAbsent ? OBJECTIVE_ACTION.ADD : OBJECTIVE_ACTION.FIX;
  const mode   = cs.isAbsent
    ? PROMPT_MODE.ELEMENT_ADD
    : cs.rawText
      ? PROMPT_MODE.CONTENT_REWRITE
      : PROMPT_MODE.STRUCTURAL_FIX;

  return {
    action,
    target:          label,
    constraint:      range || es.description || 'as per SEO best practices',
    preserveContext: 'keep existing page content and brand voice',
    successCriteria: es.description || `${label} meets the required standard`,
    promptMode:      mode,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _humanize(issueId) {
  return (issueId || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _preview(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function _isMissingRow(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || row.Status || '');
  const value  = String(row.value  || row.Value  || '');
  return status === '✗' || value.toLowerCase() === 'missing' || status.toLowerCase() === 'missing';
}
