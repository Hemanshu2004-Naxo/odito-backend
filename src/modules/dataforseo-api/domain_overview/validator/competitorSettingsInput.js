import { ValidationFailure, normalizeDomainInput } from '../../shared/targetDomain.js';
import { COMPETITORS_QUERY } from '../config.js';

/**
 * Pure input handling for the saved competitor lists. Every domain is cleaned with normalizeDomainInput
 * ("https://www.Example.com/path/" -> "example.com") and rejected if it is not a public domain name.
 */

const bad = (field, message) => new ValidationFailure(field, message);

/** One domain from a body field or URL segment -> the clean domain, or a 400. */
export function parseOneDomain(raw, field = 'domain') {
  const clean = normalizeDomainInput(typeof raw === 'string' ? raw : '');
  if (!clean) throw bad(field, `"${String(raw ?? '').slice(0, 60)}" is not a valid domain. Enter a domain such as example.com.`);
  return clean;
}

/** `{ domain }` -> [clean]. For the tracked list (one pin at a time). */
export function parseTrackedBody(body) {
  return [parseOneDomain(body?.domain)];
}

/** `{ domain }` or `{ domains: [...] }` -> clean, de-duplicated domains. For the exclude list (the modal can add several at once). */
export function parseExcludedBody(body) {
  const raw = Array.isArray(body?.domains) ? body.domains : body?.domain !== undefined ? [body.domain] : null;
  if (!raw || raw.length === 0) throw bad('domains', 'Provide the domain(s) to exclude.');
  if (raw.length > COMPETITORS_QUERY.maxExcludedDomains) {
    throw bad('domains', `At most ${COMPETITORS_QUERY.maxExcludedDomains.toLocaleString('en-US')} domains can be added at once.`);
  }
  return [...new Set(raw.map((d) => parseOneDomain(d, 'domains')))];
}
