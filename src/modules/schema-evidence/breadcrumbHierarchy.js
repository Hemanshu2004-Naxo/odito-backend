/**
 * breadcrumbHierarchy — validation and deterministic generation for a breadcrumb trail the SITE
 * OWNER supplies (the crawl found no valid trail, and parent pages cannot be inferred).
 *
 * Nothing here talks to the network or the database. The server is the only authority: every value
 * the browser sends is re-validated here, and the "current page" URL is compared with the canonical
 * URL resolved from trusted crawl data, never with anything the client claims.
 *
 * Conservative normalisation: URLs are parsed with the WHATWG parser (lower-cased scheme/host,
 * default ports removed) and that is all. Paths are never decoded, re-cased or re-written,
 * query strings are kept intact, and a URL whose path the parser WOULD rewrite (dot segments, …) is
 * rejected instead of silently corrected. The only tolerance when COMPARING two URLs is a trailing
 * slash on the path.
 */

import crypto from 'crypto';
import { checkPublicWebsiteUrl } from '../../utils/publicWebsiteUrl.js';
import { sameSite } from './schemaGraph.js';

export const BREADCRUMB_LIMITS = Object.freeze({
  minItems: 2,
  maxItems: 10,
  maxNameLength: 120,
  maxUrlLength: 2048,
  maxPayloadChars: 24 * 1024,
});

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;

const err = (code, message, extra = {}) => ({ code, message, ...extra });

/** Comparison key: same URL if and only if scheme, host, port, path (ignoring ONE trailing slash) and query are equal. */
export function breadcrumbUrlKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
}

/** The raw path of an absolute URL exactly as typed (before any parser rewriting). */
function rawPathOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return m ? m[1] : null;
}

/**
 * Validates ONE user-typed URL. Returns { url } (the parser's absolute form) or { error }.
 */
export function validateBreadcrumbUrl(raw, { pageUrl } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: err('url_required', 'Page URL is required.') };
  const value = raw.trim();
  if (value.length > BREADCRUMB_LIMITS.maxUrlLength) return { error: err('url_too_long', `URL is longer than ${BREADCRUMB_LIMITS.maxUrlLength} characters.`) };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return { error: err('url_invalid', 'Enter a full URL starting with https:// (relative paths are not accepted).') };
  if (!/^https?:\/\//i.test(value)) return { error: err('url_scheme_unsupported', 'Only http:// and https:// URLs are supported.') };
  if (CONTROL_CHARS.test(value) || /\s/.test(value) || /[<>"\\`]/.test(value)) return { error: err('url_invalid', 'URL contains spaces, control characters or characters that are not allowed in a URL.') };

  let parsed;
  try { parsed = new URL(value); } catch { return { error: err('url_invalid', 'This is not a valid URL.') }; }
  if (parsed.username || parsed.password) return { error: err('url_credentials', 'URLs must not contain a username or password.') };
  if (parsed.hash) return { error: err('url_fragment', 'Remove the #fragment — a breadcrumb URL must point to the page itself.') };

  const host = checkPublicWebsiteUrl(parsed.href, { allowPublicIp: true, allowCustomPorts: true });
  if (!host.ok) return { error: err('url_host_invalid', 'This host is not allowed. Use the public address of your website.') };

  const typedPath = rawPathOf(value);
  if (typedPath !== null && typedPath !== '' && typedPath !== parsed.pathname) {
    return { error: err('url_path_rewritten', 'This URL contains path segments (such as "/./" or "/../") that browsers rewrite. Enter the exact, final URL of the page.') };
  }
  if (pageUrl && !sameSite(parsed.href, pageUrl)) {
    return { error: err('url_cross_site', 'Breadcrumb pages must be on the same website as the page being audited.') };
  }
  // HTTPS by default: a site served over https publishes https breadcrumb URLs. (An http-only site, the one narrow exception, keeps http.)
  if (pageUrl && /^https:/i.test(pageUrl) && parsed.protocol === 'http:') {
    return { error: err('url_not_https', 'This site is served over https, so use the https:// address of this page.') };
  }
  return { url: parsed.href };
}

/**
 * @param {object} input        the untrusted request value: { items: [{ name, url, position? }] }
 * @param {object} ctx          trusted, server-resolved: { canonicalUrl, canonicalTrusted, pageUrl }
 * @returns {{ ok: boolean, errors: object[], warnings: object[], items: {position:number,name:string,url:string}[], currentPage: {url:string, source:string}|null }}
 */
export function validateBreadcrumbHierarchy(input, { canonicalUrl = null, canonicalTrusted = false, pageUrl = null } = {}) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, items: [], currentPage: null });

  const list = input && typeof input === 'object' && !Array.isArray(input) ? input.items : null;
  if (!Array.isArray(list)) { errors.push(err('items_required', 'A list of breadcrumb items is required.')); return fail(); }
  if (list.length > BREADCRUMB_LIMITS.maxItems) { errors.push(err('too_many_items', `A breadcrumb trail can have at most ${BREADCRUMB_LIMITS.maxItems} items.`)); return fail(); }
  if (list.length < BREADCRUMB_LIMITS.minItems) { errors.push(err('too_few_items', 'Add at least two items: a parent page and the current page.')); return fail(); }

  let payloadChars = 0;
  for (const it of list) { try { payloadChars += JSON.stringify(it ?? null).length; } catch { payloadChars += BREADCRUMB_LIMITS.maxPayloadChars; } }
  if (payloadChars > BREADCRUMB_LIMITS.maxPayloadChars) { errors.push(err('payload_too_large', 'The submitted hierarchy is too large.')); return fail(); }

  const items = [];
  const seenPositions = new Set();

  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(err('invalid_item', 'This item is not valid.', { index })); return; }

    // name
    const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) errors.push(err('name_required', 'Page name is required.', { index, field: 'name' }));
    else if (name.length > BREADCRUMB_LIMITS.maxNameLength) errors.push(err('name_too_long', `Page name must be ${BREADCRUMB_LIMITS.maxNameLength} characters or fewer.`, { index, field: 'name' }));
    else if (CONTROL_CHARS.test(name)) errors.push(err('name_invalid', 'Page name contains characters that are not allowed.', { index, field: 'name' }));

    // url
    const checked = validateBreadcrumbUrl(raw.url, { pageUrl: canonicalUrl || pageUrl });
    if (checked.error) errors.push({ ...checked.error, index, field: 'url' });

    // position: generated from the order. A client that sends one must agree with it.
    if (raw.position !== undefined && raw.position !== null) {
      const p = raw.position;
      if (!Number.isInteger(p)) errors.push(err('position_not_consecutive', 'Positions must be whole numbers 1, 2, 3, …', { index, field: 'position' }));
      else if (seenPositions.has(p)) errors.push(err('position_duplicate', `Position ${p} is used more than once.`, { index, field: 'position' }));
      else if (p !== index + 1) errors.push(err('position_not_consecutive', `Position must be ${index + 1} (positions run 1, 2, 3, … in order).`, { index, field: 'position' }));
      if (Number.isInteger(p)) seenPositions.add(p);
    }

    if (name && !checked.error) items.push({ position: index + 1, name, url: checked.url });
    else items.push(null);
  });

  // Duplicate URLs, including ones only the trailing slash distinguishes.
  const firstSeen = new Map();
  items.forEach((it, index) => {
    if (!it) return;
    const key = breadcrumbUrlKey(it.url);
    if (firstSeen.has(key)) errors.push(err('duplicate_url', `This URL is the same page as item ${firstSeen.get(key) + 1}.`, { index, field: 'url' }));
    else firstSeen.set(key, index);
  });

  // The LAST item is the page being audited and must be the server-verified canonical URL.
  const last = items[items.length - 1];
  const lastIndex = list.length - 1;
  let currentPage = null;
  if (last) {
    const lastKey = breadcrumbUrlKey(last.url);
    if (canonicalUrl && canonicalTrusted) {
      if (lastKey !== breadcrumbUrlKey(canonicalUrl)) {
        errors.push(err('final_url_mismatch', `The last item must be the page being audited. Its canonical URL is ${canonicalUrl}, but you entered ${last.url}. Correct the last URL (Odito does not rewrite it).`, { index: lastIndex, field: 'url', expectedUrl: canonicalUrl }));
      } else currentPage = { url: last.url, source: 'canonical_tag' };
    } else if (pageUrl) {
      // No verified canonical for this page: the owner must supply/confirm the current URL, and it must still be THIS page.
      if (lastKey !== breadcrumbUrlKey(pageUrl)) {
        errors.push(err('final_url_mismatch', `The last item must be the page being audited (${pageUrl}), but you entered ${last.url}. This page has no canonical tag, so please confirm its exact URL.`, { index: lastIndex, field: 'url', expectedUrl: pageUrl }));
      } else {
        currentPage = { url: last.url, source: 'user_confirmed' };
        warnings.push(err('canonical_unverified', 'This page has no verified canonical URL; the current page URL was confirmed by you, not verified from the site.'));
      }
    } else {
      errors.push(err('canonical_unavailable', 'The audited page URL is unknown, so the last item cannot be verified.', { index: lastIndex, field: 'url' }));
    }
  }

  if (errors.length) return fail();
  return { ok: true, errors, warnings, items: items.filter(Boolean), currentPage };
}

/** Deterministic BreadcrumbList from already-validated items. Never reads anything but its argument. */
export function generateBreadcrumbListJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}

/**
 * JSON for a <script type="application/ld+json"> element. `<`, `>` and `&` (and the two JS line
 * separators) are written as \u escapes — identical JSON, but a page name such as
 * "</script><script>…" can no longer terminate the tag when the code is pasted into a page.
 */
export function serializeJsonLdForScript(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Stable representation of the evidence: same names + URLs in the same order -> same hash. */
export function breadcrumbEvidenceHash(items) {
  const material = JSON.stringify((items || []).map((i) => [i.position, i.name, i.url]));
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}

/** Do two trails describe the same page sequence? (URLs, ignoring only a trailing slash) */
export function sameTrail(a, b) {
  const ka = (a || []).map((i) => breadcrumbUrlKey(i.url));
  const kb = (b || []).map((i) => breadcrumbUrlKey(i.url));
  return ka.length === kb.length && ka.every((k, i) => k && k === kb[i]);
}

export default {
  BREADCRUMB_LIMITS, breadcrumbUrlKey, validateBreadcrumbUrl, validateBreadcrumbHierarchy,
  generateBreadcrumbListJsonLd, serializeJsonLdForScript, breadcrumbEvidenceHash, sameTrail,
};
