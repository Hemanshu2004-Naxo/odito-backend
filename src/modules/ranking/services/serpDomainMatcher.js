/**
 * Centralised tracked-domain vs SERP-result-host matching. Whole DNS labels only - never substring tests, so
 * "example.com" does not match "fakeexample.com" or "example.com.fake.org". Hostname matching and registrable-domain
 * matching are separate, explicit policies.
 *
 * Policies (`policy`):
 *   'subdomains'  (default) the result host is the tracked host or one of its subdomains. www == non-www.
 *   'hostname'    the result host must equal the tracked host (still www == non-www).
 *   'registrable' the result shares the tracked host's registrable domain (blog.example.com ~ shop.example.com;
 *                 example.co.uk is NOT example.com - country domains are different registrable domains).
 * The tracked host is never matched by one of its PARENTS (tracked blog.example.com does not match example.com).
 */

import { parseTld, normalizeHostname } from './serpUrlResolver.js';

export const MATCH_POLICY = Object.freeze({ HOSTNAME: 'hostname', SUBDOMAINS: 'subdomains', REGISTRABLE: 'registrable' });
export const MATCH_TYPE = Object.freeze({ EXACT_HOSTNAME: 'exact_hostname', SUBDOMAIN: 'subdomain', REGISTRABLE_DOMAIN: 'registrable_domain' });

/** Any input form (URL, host:port, bare host, IDN) -> comparable ASCII host, or '' when unusable. */
export function toComparableHost(input) {
  if (typeof input !== 'string' || !input.trim()) return '';
  const raw = input.trim();
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname; // WHATWG: punycode, no default port
  } catch { return ''; }
  host = normalizeHostname(host);
  return host && host.includes('.') ? host : '';
}

const NO_MATCH = (trackedDomain, resultDomain) => ({ matched: false, matchType: null, trackedDomain, resultDomain });

export function matchSerpResultDomain({ trackedDomain, resultHostname, policy = MATCH_POLICY.SUBDOMAINS } = {}) {
  const tracked = toComparableHost(trackedDomain);
  const result = toComparableHost(resultHostname);
  if (!tracked || !result) return NO_MATCH(tracked || null, result || null);

  if (result === tracked) return { matched: true, matchType: MATCH_TYPE.EXACT_HOSTNAME, trackedDomain: tracked, resultDomain: result };
  if (policy === MATCH_POLICY.HOSTNAME) return NO_MATCH(tracked, result);

  if (result.endsWith(`.${tracked}`)) {
    return { matched: true, matchType: MATCH_TYPE.SUBDOMAIN, trackedDomain: tracked, resultDomain: result };
  }
  if (policy === MATCH_POLICY.REGISTRABLE) {
    const a = parseTld(tracked), b = parseTld(result);
    if (a.domain && a.domain === b.domain && !a.isIp) {
      return { matched: true, matchType: MATCH_TYPE.REGISTRABLE_DOMAIN, trackedDomain: tracked, resultDomain: result };
    }
  }
  return NO_MATCH(tracked, result);
}
