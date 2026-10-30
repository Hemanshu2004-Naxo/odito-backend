import net from 'node:net';

/**
 * Pieces every DataForSEO feature needs before it can call the provider: a validation error type and the rule for turning a
 * project's website URL into the `target` domain. Shared so no feature re-implements (and drifts from) the SSRF-safe rules.
 */

export class ValidationFailure extends Error {
  constructor(field, message, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationFailure';
    this.code = code;
    this.field = field;
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A host that looks like a public domain name: 2+ valid labels, not numeric, not localhost / .local / .internal, not an IP. */
function isPublicDomainName(host) {
  if (!host || host.startsWith('[') || net.isIP(host)) return false;
  const labels = host.split('.');
  return !(host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'));
}

/**
 * A domain the user typed or pasted -> the clean form DataForSEO takes: lowercase, no protocol, no "www.", no path / query / port /
 * trailing slash or dot. Returns null for anything that is not a public-looking domain name (IPs, localhost, single labels, other
 * protocols, credentials, spaces). Pure: nothing is fetched.
 *
 *   " https://www.Example.com/path/ "  ->  example.com
 */
export function normalizeDomainInput(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return isPublicDomainName(host) ? host : null;
}

/**
 * The DataForSEO `target` for a project: the hostname of its stored main_url, lowercased, without a
 * leading "www." or trailing dot. Rejects anything that is not a public-looking domain name (IP
 * addresses, localhost, single-label hosts) — the value is only ever sent to DataForSEO as a domain,
 * never fetched by Odito, so this adds no URL-fetching surface.
 *
 *   https://www.asgeyehospital.com/hospital/gangapur-road-nashik/  ->  asgeyehospital.com
 */
export function normalizeTargetDomain(mainUrl) {
  if (typeof mainUrl !== 'string' || !mainUrl.trim()) {
    throw new ValidationFailure('target', 'This project has no website URL', 'INVALID_TARGET');
  }
  const raw = mainUrl.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ValidationFailure('target', "The project's website URL is not valid", 'INVALID_TARGET');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationFailure('target', "The project's website URL must use http or https", 'INVALID_TARGET');
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || net.isIP(host)) {
    throw new ValidationFailure('target', 'Referring domains can only be checked for a domain name, not an IP address', 'INVALID_TARGET');
  }
  if (host.startsWith('www.')) host = host.slice(4);
  if (!isPublicDomainName(host)) {
    throw new ValidationFailure('target', "The project's website does not have a public domain name", 'INVALID_TARGET');
  }
  return host;
}
