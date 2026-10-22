/**
 * PageTypeDetector (Node.js)
 *
 * Server-side page type and framework detector used by IssueContextEngine
 * when seo_page_data.page_context is absent (e.g. older audit records before
 * the Python context-enrichment layer was deployed).
 *
 * This is NOT a replacement for the Python-layer detection — that runs at
 * crawl time with full HTML access.  This runs at recommendation time using
 * only the URL, title, H1, and any available schema types.
 *
 * Output shapes mirror the Python context_enrichment module:
 *
 *   detectPageType(...)  → { name: "Contact", confidence: 88 }
 *   detectFramework(...) → { name: "Next.js", key: "nextjs", confidence: 70, source: "url" }
 */

// ── Page type URL rules ────────────────────────────────────────────────────────
// Each entry: [regex, type, confidence]
const URL_RULES = [
  // Homepage
  [/^\/?$/, 'Homepage', 90],
  [/^\/index\.(html?|php)$/i, 'Homepage', 90],

  // Pricing
  [/\/pricing/i, 'Pricing', 88],
  [/\/plans\b/i, 'Pricing', 80],

  // Legal
  [/\/privacy[-_]policy/i, 'Legal', 90],
  [/\/privacy$/i, 'Legal', 82],
  [/\/terms[-_](of[-_](service|use))?/i, 'Legal', 90],
  [/\/terms$/i, 'Legal', 85],
  [/\/cookie[-_]policy/i, 'Legal', 88],
  [/\/disclaimer/i, 'Legal', 80],
  [/\/gdpr/i, 'Legal', 85],
  [/\/legal/i, 'Legal', 80],

  // Contact
  [/\/contact[-_]us/i, 'Contact', 90],
  [/\/contact$/i, 'Contact', 88],
  [/\/get[-_]in[-_]touch/i, 'Contact', 85],
  [/\/reach[-_](us|out)/i, 'Contact', 82],

  // About
  [/\/about[-_]us/i, 'About', 90],
  [/\/about$/i, 'About', 88],
  [/\/our[-_]story/i, 'About', 82],
  [/\/company\b/i, 'About', 72],
  [/\/who[-_]we[-_]are/i, 'About', 78],

  // FAQ
  [/\/faq/i, 'FAQ', 88],
  [/\/help\//i, 'FAQ', 70],
  [/\/support\//i, 'FAQ', 65],
  [/\/knowledge[-_]base/i, 'FAQ', 72],

  // Blog root vs individual post
  [/\/blog\/?$/i, 'Blog', 85],
  [/\/blog\//i, 'Article', 80],
  [/\/posts?\//i, 'Article', 78],
  [/\/news\//i, 'Article', 78],
  [/\/article\//i, 'Article', 80],
  [/\/insights\//i, 'Article', 72],

  // Product
  [/\/products?\//i, 'Product', 82],
  [/\/shop\/[^/]+$/i, 'Product', 78],
  [/\/item\//i, 'Product', 78],
  [/\/p\/[^/]+$/i, 'Product', 75],

  // Service
  [/\/services?\//i, 'Service', 82],
  [/\/solutions\//i, 'Service', 75],

  // Collection / Listing
  [/\/categor(?:y|ies)\//i, 'Collection', 80],
  [/\/collection\//i, 'Collection', 80],
  [/\/catalog\//i, 'Collection', 78],
  [/\/shop\/?$/i, 'Collection', 75],
  [/\/tag\//i, 'Listing', 72],
  [/\/archive\//i, 'Listing', 72],
  [/\/search\b/i, 'Listing', 68],
];

// Title/H1 keyword rules
const TEXT_RULES = [
  [/contact\s+us/i, 'Contact', 72],
  [/\bcontact\b/i, 'Contact', 58],
  [/get\s+in\s+touch/i, 'Contact', 70],
  [/about\s+us/i, 'About', 72],
  [/\babout\b/i, 'About', 55],
  [/our\s+story/i, 'About', 68],
  [/\bpricing\b/i, 'Pricing', 72],
  [/plans?\s+(?:&|and)\s+pricing/i, 'Pricing', 78],
  [/\bfaq\b/i, 'FAQ', 72],
  [/frequently\s+asked/i, 'FAQ', 75],
  [/privacy\s+policy/i, 'Legal', 78],
  [/terms\s+of\s+(?:service|use)/i, 'Legal', 78],
  [/cookie\s+policy/i, 'Legal', 72],
];

// Schema.org @type → page type
const SCHEMA_MAP = {
  Article:        'Article',
  BlogPosting:    'Article',
  NewsArticle:    'Article',
  TechArticle:    'Article',
  Product:        'Product',
  ProductGroup:   'Product',
  Service:        'Service',
  FAQPage:        'FAQ',
  QAPage:         'FAQ',
  CollectionPage: 'Collection',
  AboutPage:      'About',
  ContactPage:    'Contact',
  ItemList:       'Listing',
  WebSite:        'Homepage',
};

// Framework URL heuristics (last resort when no HTML available server-side)
const FRAMEWORK_URL_HINTS = [
  [/\/_next\//i, 'nextjs', 'Next.js', 70],
  [/\/_nuxt\//i, 'nuxtjs', 'Nuxt.js', 70],
  [/\/wp-content\//i, 'wordpress', 'WordPress', 75],
  [/\/s\/files\//i, 'shopify', 'Shopify', 75],
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detect page type from URL, title, H1, and schema types.
 *
 * @param {object} opts
 * @param {string}   [opts.url]
 * @param {string}   [opts.title]
 * @param {string}   [opts.h1]
 * @param {string[]} [opts.schemaTypes]
 * @returns {{ name: string, confidence: number }}
 */
export function detectPageType({ url = '', title = '', h1 = '', schemaTypes = [] } = {}) {
  const candidates = [];

  // 1. Schema.org (highest confidence)
  for (const type of schemaTypes) {
    const mapped = SCHEMA_MAP[type];
    if (mapped) {
      candidates.push({ name: mapped, confidence: 90 });
      break;
    }
  }

  // 2. URL path
  if (url) {
    try {
      const { pathname } = new URL(url);
      const path = pathname.toLowerCase();

      if (path === '/' || path === '' || /^\/index\.(html?|php)$/i.test(path)) {
        candidates.push({ name: 'Homepage', confidence: 90 });
      } else {
        for (const [pattern, type, confidence] of URL_RULES) {
          if (pattern.test(pathname)) {
            candidates.push({ name: type, confidence });
            break;
          }
        }
      }
    } catch { /* invalid URL — skip */ }
  }

  // 3. Title + H1
  const text = `${title} ${h1}`.trim();
  if (text) {
    for (const [pattern, type, confidence] of TEXT_RULES) {
      if (pattern.test(text)) {
        candidates.push({ name: type, confidence });
        break;
      }
    }
  }

  // Return highest-confidence non-Generic result
  candidates.sort((a, b) => b.confidence - a.confidence);
  for (const c of candidates) {
    if (c.name !== 'Generic') return c;
  }

  return { name: 'Generic', confidence: 40 };
}

/**
 * Detect framework from URL (last-resort server-side heuristic).
 * The Python scraper has full HTML — this only runs on old records.
 *
 * @param {string} url
 * @returns {{ name: string, key: string, confidence: number, source: string }}
 */
export function detectFrameworkFromUrl(url = '') {
  for (const [pattern, key, name, confidence] of FRAMEWORK_URL_HINTS) {
    if (pattern.test(url)) {
      return { name, key, confidence, source: 'url' };
    }
  }
  return { name: 'Generic HTML', key: 'generic', confidence: 40, source: 'fallback' };
}

/**
 * Normalize a raw framework/pageType string to a consistent display form.
 * Handles both the legacy flat-string format and the new structured dict format.
 *
 * @param {string|object|null} raw
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeFrameworkString(raw, fallback = 'unknown') {
  if (!raw) return fallback;
  if (typeof raw === 'object') {
    return (raw.key || raw.name || fallback).toLowerCase();
  }
  return String(raw).toLowerCase() || fallback;
}

export function normalizePageTypeString(raw, fallback = 'Unknown') {
  if (!raw) return fallback;
  if (typeof raw === 'object') {
    return raw.name || fallback;
  }
  return String(raw) || fallback;
}
