import { ValidationFailure, normalizeDomainInput } from '../../shared/targetDomain.js';
import { DOMAIN_LISTS } from '../config.js';

/**
 * Pure input handling for the project's disavow / reviewed lists. EVERY domain — one or many, added or removed — goes through the shared
 * normalizeDomainInput ("https://www.Example.com/path/" -> "example.com") and is rejected if it is not a public domain name; the result is
 * de-duplicated BEFORE anything is written. One bad domain rejects the whole change: nothing is half-saved.
 *
 * The body is one change to both lists:
 *   { disavowed: { add: [...], remove: [...] }, reviewed: { add: [...], remove: [...] } }   (every part optional, at least one entry overall)
 */

export const LISTS = Object.freeze(['disavowed', 'reviewed']);
const bad = (field, message, code) => new ValidationFailure(field, message, code);

function parseDomains(field, raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw bad(field, `${field} must be a list of domains.`);
  if (raw.length > DOMAIN_LISTS.maxPerChange) throw bad(field, `At most ${DOMAIN_LISTS.maxPerChange.toLocaleString('en-US')} domains can be changed at once.`);
  const out = [];
  for (const item of raw) {
    const clean = normalizeDomainInput(typeof item === 'string' ? item : '');
    if (!clean) throw bad(field, `"${String(item ?? '').slice(0, 60)}" is not a valid domain. Enter a domain such as example.com.`, 'INVALID_DOMAIN');
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * @param {unknown} body
 * @param {string|null} [ownDomain] the project's own domain: it can be neither disavowed nor reviewed
 * @returns {{ disavowed: { add: string[], remove: string[] }, reviewed: { add: string[], remove: string[] } }}
 */
export function parseDomainListChange(body, ownDomain = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body', 'Send the change as { disavowed: { add, remove }, reviewed: { add, remove } }.');
  const change = {};
  for (const list of LISTS) {
    const part = body[list];
    if (part !== undefined && (part === null || typeof part !== 'object' || Array.isArray(part))) throw bad(list, `${list} must be { add: [...], remove: [...] }.`);
    change[list] = { add: parseDomains(`${list}.add`, part?.add), remove: parseDomains(`${list}.remove`, part?.remove) };
  }
  const total = LISTS.reduce((n, l) => n + change[l].add.length + change[l].remove.length, 0);
  if (total === 0) throw bad('body', 'Provide at least one domain to add or remove.');
  if (ownDomain) {
    for (const list of LISTS) {
      if (change[list].add.includes(ownDomain)) throw bad(`${list}.add`, 'This is your own domain: it cannot be disavowed or marked as reviewed.', 'OWN_DOMAIN');
    }
  }
  // A domain cannot be disavowed and marked OK in the same change, and cannot be added and removed from one list at once.
  for (const d of change.disavowed.add) {
    if (change.reviewed.add.includes(d)) throw bad('body', `${d} cannot be disavowed and marked as OK at the same time.`, 'CONFLICTING_CHANGE');
  }
  for (const list of LISTS) {
    for (const d of change[list].add) {
      if (change[list].remove.includes(d)) throw bad('body', `${d} cannot be added and removed at the same time.`, 'CONFLICTING_CHANGE');
    }
  }
  return change;
}
