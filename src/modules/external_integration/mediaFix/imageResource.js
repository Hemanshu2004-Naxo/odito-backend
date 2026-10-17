/**
 * imageResource — what KIND of resource an observed image URL is. Pure (no I/O). Mirror of the crawler's
 * python_workers/scraper/shared/image_classifier.py; both are tested against the SAME fixture
 * (python_workers/scraper/shared/fixtures/image_resource_cases.json) so the two cannot drift.
 *
 * Why the backend has its own copy: findings persisted BEFORE the crawler learned to classify still exist until the page is next
 * analysed. This module lets the fix workflow recognise them on its own, name the real reason an image cannot be edited through the
 * media library, and never offer the write path for something that is not a media-library file.
 *
 * Evidence is the URL itself (and declared dimensions when given). A tracking endpoint needs host AND path: facebook.com/tr is a pixel,
 * any other facebook.com address is an ordinary external image. Nothing is guessed from file names.
 */

export const KIND = Object.freeze({
  TRACKING: 'tracking_endpoint',
  DATA_URL: 'data_url',
  WP_MEDIA: 'wp_media',
  THEME_ASSET: 'theme_asset',
  PLUGIN_ASSET: 'plugin_asset',
  CORE_ASSET: 'core_asset',
  EXTERNAL: 'external_image',
  CONTENT: 'content_image',
});

// [host, path pattern]: the host matches itself and any subdomain; the path is part of the evidence.
const TRACKING_ENDPOINTS = [
  ['facebook.com', /^\/tr\/?$/i],
  ['ads.linkedin.com', /^\/collect/i],
  ['doubleclick.net', /^\/(pagead|activity|ddm)\/|^\/(r\/)?collect/i],
  ['googleadservices.com', /^\/pagead\//i],
  ['google.com', /^\/(pagead\/|ads\/ga-audiences)/i],
  ['google-analytics.com', /^\/(r\/|j\/|g\/)?collect|^\/__utm\.gif/i],
  ['analytics.twitter.com', /^\/i\/adsct/i],
  ['t.co', /^\/i\/adsct/i],
  ['bat.bing.com', /^\/action\//i],
  ['ct.pinterest.com', /^\/v3\//i],
  ['analytics.tiktok.com', /^\/api\/v2\/pixel/i],
  ['tr.snapchat.com', /^\/(p|tr)/i],
  ['q.quora.com', /^\/_\/ad\//i],
];

const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

function parts(url, base) {
  try {
    const u = new URL(String(url), base || 'https://invalid.example');
    return { host: bareHost(u.hostname), path: u.pathname || '', hasHost: !!u.hostname && !(!base && u.hostname === 'invalid.example') };
  } catch { return { host: '', path: '', hasHost: false }; }
}

export function isTrackingEndpoint(url, pageUrl) {
  const { host, path, hasHost } = parts(url, pageUrl);
  if (!hasHost) return false;
  return TRACKING_ENDPOINTS.some(([h, rx]) => (host === h || host.endsWith(`.${h}`)) && rx.test(path));
}

const declaredPx = (v) => { const m = v == null ? null : /^\s*(\d+)\s*(?:px)?\s*$/.exec(String(v)); return m ? Number(m[1]) : null; };

export function hasPixelDimensions(width, height) {
  const w = declaredPx(width); const h = declaredPx(height);
  return w !== null && h !== null && w <= 1 && h <= 1;
}

/** @returns {{ kind: string, actionable: boolean }} `actionable` is false only for a tracking endpoint. */
export function classifyImageUrl(src, { pageUrl = null, width = null, height = null, lazySrc = null } = {}) {
  let url = String(src || '').trim();
  if (url.startsWith('data:') && lazySrc && !String(lazySrc).startsWith('data:')) url = String(lazySrc).trim();
  const done = (kind) => ({ kind, actionable: kind !== KIND.TRACKING });

  if (url.startsWith('data:')) return done(KIND.DATA_URL);
  if (isTrackingEndpoint(url, pageUrl)) return done(KIND.TRACKING);
  if (hasPixelDimensions(width, height)) return done(KIND.TRACKING);

  const { host, path } = parts(url, pageUrl);
  const lowered = path.toLowerCase();
  if (lowered.includes('/wp-content/uploads/')) return done(KIND.WP_MEDIA);
  if (lowered.includes('/wp-content/themes/')) return done(KIND.THEME_ASSET);
  if (lowered.includes('/wp-content/plugins/')) return done(KIND.PLUGIN_ASSET);
  if (lowered.includes('/wp-includes/')) return done(KIND.CORE_ASSET);

  const pageHost = pageUrl ? parts(pageUrl).host : '';
  if (host && pageHost && host !== pageHost) return done(KIND.EXTERNAL);
  return done(KIND.CONTENT);
}

/** Classify a finding's before_snapshot. Uses the crawler's own verdict when it recorded one, but never trusts it to CLEAR a tracker. */
export function classifySnapshot(snapshot, pageUrl) {
  const own = classifyImageUrl(snapshot?.src || snapshot?.imageUrl, { pageUrl, lazySrc: snapshot?.lazySrc });
  if (!own.actionable) return own;
  const recorded = Object.values(KIND).includes(snapshot?.resourceKind) ? snapshot.resourceKind : null;
  return recorded ? { kind: recorded, actionable: recorded !== KIND.TRACKING } : own;
}

/**
 * The reason an image of this kind cannot be changed in the WordPress media library, in words for the person — or null when the kind
 * could be a media-library file. Never repeats the URL or any identifier from it.
 */
export const UNSUPPORTED_REASON = Object.freeze({
  [KIND.TRACKING]: { code: 'TRACKING_ENDPOINT', message: 'This address is an analytics or advertising tracker, not a picture on your site. It has no alt text to write, and the next analysis stops reporting it.' },
  [KIND.THEME_ASSET]: { code: 'THEME_ASSET', message: 'This image is a file of your WordPress theme, not a media-library upload, so it has no media-library alt text to change. Its alt text lives in the theme or page-builder template.' },
  [KIND.PLUGIN_ASSET]: { code: 'PLUGIN_ASSET', message: 'This image is a file of a WordPress plugin, not a media-library upload, so it has no media-library alt text to change. Its alt text is set by the plugin.' },
  [KIND.CORE_ASSET]: { code: 'CORE_ASSET', message: 'This image is a WordPress core file, not a media-library upload, so it has no media-library alt text to change.' },
  [KIND.EXTERNAL]: { code: 'EXTERNAL_IMAGE', message: "This image is served by another website. Odito cannot change another site's image through your WordPress media library; its alt text has to be set where the image is placed on your page." },
  [KIND.DATA_URL]: { code: 'DATA_URL_IMAGE', message: 'This image is embedded in the page as inline data rather than a file, so it has no media-library entry. Its alt text has to be set in the page markup.' },
});

export default { KIND, classifyImageUrl, classifySnapshot, isTrackingEndpoint, hasPixelDimensions, UNSUPPORTED_REASON };
