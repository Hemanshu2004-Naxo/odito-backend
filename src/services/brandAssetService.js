import axios from 'axios';
import * as cheerio from 'cheerio';
import SeoProject from '../modules/app_user/model/SeoProject.js';
import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import BusinessProfileMedia from '../modules/app_user/model/BusinessProfileMedia.js';

/**
 * Brand Asset Resolution Service
 *
 * Centralized "what logo should we show for this project" resolver, reused
 * across the platform (Dashboard, Project List, Google Business Profile,
 * Search Console, Analytics, Audit Reports, PDF Reports, Email Reports).
 * Always returns the same shape:
 *   { brandLogo, favicon, source, resolution, fallbackType }
 * so callers never need to know which tier the asset came from.
 *
 * Fallback hierarchy:
 *   1. Google Business Profile Media LOGO item (read live via
 *      BusinessProfileMedia.getPrimaryByCategory - already synced/cached by
 *      businessProfileMediaService.js, not re-fetched here)
 *   2. Website logo, extracted from the project's main_url (JSON-LD
 *      Organization/LocalBusiness `logo`, then `og:image`)
 *   3. Website favicon (<link rel="apple-touch-icon">, <link rel="icon">,
 *      <link rel="shortcut icon">, then /favicon.ico)
 *   4. null - caller renders generated initials
 *
 * Tiers 2/3 share one HTTP fetch of the site and are cached on
 * SeoProject.brand_assets (see the model) so repeat calls read from Mongo
 * instead of re-fetching the site - see resolveProjectBrandAssets()'s TTL.
 */

const FETCH_TIMEOUT_MS = 8000;
// Deliberately much shorter than FETCH_TIMEOUT_MS - this only HEADs a
// candidate URL to read its content-type, not download a page. A slow/dead
// candidate blocking for the full 8s (multiplied across several candidates,
// sequentially) is exactly what made resolution feel slow - see
// isLikelyImage()'s docstring and the parallelized validation below.
const VALIDATE_TIMEOUT_MS = 2500;
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9'
};

const WEBSITE_ASSETS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - logos/favicons rarely change

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Parses a `sizes="32x32"` attribute into a comparable pixel value. Returns 0 if absent/unparseable. */
function parseIconSize(sizesAttr) {
  if (!sizesAttr) return 0;
  const match = /(\d+)x(\d+)/i.exec(sizesAttr);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Confirms a candidate URL actually serves an image before the resolver
 * accepts it. Extracted URLs come from the site's own markup (JSON-LD
 * `logo`, og:image, <link> hrefs) and are frequently stale in practice -
 * redirected to a moved page, a 404 rendered as a 200 HTML error page, etc.
 * Without this check a dead link would be handed to the frontend as "the
 * resolved brand logo" and only caught client-side after a failed <img> load.
 *
 * Callers MUST run multiple candidates through this concurrently
 * (Promise.all), never in a sequential loop - each check is capped at
 * VALIDATE_TIMEOUT_MS, but N sequential awaits still sum to N * that
 * timeout in the worst case (a slow/unreachable candidate), which is what
 * made cold-cache resolution feel slow.
 */
async function isLikelyImage(url) {
  if (!url) return false;
  try {
    const res = await axios.head(url, { timeout: VALIDATE_TIMEOUT_MS, headers: REQUEST_HEADERS, maxRedirects: 5 });
    const contentType = res.headers['content-type'] || '';
    return contentType.toLowerCase().startsWith('image/');
  } catch {
    return false;
  }
}

/**
 * Website `logo` extraction: JSON-LD Organization/LocalBusiness schema
 * (highest confidence, mirrors the schema.org read already done by
 * SchemaResolver.js's logo_url_returns_200 diagnostic), then og:image.
 * Site markup is frequently stale (a `logo` URL pointing at a moved/deleted
 * asset is common) - each candidate is validated with isLikelyImage() before
 * being accepted, falling through to the next candidate rather than handing
 * the frontend a dead link.
 */
async function extractWebsiteLogo($, baseUrl) {
  let schemaLogoUrl = null;
  let ogImageUrl = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (schemaLogoUrl) return;
    try {
      const raw = $(el).html() || $(el).text();
      if (!raw || !raw.trim()) return;
      const data = JSON.parse(raw.trim());
      const schemas = Array.isArray(data) ? data : [data];

      for (const schema of schemas) {
        if (!schema || typeof schema !== 'object' || !schema.logo) continue;
        const logo = schema.logo;
        const candidate = typeof logo === 'string' ? logo : (logo.url || logo['@id']);
        if (candidate) {
          schemaLogoUrl = resolveUrl(candidate, baseUrl);
          break;
        }
      }
    } catch {}
  });

  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) ogImageUrl = resolveUrl(ogImage, baseUrl);

  // Validate both candidates concurrently rather than one-await-at-a-time -
  // schema:logo still wins on a tie (checked first below), but a dead
  // schema link no longer adds its own full timeout before og:image is
  // even attempted.
  const [schemaValid, ogValid] = await Promise.all([
    isLikelyImage(schemaLogoUrl),
    isLikelyImage(ogImageUrl)
  ]);

  if (schemaLogoUrl && schemaValid) {
    return { logoUrl: schemaLogoUrl, source: 'schema:logo' };
  }
  if (ogImageUrl && ogValid) {
    return { logoUrl: ogImageUrl, source: 'og:image' };
  }
  return { logoUrl: null, source: null };
}

/**
 * Website favicon extraction: every <link rel="icon" | "shortcut icon" |
 * "apple-touch-icon">, resolved to an absolute URL, highest declared
 * `sizes` wins (apple-touch-icon is the common largest, so it's preferred
 * on a size tie). Falls back to /favicon.ico if no <link> tag exists at all.
 */
async function extractWebsiteFavicon($, baseUrl) {
  const candidates = [];

  $('link[rel]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase().trim();
    if (!['icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'].includes(rel)) return;

    const href = $(el).attr('href');
    const absoluteUrl = resolveUrl(href, baseUrl);
    if (!absoluteUrl) return;

    candidates.push({
      url: absoluteUrl,
      size: parseIconSize($(el).attr('sizes')),
      isAppleTouch: rel.startsWith('apple-touch-icon'),
      source: rel.startsWith('apple-touch-icon') ? 'link:apple-touch-icon' : (rel === 'icon' ? 'link:icon' : 'link:shortcut-icon')
    });
  });

  // Validate every <link> candidate (plus the conventional /favicon.ico
  // fallback) concurrently in one round-trip, instead of a sequential loop
  // that pays each candidate's full timeout one after another. Pick the
  // highest-size candidate among whichever actually validated.
  const faviconIcoUrl = resolveUrl('/favicon.ico', baseUrl);
  const allCandidates = [
    ...candidates,
    { url: faviconIcoUrl, size: 0, isAppleTouch: false, source: 'favicon.ico' }
  ];

  const validityResults = await Promise.all(allCandidates.map((c) => isLikelyImage(c.url)));
  const validCandidates = allCandidates.filter((_, i) => validityResults[i]);

  if (validCandidates.length === 0) return { faviconUrl: null, source: null };

  validCandidates.sort((a, b) => (b.size - a.size) || (b.isAppleTouch - a.isAppleTouch));
  return { faviconUrl: validCandidates[0].url, source: validCandidates[0].source };
}

/**
 * Fetches a site once and extracts both the logo and favicon from the same
 * HTML - mirrors businessDiscoveryService.discoverBusinessFromUrl()'s
 * lightweight cheerio pattern exactly (no Python worker, always resolves,
 * never throws).
 *
 * @param {string} url
 * @returns {Promise<{ logoUrl, logoSource, faviconUrl, faviconSource }>}
 */
export async function extractWebsiteBrandAssets(url) {
  const EMPTY = { logoUrl: null, logoSource: null, faviconUrl: null, faviconSource: null };
  if (!url) return EMPTY;

  try {
    const normalizedUrl = normalizeUrl(url);
    const response = await axios.get(normalizedUrl, {
      timeout: FETCH_TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);
    const { logoUrl, source: logoSource } = await extractWebsiteLogo($, normalizedUrl);
    const { faviconUrl, source: faviconSource } = await extractWebsiteFavicon($, normalizedUrl);

    return { logoUrl, logoSource, faviconUrl, faviconSource };
  } catch (error) {
    console.error('[BRAND_ASSET] Failed to extract website brand assets for:', url, '-', error.message);
    return EMPTY;
  }
}

/**
 * The resolver. Always returns the same shape regardless of which tier the
 * asset came from - callers (UI, PDF, email) never need source-specific logic.
 *
 * @param {Object} project - SeoProject document (needs _id, main_url, brand_assets)
 * @param {Object} [options]
 * @param {boolean} [options.force] - bypass the website-assets cache and re-fetch
 * @returns {Promise<{ brandLogo: string|null, favicon: string|null, source: string, resolution: object|null, fallbackType: string }>}
 */
export async function resolveProjectBrandAssets(project, { force = false } = {}) {
  // Tier 1: Google Business Profile logo - live read, already synced/cached
  // by businessProfileMediaService.js. Never re-fetched here.
  const googleConnection = await GoogleConnection.findActiveConnection(project.user_id, project._id, 'business_profile');
  if (googleConnection?.service_type?.includes('business_profile')) {
    const byCategory = await BusinessProfileMedia.getPrimaryByCategory(project._id, ['LOGO']);
    const googleLogo = byCategory?.LOGO;
    if (googleLogo?.google_url || googleLogo?.thumbnail_url) {
      return {
        brandLogo: googleLogo.google_url || googleLogo.thumbnail_url,
        favicon: null,
        source: 'google_logo',
        resolution: googleLogo.width_px && googleLogo.height_px ? { width: googleLogo.width_px, height: googleLogo.height_px } : null,
        fallbackType: 'google_logo'
      };
    }
  }

  // Tiers 2/3: website logo / favicon, cached on the project doc.
  //
  // Stale-while-revalidate: a logo/favicon barely ever changes, so once we
  // have ANY cached result, an aged (>7d) cache is still almost certainly
  // correct - serve it immediately and refresh in the background rather
  // than making the caller wait on a live re-scrape + several image
  // validation round-trips. Only block synchronously when there is no
  // cache at all yet (first resolution for this project) or the caller
  // explicitly asked for a fresh result (`force`).
  let brandAssets = project.brand_assets;
  const hasCache = !!brandAssets?.resolved_at;
  const isStale = !hasCache || (Date.now() - new Date(brandAssets.resolved_at).getTime()) > WEBSITE_ASSETS_TTL_MS;

  async function refreshWebsiteAssets() {
    const extracted = await extractWebsiteBrandAssets(project.main_url);
    return SeoProject.updateBrandAssets(project._id, {
      website_logo_url: extracted.logoUrl,
      website_logo_source: extracted.logoSource,
      favicon_url: extracted.faviconUrl,
      favicon_source: extracted.faviconSource
    });
  }

  if (force || !hasCache) {
    const updated = await refreshWebsiteAssets();
    brandAssets = updated?.brand_assets;
  } else if (isStale) {
    // Fire-and-forget - do not block this response on it.
    refreshWebsiteAssets().catch((err) =>
      console.error('[BRAND_ASSET] Background website-assets refresh failed for project', project._id.toString(), '-', err.message)
    );
  }

  if (brandAssets?.website_logo_url) {
    return {
      brandLogo: brandAssets.website_logo_url,
      favicon: brandAssets.favicon_url || null,
      source: 'website_logo',
      resolution: null,
      fallbackType: 'website_logo'
    };
  }

  if (brandAssets?.favicon_url) {
    return {
      brandLogo: brandAssets.favicon_url,
      favicon: brandAssets.favicon_url,
      source: 'website_favicon',
      resolution: null,
      fallbackType: 'website_favicon'
    };
  }

  // Tier 4: nothing resolved - caller renders generated initials.
  return {
    brandLogo: null,
    favicon: null,
    source: 'initials',
    resolution: null,
    fallbackType: 'generated_initials'
  };
}

export default {
  extractWebsiteBrandAssets,
  resolveProjectBrandAssets
};
