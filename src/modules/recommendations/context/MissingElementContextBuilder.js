/**
 * MissingElementContextBuilder
 *
 * Infers rich context for missing-element issues from available RC signals.
 * Called by RecommendationContextBuilder when currentState.isAbsent === true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Input:  RecommendationContext (assembled by RCB, pre-cache)
 * Output: missingElementContext {
 *   primaryTopic    — the main subject of the page (e.g. "About Naxonify")
 *   pageIntent      — human-readable page purpose (e.g. "About Page")
 *   serviceName     — service name for service pages (e.g. "SEO Audit")
 *   businessName    — brand/company name (e.g. "Naxonify")
 *   entityName      — entity for schema generation (falls back to businessName)
 *   contentType     — display-friendly page type (e.g. "Service Page")
 *   urlSlug         — cleaned last URL path segment (e.g. "seo-audit")
 *   inferenceSources — signals used for inference (title, h1, url, …)
 *   isRich          — true when enough context exists for page-specific generation
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 *   When an element is absent (isAbsent: true) the currentState carries no
 *   rawValue.  Without inference the AI falls back to "Add an H1 tag" style
 *   generic output.  This builder surfaces page-specific signals so the prompt
 *   can instruct Claude to generate exact, production-ready content.
 *
 * ANTI-HALLUCINATION CONTRACT
 *   This module never invents values — it only surfaces signals that already
 *   exist in the RecommendationContext.  If a signal is absent, its field is
 *   null.  The PromptBuilder must not tell Claude to fill in null fields.
 */

// URL path patterns → page intent
const INTENT_PATTERNS = [
  { re: /\/(about|about-us|about_us|who-we-are|our-story)(?:\/|$)/i,                   intent: 'About Page',    type: 'about'      },
  { re: /\/(contact|contact-us|contact_us|get-in-touch|reach-us)(?:\/|$)/i,            intent: 'Contact Page',  type: 'contact'    },
  { re: /\/(services?|solutions?|what-we-do|our-services)(?:\/[^/]+)?(?:\/|$)/i,        intent: 'Service Page',  type: 'service'    },
  { re: /\/(blog|articles?|news|posts?|insights?)(?:\/[^/]+)?(?:\/|$)/i,               intent: 'Blog Article',  type: 'blog'       },
  { re: /\/(case-stud(?:y|ies)|portfolio|work|projects?)(?:\/[^/]+)?(?:\/|$)/i,        intent: 'Case Study',    type: 'case_study' },
  { re: /\/(pricing|plans?|packages?|rates?)(?:\/|$)/i,                                intent: 'Pricing Page',  type: 'pricing'    },
  { re: /\/(team|staff|people|our-team|meet-the-team)(?:\/|$)/i,                       intent: 'Team Page',     type: 'team'       },
  { re: /\/(faq|faqs|frequently-asked|help|support)(?:\/|$)/i,                         intent: 'FAQ Page',      type: 'faq'        },
  { re: /\/(product|products?|shop|store|buy)(?:\/[^/]+)?(?:\/|$)/i,                   intent: 'Product Page',  type: 'product'    },
  { re: /^\/?$|\/(?:home|index)?(?:\.\w+)?$/i,                                          intent: 'Home Page',     type: 'home'       },
  { re: /\/(location|locations?|area|areas?)(?:\/[^/]+)?(?:\/|$)/i,                    intent: 'Location Page', type: 'location'   },
  { re: /\/(testimonials?|reviews?|feedback)(?:\/|$)/i,                                intent: 'Reviews Page',  type: 'reviews'    },
];

// pageType (from IssueContext) → human-readable label
const PAGE_TYPE_LABELS = {
  homepage:    'Home Page',
  service:     'Service Page',
  blog:        'Blog Article',
  article:     'Article',
  about:       'About Page',
  contact:     'Contact Page',
  product:     'Product Page',
  landing:     'Landing Page',
  faq:         'FAQ Page',
  portfolio:   'Portfolio Page',
  pricing:     'Pricing Page',
  team:        'Team Page',
  case_study:  'Case Study',
  location:    'Location Page',
  category:    'Category Page',
  reviews:     'Reviews Page',
};

class MissingElementContextBuilder {

  /**
   * Infer missing element context from an assembled RecommendationContext.
   * Returns null when signals are insufficient (zero inference sources).
   *
   * @param {object} rc — RecommendationContext (built by RecommendationContextBuilder)
   * @returns {object|null}
   */
  infer(rc) {
    if (!rc) return null;

    const pageUrl    = rc.pageContext?.pageUrl       || '';
    const pageType   = rc.pageContext?.pageType      || '';
    const title      = rc.contentContext?.pageTitle  || '';
    const h1Text     = rc.contentContext?.h1Text     || '';
    const metaDesc   = rc.contentContext?.metaDescription || '';
    const entityCtx  = rc.entityContext?.businessName
                    || rc.aiVisibilityContext?.entityName
                    || '';

    // ── 1. URL path decomposition ────────────────────────────────────────────
    const { urlPath, urlSlug } = this._parseUrl(pageUrl);

    // ── 2. Business name ──────────────────────────────────────────────────────
    const businessName = this._extractBusinessName(title, entityCtx, pageUrl);

    // ── 3. Primary topic ─────────────────────────────────────────────────────
    const primaryTopic = this._extractPrimaryTopic(title, h1Text, urlSlug, pageType);

    // ── 4. Page intent ───────────────────────────────────────────────────────
    const { intent: pageIntent, type: intentType } = this._detectPageIntent(urlPath, pageType);

    // ── 5. Service name ──────────────────────────────────────────────────────
    const serviceName = intentType === 'service'
      ? this._extractServiceName(urlPath, primaryTopic)
      : null;

    // ── 6. Content type ──────────────────────────────────────────────────────
    const contentType = PAGE_TYPE_LABELS[(pageType || '').toLowerCase()]
                     || pageIntent
                     || 'Web Page';

    // ── 7. Entity name ───────────────────────────────────────────────────────
    const entityName = entityCtx || businessName || null;

    // ── 8. Inference sources (for UI transparency) ────────────────────────────
    const inferenceSources = [];
    if (title)     inferenceSources.push('title');
    if (h1Text)    inferenceSources.push('h1');
    if (urlPath)   inferenceSources.push('url');
    if (metaDesc)  inferenceSources.push('meta_description');
    if (entityCtx) inferenceSources.push('entity_context');

    if (inferenceSources.length === 0) return null;

    // ── 9. Richness flag ─────────────────────────────────────────────────────
    // "Rich" means we have enough distinct signals to generate page-specific
    // content rather than falling back to a structural placeholder.
    const isRich = Boolean(
      businessName ||
      (primaryTopic && primaryTopic.length > 3 && primaryTopic.toLowerCase() !== 'page') ||
      (serviceName  && serviceName.length  > 3)
    );

    return {
      primaryTopic:     primaryTopic || urlSlug || null,
      pageIntent:       pageIntent,
      serviceName:      serviceName  || null,
      businessName:     businessName || null,
      entityName:       entityName   || null,
      contentType,
      urlSlug:          urlSlug      || null,
      inferenceSources,
      isRich,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Parse a URL into { urlPath, urlSlug }.
   * Handles absolute URLs, root-relative paths, and malformed inputs.
   */
  _parseUrl(pageUrl) {
    if (!pageUrl) return { urlPath: '', urlSlug: '' };
    try {
      const parsed = new URL(pageUrl);
      const path = parsed.pathname;
      const segments = path.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      return { urlPath: path, urlSlug: this._slugToText(last) };
    } catch {
      // Root-relative or relative path
      const path = pageUrl.split('?')[0].split('#')[0];
      const segments = path.split('/').filter(s => s && !s.includes('.'));
      const last = segments[segments.length - 1] || '';
      return { urlPath: path, urlSlug: this._slugToText(last) };
    }
  }

  /**
   * Extract the brand/business name from:
   *   1. entityCtx (from entityContext or aiVisibilityContext — most reliable)
   *   2. Title separator suffix ("About Us - Naxonify" → "Naxonify")
   *   3. Domain name (last resort)
   *
   * Examples:
   *   "About Us - Naxonify"    → "Naxonify"
   *   "SEO Services | Acme"    → "Acme"
   *   "Naxonify | Home"        → "Naxonify"
   */
  _extractBusinessName(title, entityCtx, pageUrl) {
    if (entityCtx) return entityCtx;

    if (title) {
      // "Title - Brand" pattern
      const dashParts = title.split(' - ');
      if (dashParts.length >= 2) return dashParts[dashParts.length - 1].trim();

      // "Title | Brand" pattern
      const pipeParts = title.split(' | ');
      if (pipeParts.length >= 2) return pipeParts[pipeParts.length - 1].trim();
    }

    // Domain fallback: naxonify.com → "Naxonify"
    if (pageUrl) {
      try {
        const hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
        const base = hostname.split('.')[0];
        if (base && base.length > 1) {
          return base.charAt(0).toUpperCase() + base.slice(1);
        }
      } catch { /* malformed URL — skip */ }
    }

    return null;
  }

  /**
   * Extract the primary topic of the page.
   * Priority: title prefix > H1 > URL slug > pageType
   *
   * Examples:
   *   title "About Us - Naxonify"    → "About Us"
   *   title "SEO Services | Acme"    → "SEO Services"
   *   title "Acme Corp" (no sep)     → "Acme Corp"  (if ≤ 60 chars)
   *   h1   "Our SEO Services"        → "Our SEO Services"
   *   slug "seo-audit"               → "SEO Audit"
   */
  _extractPrimaryTopic(title, h1Text, urlSlug, pageType) {
    if (title) {
      const dashParts = title.split(' - ');
      if (dashParts.length >= 2) return dashParts[0].trim();

      const pipeParts = title.split(' | ');
      if (pipeParts.length >= 2) return pipeParts[0].trim();

      if (title.length <= 70) return title.trim();
      return title.slice(0, 70).trim();
    }

    if (h1Text && h1Text.length <= 80) return h1Text.trim();

    if (urlSlug && urlSlug.length > 2) return urlSlug;

    if (pageType && pageType !== 'Unknown') {
      return PAGE_TYPE_LABELS[(pageType || '').toLowerCase()] || pageType;
    }

    return '';
  }

  /**
   * Detect the page's intent by matching URL path against known patterns.
   * Falls back to pageType if no URL pattern matches.
   */
  _detectPageIntent(urlPath, pageType) {
    if (urlPath) {
      for (const { re, intent, type } of INTENT_PATTERNS) {
        if (re.test(urlPath)) return { intent, type };
      }
    }

    const typeKey = (pageType || '').toLowerCase();
    if (PAGE_TYPE_LABELS[typeKey]) {
      return { intent: PAGE_TYPE_LABELS[typeKey], type: typeKey };
    }

    return { intent: 'Web Page', type: 'general' };
  }

  /**
   * Extract service name from a service URL.
   * "/services/seo-audit" → "SEO Audit"
   * "/services/social-media-marketing" → "Social Media Marketing"
   */
  _extractServiceName(urlPath, primaryTopic) {
    const match = urlPath.match(/\/(?:services?|solutions?)\/([^/?#]+)/i);
    if (match) {
      const slug = match[1];
      const readable = this._slugToText(slug);
      // Reject generic slugs that add no information
      if (!['services', 'service', 'solutions', 'solution'].includes(readable.toLowerCase())) {
        return readable;
      }
    }
    // Use primaryTopic as fallback if it's specific enough
    if (primaryTopic && primaryTopic.length > 4) return primaryTopic;
    return null;
  }

  /**
   * Convert a URL slug to title-cased readable text.
   * "seo-audit" → "SEO Audit"
   * "social_media_marketing" → "Social Media Marketing"
   */
  _slugToText(slug) {
    if (!slug) return '';
    // Strip file extension if present
    const clean = slug.replace(/\.[a-z]{2,4}$/i, '');
    return clean
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }
}

export default new MissingElementContextBuilder();
