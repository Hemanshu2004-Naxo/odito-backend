import { BaseResolver } from './BaseResolver.js';

/**
 * TechnicalResolver
 *
 * Handles technical SEO issues:
 *   canonical, redirects, robots.txt, crawlability, links,
 *   OG/Twitter tags, HTTP errors, URL structure, sitemaps.
 */
export class TechnicalResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const {
      pageData,
      issuesByCode,
      crawlData,
      technicalReport,
      visibilityData,
      outboundLinks,   // [{ url }]  — pages this page links TO  (CrawlGraphExtractor)
      inboundLinks,    // [{ sourceUrl }] — pages that link TO this page (CrawlGraphExtractor)
    } = extracted;

    const onPageIssue = issuesByCode?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? null;

    switch (issueId) {

      // ─── Canonical ────────────────────────────────────────────────────
      case 'canonical_tag_errors': {
        const pageUrl = pageData?.url || pageData?.page_url || '';
        // detectedFromDoc may be the canonical URL stored by the Python worker;
        // prefer it if it looks like a real URL, otherwise fall back to pageData.canonical
        const canonicalUrl = _isCanonicalUrl(detectedFromDoc)
          ? detectedFromDoc
          : (pageData?.canonical || '');
        const matchStatus = _canonicalMatchStatus(pageUrl, canonicalUrl);
        const rows = [{
          'Page URL':     pageUrl || 'Not detected',
          'Canonical URL': canonicalUrl || 'Not set',
          'Match Status': matchStatus,
        }];
        return {
          currentState: this._tableState(['Page URL', 'Canonical URL', 'Match Status'], rows),
          expectedState: this._expectedState('Canonical URL must self-reference the page URL'),
        };
      }

      // ─── Redirects ────────────────────────────────────────────────────
      case 'redirect_chains':
      case 'redirect_chains_crawlability': {
        const chain = crawlData?.redirect_chain || _toArray(detectedFromDoc);
        return {
          currentState: this._chainState(chain.map(String)),
          expectedState: this._expectedState('Maximum 1 redirect hop (A → B only)'),
        };
      }

      case 'redirect_loop': {
        const loop = crawlData?.redirect_loop || _toArray(detectedFromDoc);
        return {
          currentState: this._chainState([...loop.map(String), '(loops back)'].filter(Boolean)),
          expectedState: this._expectedState('No circular redirects'),
        };
      }

      case 'meta_refresh': {
        const tag = detectedFromDoc || pageData?.meta_refresh || '';
        return {
          currentState: this._codeState(
            `<meta http-equiv="refresh" content="${tag}">`,
            'html'
          ),
          expectedState: this._expectedState('Use server-side 301 redirect instead of meta refresh'),
        };
      }

      // ─── robots.txt ───────────────────────────────────────────────────
      case 'robots_txt_blocking':
      case 'robots_txt_non_blocking': {
        const rules = technicalReport?.robots_txt?.disallow_rules
          || _toArray(detectedFromDoc).join('\n')
          || 'Disallow rules not retrieved';
        const rulesStr = Array.isArray(rules) ? rules.join('\n') : String(rules);
        return {
          currentState: this._codeState(rulesStr, 'text'),
          expectedState: this._expectedState('robots.txt allows AI crawlers (Googlebot, GPTBot, Anthropic-AI, etc.)'),
        };
      }

      // ─── Sitemap ──────────────────────────────────────────────────────
      case 'xml_sitemap_exists_valid': {
        const sitemapStatus = technicalReport?.sitemap?.status || 'Not found';
        if (!technicalReport?.sitemap?.exists) {
          return {
            currentState: this._absentState('XML sitemap'),
            expectedState: this._expectedState('Valid XML sitemap at /sitemap.xml or declared in robots.txt'),
          };
        }
        return {
          currentState: this._textState(sitemapStatus, null, null, null),
          expectedState: this._expectedState('Valid, accessible XML sitemap'),
        };
      }

      // ─── Links ────────────────────────────────────────────────────────
      case 'broken_links': {
        // Prefer context.broken_links (structured list written by Python worker after fix),
        // then crawlData.broken_links (legacy crawl graph), then fall back to list display.
        const contextLinks = onPageIssue?.context?.broken_links;
        const rawBroken = (contextLinks?.length > 0) ? contextLinks
          : (crawlData?.broken_links?.length > 0) ? crawlData.broken_links
          : null;

        if (rawBroken?.length > 0) {
          const rows = rawBroken.map(l => ({
            'Broken URL': typeof l === 'object' ? (l.url || l.href || String(l)) : String(l),
            'Status':     typeof l === 'object' ? String(l.status_code || l.status || '4xx') : '4xx',
          }));
          return {
            currentState: this._tableState(['Broken URL', 'Status'], rows),
            expectedState: this._expectedState('All internal links return 200 HTTP status'),
          };
        }

        // Legacy fallback — pre-fix data has only a count string
        const legacy = _toArray(detectedFromDoc).map(l =>
          typeof l === 'object' ? `${l.url || l.href || String(l)} (${l.status_code || l.status || '4xx'})` : String(l)
        );
        return {
          currentState: this._listState(legacy),
          expectedState: this._expectedState('All internal links return 200 HTTP status'),
        };
      }

      case 'links_to_redirecting_urls': {
        const redirecting = crawlData?.redirecting_links || _toArray(detectedFromDoc);
        const items = redirecting.map(l =>
          typeof l === 'object' ? `${l.source || l.url || String(l)} → ${l.target || ''}` : String(l)
        );
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Internal links point directly to final destination URLs'),
        };
      }

      case 'rel_nofollow_internal': {
        const nofollow = crawlData?.nofollow_links || _toArray(detectedFromDoc);
        const items = nofollow.map(l =>
          typeof l === 'object' ? `${l.url || l.href || String(l)} (${l.anchor_text || ''})` : String(l)
        );
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Internal links do not use rel="nofollow"'),
        };
      }

      case 'orphan_pages': {
        // inboundLinks = pages that actually link TO this URL (from seo_internal_links).
        // crawlData.inboundLinks = numeric count computed by the crawl graph worker.
        const inboundCount = crawlData?.inboundLinks ?? 0;
        const linkerUrls = (inboundLinks || [])
          .map(l => l.sourceUrl).filter(Boolean).slice(0, 10);

        if (linkerUrls.length > 0) {
          // Page has inbound links — show them
          const state = this._listState(linkerUrls);
          state.inboundLinkCount = inboundCount;
          state.contextLabel = 'Pages Linking Here';
          return {
            currentState: state,
            expectedState: this._expectedState('Every page has at least one inbound internal link'),
          };
        }

        // Truly orphaned — derive potential linking pages from URL path hierarchy
        const pageUrl = crawlData?.url || pageData?.url || pageData?.page_url || '';
        const potentialLinkers = _urlPathAncestors(pageUrl);
        const state = this._listState(potentialLinkers);
        state.inboundLinkCount = 0;
        state.contextLabel = potentialLinkers.length > 0 ? 'Potential Linking Pages' : null;
        state.isOrphan = true;
        return {
          currentState: state,
          expectedState: this._expectedState('Every page has at least one inbound internal link'),
        };
      }

      case 'click_depth': {
        // crawlData.clickDepthFromHomepage = BFS depth written by crawl_graph_worker.
        // detectedFromDoc fallback for legacy issue documents.
        const depth = crawlData?.clickDepthFromHomepage
          ?? (typeof detectedFromDoc === 'number' ? detectedFromDoc : parseFloat(detectedFromDoc) || null);
        // Reconstruct the path chain from URL segments — the worker stores only the depth
        // integer, not the actual path. URL hierarchy is the best available proxy.
        const pageUrl = crawlData?.url || '';
        const chain = _urlPathChain(pageUrl);

        if (chain.length > 1) {
          // Override measurement so the UI shows the depth alongside the chain
          const state = this._chainState(chain);
          state.measurement = { value: depth, unit: 'clicks from homepage', threshold: 3 };
          return {
            currentState: state,
            expectedState: this._expectedState('Maximum 3 clicks from homepage to any page', null, 3, 'clicks'),
          };
        }
        // Fallback: depth only (homepage or unresolvable URL)
        return {
          currentState: this._metricState(depth, 'clicks from homepage', 3),
          expectedState: this._expectedState('Maximum 3 clicks from homepage to any page', null, 3, 'clicks'),
        };
      }

      case 'topic_clusters_internal_links': {
        // outboundLinks = pages this page links TO (from seo_internal_links after field-name fix).
        // visibilityData.links.internal_count = count from AI visibility worker (fallback).
        const linkedUrls = (outboundLinks || [])
          .map(l => l.url).filter(Boolean).slice(0, 10);
        const linkCount = linkedUrls.length > 0
          ? linkedUrls.length
          : (typeof detectedFromDoc === 'number'
              ? detectedFromDoc
              : (visibilityData?.links?.internal_count || null));

        if (linkedUrls.length > 0) {
          const state = this._listState(linkedUrls);
          state.measurement = { value: linkCount, unit: 'topical internal links', threshold: 5 };
          state.contextLabel = 'Current Internal Links';
          return {
            currentState: state,
            expectedState: this._expectedState('At least 5 topically related internal links per page', 5, null, 'links'),
          };
        }
        // No link data available — metric-only fallback
        return {
          currentState: this._metricState(linkCount, 'topical internal links', 5),
          expectedState: this._expectedState('At least 5 topically related internal links per page', 5, null, 'links'),
        };
      }

      // ─── HTTPS / Mixed Content ────────────────────────────────────────
      case 'https_not_enforced': {
        const httpUrls = pageData?.http_urls || _toArray(detectedFromDoc);
        return {
          currentState: this._listState(httpUrls.map(String)),
          expectedState: this._expectedState('All content served over HTTPS'),
        };
      }

      case 'mixed_http_https': {
        const mixed = pageData?.mixed_content_urls || _toArray(detectedFromDoc);
        return {
          currentState: this._listState(mixed.map(String)),
          expectedState: this._expectedState('All resources (images, scripts, CSS) loaded over HTTPS'),
        };
      }

      // ─── Blocked Resources ────────────────────────────────────────────
      case 'googlebot_js_rendering_blocked': {
        const blocked = technicalReport?.blocked_resources || _toArray(detectedFromDoc);
        return {
          currentState: this._listState(blocked.map(String)),
          expectedState: this._expectedState('JavaScript and CSS are not disallowed in robots.txt'),
        };
      }

      // ─── URL Issues ───────────────────────────────────────────────────
      case 'non_seo_friendly_urls': {
        const url = detectedFromDoc || pageData?.page_url || pageData?.url || '';
        return {
          currentState: this._textState(String(url), this._charLength(String(url)), 'characters', null),
          expectedState: this._expectedState('Clean URL without query parameters or special characters'),
        };
      }

      case 'double_slash_urls': {
        const url = detectedFromDoc || pageData?.page_url || '';
        return {
          currentState: this._textState(String(url), null, null, null),
          expectedState: this._expectedState('URL with no double slashes'),
        };
      }

      case 'long_urls': {
        const url = detectedFromDoc || pageData?.page_url || '';
        return {
          currentState: this._textState(String(url), this._charLength(String(url)), 'characters', 115),
          expectedState: this._expectedState('URL 115 characters or fewer', null, 115, 'characters'),
        };
      }

      // ─── Code/HTML Ratio ──────────────────────────────────────────────
      case 'low_code_to_html_ratio': {
        const ratio = typeof detectedFromDoc === 'number'
          ? detectedFromDoc
          : parseFloat(detectedFromDoc) || null;
        return {
          currentState: this._metricState(ratio, '% text content', 10),
          expectedState: this._expectedState('Text-to-code ratio above 10% — reduce code bloat'),
        };
      }

      // ─── OG / Social Tags ────────────────────────────────────────────
      case 'og_tags_missing': {
        return {
          currentState: this._absentState('Open Graph tags'),
          expectedState: this._expectedState('og:title, og:description, og:image, og:url, og:type all present'),
        };
      }

      case 'og_tags_incomplete': {
        // og_tags may be stored at root or nested under meta_tags.og
        const ogTags = pageData?.og_tags || pageData?.meta_tags?.og || {};
        // detectedFromDoc is the missing tag name or array of missing tag names from the Python worker
        const missingFromDoc = detectedFromDoc
          ? (Array.isArray(detectedFromDoc) ? detectedFromDoc.map(String) : [String(detectedFromDoc)])
          : [];
        const required = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
        const rows = required.map(tag => {
          const bareKey = tag.replace('og:', '');
          const value = ogTags[tag] || ogTags[bareKey] || null;
          // Mark as missing if: no value found in og_tags OR Python worker flagged it as missing
          const isMissing = !value || missingFromDoc.some(m => m === tag || m === bareKey);
          return {
            'Field':         tag,
            'Current Value': value || 'Missing',
            'Status':        isMissing ? '✗' : '✓',
          };
        });
        return {
          currentState: this._tableState(['Field', 'Current Value', 'Status'], rows),
          expectedState: this._expectedState('All required Open Graph properties present and non-empty'),
        };
      }

      case 'twitter_card_tags_missing': {
        return {
          currentState: this._absentState('Twitter Card meta tags'),
          expectedState: this._expectedState('twitter:card, twitter:title, twitter:description, twitter:image present'),
        };
      }

      // ─── HTTP Errors ──────────────────────────────────────────────────
      case '4xx_error_pages': {
        const pages = _toArray(detectedFromDoc);
        return {
          currentState: this._listState(pages.map(String)),
          expectedState: this._expectedState('No 4XX status pages — resolve or redirect'),
        };
      }

      case '5xx_server_error': {
        const pages = _toArray(detectedFromDoc);
        return {
          currentState: this._listState(pages.map(String)),
          expectedState: this._expectedState('No 5XX server errors'),
        };
      }

      case 'timeout_errors': {
        const pages = _toArray(detectedFromDoc);
        return {
          currentState: this._listState(pages.map(String)),
          expectedState: this._expectedState('All pages respond within 3 seconds'),
        };
      }

      case 'custom_404_page':
      case 'navigation_visibility': {
        return {
          currentState: this._absentState(
            issueId === 'custom_404_page' ? 'custom 404 page elements' : 'crawlable navigation'
          ),
          expectedState: this._expectedState(
            issueId === 'custom_404_page'
              ? 'Custom 404 page with navigation, search, and helpful links'
              : 'Navigation rendered in HTML accessible to crawlers'
          ),
        };
      }

      // ─── Technical Check IDs (from technicalChecks.service.js) ───────────
      // These use check.id values — note they differ from on-page issue codes.

      case 'security_headers': {
        const headers = pageData?.seo_intelligence?.security?.security_headers
          || pageData?.security_headers
          || {};
        const required = ['csp', 'hsts', 'x_frame_options', 'x_content_type_options'];
        const missing = required.filter(h => !headers[h]);
        if (missing.length === 0) {
          return {
            currentState: this._textState('All required security headers are present', null, null, null),
            expectedState: this._expectedState('CSP, HSTS, X-Frame-Options, X-Content-Type-Options all set'),
          };
        }
        return {
          currentState: this._listState(missing.map(h => `Missing: ${h.replace(/_/g, '-').toUpperCase()}`)),
          expectedState: this._expectedState('CSP, HSTS, X-Frame-Options, X-Content-Type-Options all present'),
        };
      }

      case 'canonical_tags': {
        const pageUrl = pageData?.url || pageData?.page_url || '';
        const canonical = pageData?.canonical || '';
        const rows = [{
          'Page URL':     pageUrl || 'Not detected',
          'Canonical URL': canonical || 'Not set',
          'Match Status': canonical ? (canonical === pageUrl ? 'Self-referencing ✓' : 'Points elsewhere') : 'Missing ✗',
        }];
        return {
          currentState: canonical
            ? this._tableState(['Page URL', 'Canonical URL', 'Match Status'], rows)
            : this._absentState('canonical tag'),
          expectedState: this._expectedState('Every page must have a self-referencing canonical tag'),
        };
      }

      case 'noindex_key_pages':
      case 'noindex_tags': {
        const noindex = pageData?.meta_tags?.noindex
          || pageData?.noindex
          || detectedFromDoc;
        const robotsMeta = pageData?.meta_tags?.robots || pageData?.robots_meta || '';
        const isNoindex = noindex === true || String(robotsMeta).toLowerCase().includes('noindex');
        return {
          currentState: this._listState([
            `robots meta: ${robotsMeta || 'Not set'}`,
            `noindex flag: ${isNoindex ? 'YES — page excluded from indexing' : 'Not set'}`,
          ]),
          expectedState: this._expectedState('Key pages must not carry noindex directive'),
        };
      }

      case 'social_tags':
      case 'og_social_tags': {
        const ogTags = pageData?.og_tags || pageData?.meta_tags?.og || pageData?.social?.open_graph || {};
        const required = ['og:title', 'og:description', 'og:image', 'og:url'];
        const missing = required.filter(tag => !ogTags[tag] && !ogTags[tag.replace('og:', '')]);
        if (missing.length === 0) {
          return {
            currentState: this._textState('Open Graph tags are present', null, null, null),
            expectedState: this._expectedState('og:title, og:description, og:image, og:url all set'),
          };
        }
        return {
          currentState: this._absentState(`Open Graph tags (missing: ${missing.join(', ')})`),
          expectedState: this._expectedState('og:title, og:description, og:image, og:url all set'),
        };
      }

      case 'ssl_certificate': {
        const sslStatus = technicalReport?.sslStatus ?? (technicalReport?.sslValid ? 'VALID' : null);
        const days = technicalReport?.sslDaysRemaining ?? null;
        const CONFIRMED_BROKEN = new Set([
          'EXPIRED_CERTIFICATE', 'HOSTNAME_MISMATCH', 'CERTIFICATE_CHAIN_ERROR',
          'INVALID_CERTIFICATE', 'NO_HTTPS'
        ]);
        const status = technicalReport?.sslMessage ? technicalReport.sslMessage
          : sslStatus === 'VALID' && days != null && days < 30 ? `Expires in ${days} days`
          : sslStatus === 'VALID' ? `Valid — ${days != null ? `${days} days remaining` : 'active'}`
          : CONFIRMED_BROKEN.has(sslStatus) ? 'Invalid or missing SSL certificate'
          : 'SSL certificate could not be verified on the last scan';
        return {
          currentState: this._textState(status, null, null, null),
          expectedState: this._expectedState('Valid SSL certificate with 30+ days remaining'),
        };
      }

      case 'xml_sitemap': {
        if (!technicalReport?.sitemap?.exists) {
          return {
            currentState: this._absentState('XML sitemap'),
            expectedState: this._expectedState('Valid XML sitemap at /sitemap.xml or declared in robots.txt'),
          };
        }
        return {
          currentState: this._textState(technicalReport?.sitemap?.status || 'Found', null, null, null),
          expectedState: this._expectedState('Valid, accessible XML sitemap with all key pages'),
        };
      }

      case 'robots_txt': {
        const rules = technicalReport?.robots_txt?.disallow_rules || [];
        const rulesStr = Array.isArray(rules) ? rules.join('\n') : String(rules || 'No disallow rules');
        return {
          currentState: this._codeState(rulesStr || '# robots.txt not detected', 'text'),
          expectedState: this._expectedState('robots.txt present and allows key pages and AI crawlers'),
        };
      }

      case 'mobile_friendliness': {
        const viewport = pageData?.meta_tags?.viewport || pageData?.viewport || '';
        const score = pageData?.mobile_score ?? null;
        const items = [
          viewport ? `viewport: ${viewport}` : 'viewport meta tag: Missing',
          score != null ? `mobile score: ${score}/100` : 'mobile score: Not available',
        ];
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Responsive viewport meta tag and mobile-optimised layout'),
        };
      }

      default: {
        return {
          currentState: this._textState(
            detectedFromDoc != null ? String(detectedFromDoc) : null,
            null, null, null
          ),
          expectedState: this._expectedState(onPageIssue?.expected_value || 'See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/**
 * Derives ancestor URLs for a given page URL by walking up the path hierarchy.
 * Used by orphan_pages to suggest pages that could add an inbound link.
 *
 * "/services/ai-visibility/pricing" → ["https://example.com/", "https://example.com/services/", "https://example.com/services/ai-visibility/"]
 */
function _urlPathAncestors(pageUrl) {
  if (!pageUrl) return [];
  try {
    const { origin, pathname } = new URL(pageUrl);
    const clean = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
    const segments = clean.split('/').filter(Boolean);
    if (segments.length === 0) return []; // IS the homepage
    const ancestors = [`${origin}/`];
    for (let i = 0; i < segments.length - 1; i++) {
      ancestors.push(`${origin}/${segments.slice(0, i + 1).join('/')}/`);
    }
    return ancestors;
  } catch {
    return [];
  }
}

/**
 * Builds a human-readable chain from homepage → current page by decomposing
 * the URL path segments. Used by click_depth to show the navigation path.
 *
 * "https://example.com/services/ai-visibility/pricing" →
 *   ["Homepage", "Services", "Ai Visibility", "Pricing"]
 */
function _urlPathChain(pageUrl) {
  if (!pageUrl) return [];
  try {
    const { pathname } = new URL(pageUrl);
    const clean = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
    const segments = clean.split('/').filter(Boolean);
    if (segments.length === 0) return []; // IS the homepage — no chain needed
    const chain = ['Homepage'];
    for (const seg of segments) {
      chain.push(
        seg
          .replace(/[-_]/g, ' ')
          .replace(/\.\w+$/, '')       // strip file extension
          .replace(/\b\w/g, c => c.toUpperCase())
      );
    }
    return chain;
  } catch {
    return [];
  }
}

/** Returns true if the value looks like an actual URL (not a diagnostic string). */
function _isCanonicalUrl(val) {
  return typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/'));
}

/**
 * Compares pageUrl vs canonicalUrl and returns a human-readable match status string.
 * Normalises trailing slashes before comparing so /page and /page/ are treated equally.
 */
function _canonicalMatchStatus(pageUrl, canonicalUrl) {
  if (!canonicalUrl) return 'Mismatch ✗ — no canonical tag';
  if (!pageUrl) return 'Unknown — page URL not detected';
  try {
    const page = new URL(pageUrl);
    const canon = new URL(canonicalUrl);
    if (page.hostname !== canon.hostname) return 'Mismatch ✗ — different domain';
    const normPage = page.pathname.replace(/\/$/, '') + page.search;
    const normCanon = canon.pathname.replace(/\/$/, '') + canon.search;
    if (normPage === normCanon) return 'Match ✓';
    if (page.pathname.replace(/\/$/, '') === canon.pathname.replace(/\/$/, '')) {
      return 'Mismatch ✗ — query string difference';
    }
    const pagePath = page.pathname;
    const canonPath = canon.pathname;
    if (
      pagePath.replace(/\/$/, '') === canonPath.replace(/\/$/, '') &&
      pagePath.endsWith('/') !== canonPath.endsWith('/')
    ) {
      return 'Mismatch ✗ — trailing slash difference';
    }
    return 'Mismatch ✗ — different path';
  } catch {
    return pageUrl === canonicalUrl ? 'Match ✓' : 'Mismatch ✗';
  }
}

export default new TechnicalResolver();
