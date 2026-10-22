/**
 * DataPathResolver
 *
 * Resolves a data_path string against a MongoDB source document and returns
 * the actual detected value — without any content duplication in issue documents.
 *
 * Architecture contract:
 *   - seo_page_issues stores a lightweight data_path pointer: "meta_tags.description"
 *   - seo_page_data is the single source of truth for the actual value
 *   - DataPathResolver bridges the pointer to the value at recommendation time
 *
 * Handles:
 *   - Dot-notation navigation: "meta_tags.description" → doc.meta_tags.description
 *   - Path aliases: "headings.h1" is stored under "content.headings.h1" in seo_page_data
 *   - Array normalization: ["AI Visibility Solutions"] → "AI Visibility Solutions"
 *   - Multi-item arrays: returns the full array (for image lists, H1 lists)
 *   - Null safety at every step
 *
 * Usage:
 *   DataPathResolver.resolveAsString('meta_tags.description', pageDataDoc)
 *   → "AI Visibility Solutions"
 *
 *   DataPathResolver.resolveAsArray('headings.h1', pageDataDoc)
 *   → ["Primary Heading", "Secondary Heading"]
 *
 *   DataPathResolver.resolve('content.word_count', pageDataDoc)
 *   → 247
 */

// ── Schema type map ───────────────────────────────────────────────────────────
//
// Maps the type keyword used in data_path notation ("structured_data.organization")
// to the @type values that appear in JSON-LD schema objects.
//
// Used by _resolveSchemaPath() to find the right schema in the structured_data array.
//
const SCHEMA_TYPE_MAP = {
  'organization':   ['Organization', 'LocalBusiness'],
  'localbusiness':  ['LocalBusiness', 'Organization'],
  'article':        ['Article', 'NewsArticle', 'BlogPosting'],
  'faqpage':        ['FAQPage'],
  'breadcrumblist': ['BreadcrumbList'],
  'product':        ['Product'],
  'service':        ['Service'],
  'event':          ['Event'],
  'person':         ['Person'],
  'website':        ['WebSite'],
  'webpage':        ['WebPage'],
};

// ── Path alias map ────────────────────────────────────────────────────────────
//
// Maps the data_path convention used in seo_page_issues rules
// to the actual MongoDB field path in seo_page_data.
//
// When a rule writes data_path="headings.h1", it means the heading data,
// but in seo_page_data headings live under content.headings.h1.
//
const PAGE_DATA_ALIASES = {
  // Headings: rules use "headings.*" but seo_page_data nests under "content"
  'headings':             'content.headings',
  'headings.h1':          'content.headings.h1',
  'headings.h2':          'content.headings.h2',
  'headings.h3':          'content.headings.h3',
  'headings.h4':          'content.headings.h4',
  'headings.hierarchy':   'content.headings',

  // Content: rules use "content.word_count" which maps directly
  'word_count':           'content.word_count',

  // Image paths use wildcard-like notation — resolve to the images array
  'images':               'images',

  // Title pixel width: the rule suffixes .desktop/.mobile so the two device
  // findings get distinct dedup_keys (they'd otherwise collide to one issue
  // identity), but both resolve to the same numeric field in seo_page_data.
  'title_pixel_width.desktop': 'title_pixel_width',
  'title_pixel_width.mobile':  'title_pixel_width',
};

// AI visibility issues reference paths inside seo_ai_visibility documents.
// These generally match their MongoDB structure directly.
const AI_VISIBILITY_ALIASES = {
  'content_metrics.word_count':    'content_metrics.word_count',
  'content_metrics.first_60_words':'content_metrics.first_60_words',
  'heading_metrics.h1_text':       'heading_metrics.h1_text',
  'heading_metrics.h2_list':       'heading_metrics.h2_list',
  'metadata.description':          'metadata.description',
};

// ── Core resolver ─────────────────────────────────────────────────────────────

export class DataPathResolver {
  /**
   * Resolve a data_path against a source document.
   *
   * Returns the raw resolved value — may be a string, number, array, or object.
   * Returns null if the path cannot be resolved.
   *
   * @param {string}  dataPath  - The data_path from the issue document
   * @param {object}  sourceDoc - The source MongoDB document (seo_page_data or seo_ai_visibility)
   * @param {string}  [hint]    - 'page_data' | 'ai_visibility' — selects the alias map
   */
  static resolve(dataPath, sourceDoc, hint = 'page_data') {
    if (!dataPath || sourceDoc == null) return null;

    // Structured data schema-type navigation:
    //   "structured_data.organization"       → find @type Organization in the array
    //   "structured_data.article.headline"   → find Article schema, then navigate .headline
    if (dataPath.startsWith('structured_data.') || dataPath === 'structured_data') {
      return DataPathResolver._resolveSchemaPath(dataPath, sourceDoc);
    }

    const aliases = hint === 'ai_visibility' ? AI_VISIBILITY_ALIASES : PAGE_DATA_ALIASES;
    const canonicalPath = aliases[dataPath] || dataPath;

    // Navigate the document using dot-notation parts
    const parts = canonicalPath.split('.');
    let value = sourceDoc;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return null;
      value = value[part];
    }

    return DataPathResolver._normalize(value);
  }

  /**
   * Resolve a "structured_data.*" path against the source document.
   *
   * Handles three forms:
   *   "structured_data"                → the full structured_data array
   *   "structured_data.organization"   → first schema with @type Organization/LocalBusiness
   *   "structured_data.article.name"   → Article schema, field .name
   */
  static _resolveSchemaPath(dataPath, sourceDoc) {
    const schemas = sourceDoc?.structured_data;

    // Plain "structured_data" — return the whole array
    if (dataPath === 'structured_data') {
      return DataPathResolver._normalize(schemas);
    }

    if (!Array.isArray(schemas) || schemas.length === 0) return null;

    // Extract the part after "structured_data."
    const rest = dataPath.slice('structured_data.'.length);
    if (!rest) return DataPathResolver._normalize(schemas);

    const parts = rest.split('.');
    const typeKey = parts[0].toLowerCase();
    const nestedParts = parts.slice(1);

    const types = SCHEMA_TYPE_MAP[typeKey];
    if (!types) return null;

    const schema = schemas.find(s => types.includes(s['@type']));
    if (!schema) return null;

    if (nestedParts.length === 0) return DataPathResolver._normalize(schema);

    // Navigate deeper into the matched schema object
    let value = schema;
    for (const part of nestedParts) {
      if (value == null || typeof value !== 'object') return null;
      value = value[part];
    }
    return DataPathResolver._normalize(value);
  }

  /**
   * Resolve and guarantee a string result.
   *
   * - Array of strings → first non-empty string
   * - String → trimmed string
   * - Number → string representation
   * - null / empty → null
   */
  static resolveAsString(dataPath, sourceDoc, hint = 'page_data') {
    const value = DataPathResolver.resolve(dataPath, sourceDoc, hint);
    return DataPathResolver._toStr(value);
  }

  /**
   * Resolve and guarantee an array result.
   *
   * - Array → returned as-is (after string normalization if all items are strings)
   * - String → wrapped in array
   * - null → empty array
   */
  static resolveAsArray(dataPath, sourceDoc, hint = 'page_data') {
    const value = DataPathResolver.resolve(dataPath, sourceDoc, hint);
    if (value == null) return [];
    if (Array.isArray(value)) {
      // Normalize string items; keep objects as-is
      return value
        .map(item => (typeof item === 'string' ? item.trim() : item))
        .filter(item => item !== '' && item != null);
    }
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    return [value];
  }

  /**
   * Resolve and guarantee a number result.
   * Returns null if value is not a valid number.
   */
  static resolveAsNumber(dataPath, sourceDoc, hint = 'page_data') {
    const value = DataPathResolver.resolve(dataPath, sourceDoc, hint);
    if (value == null) return null;
    if (typeof value === 'number') return value;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Normalize a raw value from a MongoDB document field.
   *
   * The key normalization rule for lists:
   *   Single-element string array → unwrap to string (meta_tags.description behaviour)
   *   Multi-element string array  → keep as array (multiple H1 texts, image list)
   *   Object/number/boolean       → returned as-is
   */
  static _normalize(value) {
    if (value == null) return null;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return null;

      const allStrings = value.every(item => typeof item === 'string');

      if (allStrings) {
        const filtered = value.map(s => s.trim()).filter(Boolean);
        if (filtered.length === 0) return null;
        // Single string → unwrap (e.g., meta_tags.description = ["AI Visibility Solutions"])
        if (filtered.length === 1) return filtered[0];
        // Multiple strings → keep array (e.g., multiple H1 texts)
        return filtered;
      }

      // Array of objects (images, structured_data) → keep as-is
      return value.filter(item => item != null);
    }

    if (typeof value === 'object') {
      return value;
    }

    return String(value);
  }

  static _toStr(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value || null;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      const first = value.find(item => item != null && item !== '');
      if (first == null) return null;
      return typeof first === 'string' ? first : String(first);
    }
    return null;
  }
}

export default DataPathResolver;
