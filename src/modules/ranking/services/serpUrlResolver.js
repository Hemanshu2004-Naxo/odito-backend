/**
 * Centralised SERP result URL resolution. Pure and synchronous: it NEVER fetches anything, so there is no SSRF surface.
 * A Google redirect (https://google.com/goto?url=..., /url?q=...) is resolved only from the destination the URL itself
 * carries; if it carries none the result is "unresolved" - the title or a guessed domain is never substituted.
 *
 * Registrable-domain extraction uses `tldts` (bundles the Public Suffix List).
 */

import { parse as tldtsParse } from 'tldts';

// Private suffixes (github.io, blogspot.com ...) count as public suffixes: tenants of them are different sites.
const parseTld = (host) => tldtsParse(host, { allowPrivateDomains: true });

export const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'resolved', UNRESOLVED: 'unresolved', UNAVAILABLE: 'unavailable', INVALID: 'invalid', UNSUPPORTED: 'unsupported',
});
export const RESOLUTION_METHOD = Object.freeze({
  DIRECT: 'direct', REDIRECT_PARAMETER: 'redirect_parameter', PROVIDER_RESOLVED: 'provider_resolved', BREADCRUMB: 'breadcrumb',
});

export const MAX_REDIRECT_DEPTH = 3;
const MAX_URL_LENGTH = 4096;
const REDIRECT_PARAMS = ['url', 'q', 'u', 'dest', 'destination', 'continue', 'target', 'redirect', 'adurl'];
// Paths on a Google host that are redirectors (as opposed to a real Google page such as /maps or /travel).
const REDIRECT_PATHS = new Set(['/goto', '/url', '/aclk', '/pagead/aclk', '/imgres', '/amp/s']);

/** google.com, www.google.co.in, google.com.au ... (registrable label "google"; not "notgoogle.com"). */
export function isGoogleHost(hostname) {
  if (!hostname) return false;
  const t = parseTld(hostname);
  return !!t.domainWithoutSuffix && t.domainWithoutSuffix === 'google' && t.isIcann === true;
}

/** lowercase, no trailing dot, no leading "www." (a www / non-www pair compares equal everywhere). */
export { parseTld };
export function normalizeHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  return hostname.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

function isPrivateOrLocalHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // any IPv6 literal: never a search-result website
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return true; // IPv4 literals are rejected outright (loopback / private / link-local / metadata ranges and the rest)
  return /^\d+$/.test(h.split('.').pop()); // numeric last label = decimal/hex-ish IP forms
}

function result(originalUrl, status, extra = {}) {
  return {
    originalUrl, resolvedUrl: null, hostname: null, registrableDomain: null,
    resolutionStatus: status, resolutionMethod: null, resolutionError: null, ...extra,
  };
}

/** Parse + validate one absolute web URL. Returns { url } or { status, error }. */
function validateWebUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { status: RESOLUTION_STATUS.INVALID, error: 'malformed URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { status: RESOLUTION_STATUS.UNSUPPORTED, error: `unsupported protocol ${u.protocol}` };
  }
  if (u.username || u.password) return { status: RESOLUTION_STATUS.INVALID, error: 'credentials in URL' };
  const hostname = normalizeHostname(u.hostname);
  if (!hostname) return { status: RESOLUTION_STATUS.INVALID, error: 'empty hostname' };
  if (isPrivateOrLocalHost(hostname)) return { status: RESOLUTION_STATUS.INVALID, error: 'private, loopback or IP-literal host' };
  const tld = parseTld(hostname);
  if (!tld.domain || tld.isIp) return { status: RESOLUTION_STATUS.INVALID, error: 'host has no registrable domain' };
  return { url: u, hostname, registrableDomain: tld.domain };
}

function redirectDestination(u) {
  if (!isGoogleHost(normalizeHostname(u.hostname))) return { isRedirect: false };
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (!REDIRECT_PATHS.has(path)) return { isRedirect: false };
  for (const name of REDIRECT_PARAMS) {
    const v = u.searchParams.get(name); // URLSearchParams has already percent-decoded once
    if (v && /^[a-z][a-z0-9+.-]*:/i.test(v.trim())) return { isRedirect: true, destination: v.trim() };
  }
  return { isRedirect: true, destination: null };
}

/**
 * @param {string} rawUrl
 * @param {{ providerUrl?: string }} [opts] providerUrl: an alternative direct URL the provider supplied for the same item
 */
export function resolveSerpResultUrl(rawUrl, opts = {}) {
  const originalUrl = typeof rawUrl === 'string' ? rawUrl : (rawUrl ?? null);
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return result(originalUrl, RESOLUTION_STATUS.UNAVAILABLE, { resolutionError: 'no URL supplied' });
  if (rawUrl.length > MAX_URL_LENGTH) return result(originalUrl, RESOLUTION_STATUS.INVALID, { resolutionError: 'URL too long' });

  let current = rawUrl.trim();
  let hops = 0;
  for (;;) {
    const checked = validateWebUrlLoose(current);
    if (checked.status) return result(originalUrl, checked.status, { resolutionError: checked.error });
    const redirect = redirectDestination(checked.url);
    if (!redirect.isRedirect) {
      const v = validateWebUrl(current);
      if (v.status) return result(originalUrl, v.status, { resolutionError: v.error });
      return result(originalUrl, RESOLUTION_STATUS.RESOLVED, {
        resolvedUrl: v.url.href, hostname: v.hostname, registrableDomain: v.registrableDomain,
        resolutionMethod: hops === 0 ? RESOLUTION_METHOD.DIRECT : RESOLUTION_METHOD.REDIRECT_PARAMETER,
      });
    }
    if (!redirect.destination) break; // a Google redirect carrying no destination
    if (++hops > MAX_REDIRECT_DEPTH) {
      return result(originalUrl, RESOLUTION_STATUS.UNRESOLVED, { resolutionError: `redirect nesting deeper than ${MAX_REDIRECT_DEPTH}` });
    }
    current = redirect.destination;
  }

  // Redirect without a usable destination: only a provider-supplied direct URL may stand in for it.
  if (opts.providerUrl && opts.providerUrl !== rawUrl) {
    const v = validateWebUrl(opts.providerUrl);
    if (!v.status && !isGoogleHost(v.hostname)) {
      return result(originalUrl, RESOLUTION_STATUS.RESOLVED, {
        resolvedUrl: v.url.href, hostname: v.hostname, registrableDomain: v.registrableDomain,
        resolutionMethod: RESOLUTION_METHOD.PROVIDER_RESOLVED,
      });
    }
  }
  return result(originalUrl, RESOLUTION_STATUS.UNRESOLVED, { resolutionError: 'Google redirect URL carries no destination' });
}

// Redirect hops are validated for scheme/shape only; host safety is checked on the FINAL destination.
function validateWebUrlLoose(raw) {
  let u;
  try { u = new URL(raw); } catch { return { status: RESOLUTION_STATUS.INVALID, error: 'malformed URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { status: RESOLUTION_STATUS.UNSUPPORTED, error: `unsupported protocol ${u.protocol}` };
  }
  return { url: u };
}

/**
 * The host Google DISPLAYS for a result: the first segment of the SERP `breadcrumb` ("https://www.justdial.com › ... › Eye Hospitals").
 * This is a provider field showing the real site of a masked (google.com/goto) result; it is a host only (the path is truncated, so no URL
 * is ever rebuilt from it) and is validated like any other host. Titles and website names are never used here.
 */
export function hostFromBreadcrumb(breadcrumb) {
  if (typeof breadcrumb !== 'string') return null;
  const m = breadcrumb.trim().match(/^https?:\/\/([^\s/›»>]+)/i);
  if (!m) return null;
  const host = normalizeHostname(m[1].replace(/:\d+$/, ''));
  if (!host || isGoogleHost(host) || isPrivateOrLocalHost(host)) return null;
  const tld = parseTld(host);
  return tld.domain && !tld.isIp ? host : null;
}

/**
 * Resolve the website of one SERP item. Candidate order: item.url, then other URL-bearing fields. A bare
 * `item.domain` is used only when it is a real non-Google host and no URL resolved (provider_resolved, no URL).
 * Last, for a masked result (a Google redirect with no destination): the host the SERP displays in `breadcrumb`
 * (resolutionMethod 'breadcrumb', no resolvedUrl - the item keeps its original goto URL, flagged masked by callers).
 */
export function resolveSerpItem(item) {
  const urls = [item?.url, item?.original_url, item?.snippet_url, item?.link].filter((v) => typeof v === 'string' && v.trim());
  const primary = urls[0] ?? null;
  const alt = urls.find((u) => u !== primary && !isGoogleHost(normalizeHostname(safeHost(u))));
  const r = resolveSerpResultUrl(primary, { providerUrl: alt });
  if (r.resolutionStatus === RESOLUTION_STATUS.RESOLVED) return r;

  const d = typeof item?.domain === 'string' ? normalizeHostname(item.domain) : '';
  if (d && !isGoogleHost(d) && !isPrivateOrLocalHost(d)) {
    const tld = parseTld(d);
    if (tld.domain && !tld.isIp) {
      return { ...r, hostname: d, registrableDomain: tld.domain, resolutionStatus: RESOLUTION_STATUS.RESOLVED,
        resolutionMethod: RESOLUTION_METHOD.PROVIDER_RESOLVED, resolutionError: null };
    }
  }
  const b = hostFromBreadcrumb(item?.breadcrumb);
  if (b) {
    const tld = parseTld(b);
    return { ...r, hostname: b, registrableDomain: tld.domain, resolutionStatus: RESOLUTION_STATUS.RESOLVED,
      resolutionMethod: RESOLUTION_METHOD.BREADCRUMB, resolutionError: null };
  }
  return r;
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
