import { ValidationFailure, normalizeDomainInput } from '../../dataforseo-api/shared/targetDomain.js';
import { COMPETITOR_SOURCES } from '../model/ProjectCompetitor.js';

/**
 * Pure input handling for My Competitors. Free text is trimmed, stripped of control characters and length-checked; a website is cleaned
 * with normalizeDomainInput ("https://www.Example.com/path/" -> "example.com") and rejected if it is not a public domain name.
 */

export const LIMITS = Object.freeze({ name: 120, address: 300, notes: 500, placeId: 200 });
const PLACE_ID = /^[A-Za-z0-9_-]+$/;

const bad = (field, message) => new ValidationFailure(field, message);
// eslint-disable-next-line no-control-regex
const clean = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Optional free text -> trimmed string, or null when absent / blank. Throws for a non-string or one over `max`. */
function text(body, key, field, max) {
  const raw = body[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(field, `${field} must be text.`);
  const value = clean(raw);
  if (value.length > max) throw bad(field, `${field} can have at most ${max} characters.`);
  return value || null;
}

function domain(body) {
  const raw = body.domain ?? body.website;
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  const value = normalizeDomainInput(typeof raw === 'string' ? raw : '');
  if (!value) throw bad('domain', `"${String(raw).slice(0, 60)}" is not a valid website. Enter a domain such as example.com.`);
  return value;
}

function placeId(body) {
  const raw = body.placeId;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > LIMITS.placeId || !PLACE_ID.test(raw)) throw bad('placeId', 'placeId is not valid.');
  return raw;
}

const isObject = (b) => b && typeof b === 'object' && !Array.isArray(b);

/**
 * POST body -> a new competitor. A name, a website, or both; with a website only, the name is the domain.
 * @returns {{ name: string, domain: string|null, address: string|null, place_id: string|null, source: string, notes: string|null }}
 */
export function parseCreateBody(body) {
  if (!isObject(body)) throw bad('body', 'Send the competitor as a JSON object.');
  const name = text(body, 'name', 'name', LIMITS.name);
  const site = domain(body);
  if (!name && !site) throw bad('name', 'Enter a name or a website for the competitor.');
  const source = body.source === undefined ? 'manual' : body.source;
  if (!COMPETITOR_SOURCES.includes(source)) throw bad('source', `source must be one of: ${COMPETITOR_SOURCES.join(', ')}.`);
  return {
    name: name ?? site,
    domain: site,
    address: text(body, 'address', 'address', LIMITS.address),
    place_id: placeId(body),
    source,
    notes: text(body, 'notes', 'notes', LIMITS.notes),
  };
}

const coordinate = (body, key, max) => {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw bad(key, `${key} is not a valid coordinate.`);
  return v;
};

/**
 * POST /my-competitors/discovered body -> a business found through the SEO list or Local Competitors. Unlike a manual add, it is MERGED into
 * an existing record when it is the same business (same place, or same website), never refused as a duplicate.
 * @returns {{ name: string, domain: string|null, address: string|null, place_id: string|null, lat: number|null, lng: number|null, source: 'seo'|'local' }}
 */
export function parseDiscoveredBody(body) {
  if (!isObject(body)) throw bad('body', 'Send the competitor as a JSON object.');
  const source = body.source;
  if (source !== 'seo' && source !== 'local') throw bad('source', 'source must be "seo" or "local".');
  const site = domain(body);
  const place = placeId(body);
  if (source === 'seo' && !site) throw bad('domain', 'A result from the SEO list needs a website.');
  if (source === 'local' && !place) throw bad('placeId', 'A result from Local Competitors needs its Google place id.');
  const name = text(body, 'name', 'name', LIMITS.name) ?? site;
  if (!name) throw bad('name', 'A name or a website is required.');
  const lat = coordinate(body, 'lat', 90); const lng = coordinate(body, 'lng', 180);
  if ((lat === null) !== (lng === null)) throw bad('lat', 'Send both lat and lng, or neither.');
  return { name, domain: site, address: text(body, 'address', 'address', LIMITS.address), place_id: place, lat, lng, source };
}

/**
 * PATCH body -> only the fields that were sent. `source` cannot change. A blank value clears an optional field; a name cannot be blank.
 * @returns {Record<string, string|null>}
 */
export function parseUpdateBody(body) {
  if (!isObject(body)) throw bad('body', 'Send the changes as a JSON object.');
  const patch = {};
  if ('name' in body) {
    const name = text(body, 'name', 'name', LIMITS.name);
    if (!name) throw bad('name', 'A competitor needs a name.');
    patch.name = name;
  }
  if ('domain' in body || 'website' in body) patch.domain = domain(body);
  if ('address' in body) patch.address = text(body, 'address', 'address', LIMITS.address);
  // The Google place is NOT editable here: it comes from a Local Competitors result (which also keeps the branches in step with it).
  if ('notes' in body) patch.notes = text(body, 'notes', 'notes', LIMITS.notes);
  if (Object.keys(patch).length === 0) throw bad('body', 'Nothing to change.');
  return patch;
}
