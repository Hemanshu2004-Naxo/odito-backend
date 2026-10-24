/**
 * Citation URL normalization and target-domain matching. Provider-independent, pure.
 *
 * What is normalized (so the same page cited twice counts once as a page and twice as occurrences):
 *   scheme http/https -> https, host lower-cased (IDNs to punycode by the WHATWG URL parser), leading "www." removed,
 *   default ports removed, fragment removed, tracking parameters removed (the rest are kept and sorted), duplicate
 *   slashes collapsed, trailing slash removed (the root is represented with no path).
 * Anything that is not an absolute http(s) URL is rejected with a reason - it never throws.
 *
 * A host belongs to the target when it EQUALS the target host or is a real subdomain of it ("blog.example.com" for
 * "example.com"). It is never a substring test: "example.com.attacker.test" and "notexample.com" do not match.
 * "www." is ignored on both sides, so a target of "www.example.com" also matches "example.com".
 */

const TRACKING_PARAM_EXACT = new Set([
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'igshid', 'srsltid', 'ref_src',
]);

export function isTrackingParam(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAM_EXACT.has(n);
}

/** Lower-case host without a trailing dot and without a leading "www.". null when not a plausible hostname. */
export function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  let h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return null;
  if (h.startsWith('www.')) h = h.slice(4);
  return h || null;
}

/** Target host from the canonical host when known, otherwise from the main URL. null when neither parses. */
export function deriveTargetHost({ canonicalHost = null, canonicalUrl = null, mainUrl = null } = {}) {
  for (const candidate of [canonicalHost, canonicalUrl, mainUrl]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const raw = candidate.trim();
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = normalizeHost(url.hostname);
      if (host) return host;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** @returns {{ok:true,url:string,host:string,path:string,query:string}|{ok:false,reason:string}} */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'unsupported_scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  const host = normalizeHost(url.hostname);
  if (!host) return { ok: false, reason: 'no_host' };

  const kept = [];
  for (const [k, v] of url.searchParams) if (!isTrackingParam(k)) kept.push([k, v]);
  kept.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';

  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';

  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  return { ok: true, url: `https://${host}${port}${path}${query}`, host, path: path || '/', query };
}

/** True when `host` is the target host or a genuine subdomain of it. Never a substring comparison. */
export function isTargetHost(host, targetHost) {
  const h = normalizeHost(host);
  const t = normalizeHost(targetHost);
  if (!h || !t) return false;
  return h === t || h.endsWith(`.${t}`);
}

/**
 * Turn one provider annotation into a citation record, or null when it has no usable URL. Only the URL is relied on:
 * the provider's annotation `type` vocabulary is not verified, so it is carried through untouched but never used to
 * include or exclude an entry.
 * @returns {{url:string,normalizedUrl:string|null,host:string|null,title:string|null,isTarget:boolean,valid:boolean}|null}
 */
export function toCitation(annotation, targetHost) {
  if (!annotation || typeof annotation !== 'object') return null;
  const rawUrl = typeof annotation.url === 'string' ? annotation.url : null;
  if (!rawUrl) return null;
  const title = typeof annotation.title === 'string' ? annotation.title.slice(0, 300) : null;
  const n = normalizeUrl(rawUrl);
  if (!n.ok) return { url: rawUrl.slice(0, 2000), normalizedUrl: null, host: null, title, isTarget: false, valid: false };
  return { url: rawUrl.slice(0, 2000), normalizedUrl: n.url, host: n.host, title, isTarget: isTargetHost(n.host, targetHost), valid: true };
}

export function extractCitations(annotations, targetHost) {
  return (Array.isArray(annotations) ? annotations : []).map((a) => toCitation(a, targetHost)).filter(Boolean);
}

export default { normalizeUrl, normalizeHost, deriveTargetHost, isTargetHost, isTrackingParam, toCitation, extractCitations };
