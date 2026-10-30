import { PAGE_FLAGS } from '../config.js';
import { dofollowPercent } from './referringDomainMetrics.js';

/**
 * The values computed from a page's own numbers, in ONE place (the server): the normalised URL, the status group, the opportunity flags and the
 * suggested fix. PURE. The first three are computed when the provider's answer is parsed and cached with the row; the traffic-based flags are
 * applied when a response is built (see service/topPagesService.js), because traffic comes from a separate cache.
 * A missing input gives a missing result (null), never a guess.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export { dofollowPercent };

/**
 * The URL a page is known by, so the same page found as http / https / www / non-www / with or without a trailing slash is ONE page:
 * the host lowercased, the protocol and a leading "www." removed, a fragment dropped, the trailing slash of the path removed — the path
 * (case included) and the query are kept.
 *   "https://www.asgeyehospital.com/"      -> "asgeyehospital.com"
 *   "http://asgeyehospital.com/patna/"     -> "asgeyehospital.com/patna"
 *   "https://x.com/a/?page=2"              -> "x.com/a?page=2"
 * @param {unknown} raw
 * @returns {string|null} null for anything that is not text
 */
export function normalizePageUrl(raw) {
  if (typeof raw !== 'string') return null;
  const withoutProtocol = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!withoutProtocol) return null;
  const hostEnd = withoutProtocol.search(/[/?#]/);
  const host = (hostEnd === -1 ? withoutProtocol : withoutProtocol.slice(0, hostEnd)).toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const rest = (hostEnd === -1 ? '' : withoutProtocol.slice(hostEnd)).replace(/#.*$/, '');
  const q = rest.indexOf('?');
  const path = (q === -1 ? rest : rest.slice(0, q)).replace(/\/+$/, '');
  return `${host}${path}${q === -1 ? '' : rest.slice(q)}`;
}

/**
 * "ok" (2xx) | "redirect" (3xx) | "error" (4xx and 5xx, except 403) | "blocked" (403: the server refuses the crawler — shown as an error with its own
 * label, because the page usually works for visitors) | "unknown" (0, null, 1xx or anything that is not an HTTP status).
 */
export function getStatusGroup(statusCode) {
  const c = num(statusCode);
  if (c === null || !Number.isInteger(c)) return 'unknown';
  if (c === 403) return 'blocked';
  if (c >= 200 && c < 300) return 'ok';
  if (c >= 300 && c < 400) return 'redirect';
  if (c >= 400 && c < 600) return 'error';
  return 'unknown';
}

/**
 * What to do about a link whose target URL answers with an error. (The Backlinks page's Broken tab has its own copy of these four lines, in
 * the frontend; this one is what the Top Pages rows and CSV carry.)
 *   404 / 410 -> redirect it    403 -> a firewall / CDN / bot rule    5xx -> hosting    anything else -> look at it
 */
export function suggestFix(statusCode) {
  const code = num(statusCode);
  if (code === 404 || code === 410) return 'Add a 301 redirect to a relevant live page';
  if (code === 403) return 'Server/CDN is blocking access — check firewall or bot protection';
  if (code !== null && Number.isInteger(code) && code >= 500 && code <= 599) return 'Server error — check hosting';
  return 'Check this URL';
}

/** The ids of the flags, in the order they are shown. */
export const FLAG_IDS = Object.freeze(['wasted_links', 'redirected_links', 'links_no_traffic', 'traffic_few_links']);

/**
 * The opportunity flags that apply to a page. `traffic` is the page's estimated traffic: null when it is not known (the traffic join failed),
 * and then the two traffic-based flags are never raised — a missing figure is not a zero.
 * @param {{ statusGroup: string, backlinks: number|null, referringDomains: number|null, traffic: number|null }} page
 * @returns {string[]} flag ids
 */
export function getPageFlags({ statusGroup, backlinks, referringDomains, traffic }, t = PAGE_FLAGS) {
  const bl = num(backlinks);
  const rd = num(referringDomains);
  const tr = num(traffic);
  const flags = [];
  if ((statusGroup === 'error' || statusGroup === 'blocked') && bl !== null && bl >= t.wastedLinks.minBacklinks) flags.push('wasted_links');
  if (statusGroup === 'redirect' && rd !== null && rd >= t.redirected.minReferringDomains) flags.push('redirected_links');
  if (statusGroup === 'ok' && tr !== null && rd !== null && rd >= t.noTraffic.minReferringDomains && tr === 0) flags.push('links_no_traffic');
  if (statusGroup === 'ok' && tr !== null && rd !== null && tr >= t.fewLinks.minTraffic && rd < t.fewLinks.belowReferringDomains) flags.push('traffic_few_links');
  return flags;
}

/** Short names for the CSV (the page shows its own, longer, explanations). */
export const FLAG_LABELS = Object.freeze({
  wasted_links: 'Links point to a broken page',
  redirected_links: 'Links pass through a redirect',
  links_no_traffic: 'Strong links but no rankings',
  traffic_few_links: 'Ranks well with few links',
});

/**
 * Traffic per page from ranked keywords: every keyword's estimated traffic (etv) and count, summed per NORMALISED url.
 * @param {Array<{ url?: string|null, relative_url?: string|null, etv?: number|null }>} keywords
 * @param {string} target the project's domain (to build a URL from a relative one)
 * @returns {Record<string, { traffic: number, keywords: number }>}
 */
export function buildTrafficByUrl(keywords, target) {
  const byUrl = {};
  for (const k of Array.isArray(keywords) ? keywords : []) {
    const absolute = typeof k?.url === 'string' && k.url ? k.url : (typeof k?.relative_url === 'string' && k.relative_url.startsWith('/') ? `https://${target}${k.relative_url}` : null);
    const key = normalizePageUrl(absolute);
    if (!key) continue;
    const slot = byUrl[key] ?? (byUrl[key] = { traffic: 0, keywords: 0 });
    slot.traffic += num(k.etv) ?? 0;
    slot.keywords += 1;
  }
  for (const v of Object.values(byUrl)) v.traffic = Math.round(v.traffic * 100) / 100;
  return byUrl;
}
