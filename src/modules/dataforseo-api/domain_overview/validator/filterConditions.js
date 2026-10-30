import { createHash } from 'node:crypto';
import { ValidationFailure } from '../../shared/targetDomain.js';

/**
 * The shared half of the paged sections' `filters` handling (ranked keywords, competitors). Nothing here touches the network or MongoDB.
 * The browser sends DataForSEO-shaped values; every one is checked against a section's whitelist and rewritten into ONE canonical form,
 * so (a) nothing unexpected reaches a paid API and (b) the same question always produces the same cache key.
 *
 * `filters` is a JSON array: one condition `[field, op, value]`, or several joined with "and":
 * `[[field, op, value], "and", [field, op, value]]`. Nesting is not supported, and neither is "or" — EXCEPT where a section opts in with
 * `orGroups: { fields, op, maxItems }`: one condition of the list may then be a group of 2..maxItems `like` conditions on those fields joined
 * with "or" (`[[f, "like", "%a%"], "or", [f, "like", "%b%"]]`) — the Domain Overview's Brand keywords. Every member counts toward
 * `maxConditions`. In the canonical form a group is `{ or: [triple, ...] }` (members sorted and de-duplicated; one left = a plain triple).
 *
 * A section's whitelist is `{ [field]: { ops, kind, ... } }` with kind = pattern | number | intents | true.
 */

export const fail = (field, message) => { throw new ValidationFailure(field, message); };
export const has = (raw) => raw !== undefined && raw !== null && raw !== '';
export const oneString = (field, raw) => {
  if (typeof raw !== 'string') fail(field, `${field} must be given once`);
  return raw;
};

/** @param {{ fields: Record<string, any>, maxConditions: number, patternMaxLength?: number, intents?: string[], lowercaseFields?: string[], maxLength?: number }} cfg */
export function createFilterParser({ fields, maxConditions, patternMaxLength = 100, intents = [], lowercaseFields = [], maxLength = 4000, orGroups = null }) {
  function checkValue(spec, op, value, field) {
    switch (spec.kind) {
      case 'pattern': {
        const ok = typeof value === 'string' && value.length >= 3 && value.length <= patternMaxLength + 2
          && value.startsWith('%') && value.endsWith('%') && !value.slice(1, -1).includes('%')
          // eslint-disable-next-line no-control-regex
          && value.slice(1, -1).trim() === value.slice(1, -1) && !/[\u0000-\u001f]/.test(value);
        if (!ok) fail('filters', `${field}: a "like" value must be %text% (at most ${patternMaxLength} characters)`);
        return value;
      }
      case 'domainOrPattern': {
        if (op === 'like' || op === 'not_like') return checkValue({ ...spec, kind: 'pattern' }, op, value, field);
        const ok = Array.isArray(value) && value.length > 0 && value.length <= (spec.maxItems ?? 100)
          && value.every((v) => typeof v === 'string' && v.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(v));
        if (!ok) fail('filters', `${field}: value must be a list of 1 to ${spec.maxItems ?? 100} lowercase domain names`);
        return [...new Set(value)].sort();
      }
      case 'patternOrText': {
        // "like" / "not_like" are contains patterns (%text%); anything else (the "=" operator) is the exact text — "" (no anchor text) included.
        if (op === 'like' || op === 'not_like') return checkValue({ ...spec, kind: 'pattern' }, op, value, field);
        // eslint-disable-next-line no-control-regex
        const ok = typeof value === 'string' && value.length <= (spec.maxLength ?? 300) && !/[\u0000-\u001f]/.test(value);
        if (!ok) fail('filters', `${field}: value must be text of at most ${spec.maxLength ?? 300} characters`);
        return value;
      }
      case 'number': {
        const ok = typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max
          && (!spec.integer || Number.isInteger(value));
        if (!ok) fail('filters', `${field}: value must be ${spec.integer ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}`);
        return value;
      }
      case 'intents': {
        const ok = Array.isArray(value) && value.length > 0 && value.length <= intents.length && value.every((v) => intents.includes(v));
        if (!ok) fail('filters', `${field}: value must be a list of ${intents.join(', ')}`);
        return [...new Set(value)].sort();
      }
      case 'true':
        if (value !== true) fail('filters', `${field}: value must be true`);
        return true;
      case 'bool':
        if (typeof value !== 'boolean') fail('filters', `${field}: value must be true or false`);
        return value;
      case 'date': {
        // YYYY-MM-DD, a real calendar day.
        // An impossible day (2025-13-40) makes toISOString() throw, so validity is checked first: a 400, never a 500.
        const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
        const ok = day !== null && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
        if (!ok) fail('filters', `${field}: value must be a date as YYYY-MM-DD`);
        return value;
      }
      case 'domain': {
        const ok = typeof value === 'string' && value.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value);
        if (!ok) fail('filters', `${field}: value must be a lowercase domain name`);
        return value;
      }
      case 'enumList': {
        // A list of short tokens: either a fixed set (`values`) or anything matching `itemPattern`; at most `maxItems`.
        const item = spec.itemPattern ?? /^[a-z0-9_-]{1,40}$/;
        const ok = Array.isArray(value) && value.length > 0 && value.length <= (spec.maxItems ?? 20)
          && value.every((v) => typeof v === 'string' && (spec.values ? spec.values.includes(v) : item.test(v)));
        if (!ok) fail('filters', `${field}: value must be a list of ${spec.values ? spec.values.join(', ') : 'valid values'}`);
        return [...new Set(value)].sort();
      }
      default:
        return fail('filters', `${field}: unsupported filter`);
    }
  }

  /** One `[field, op, value]` -> the same triple (value normalised), or a ValidationFailure. */
  function parseCondition(c) {
    if (!Array.isArray(c) || c.length !== 3 || typeof c[0] !== 'string' || typeof c[1] !== 'string') {
      fail('filters', 'each filter must be [field, operator, value]');
    }
    const [field, op, value] = c;
    const spec = Object.hasOwn(fields, field) ? fields[field] : null;
    if (!spec) fail('filters', `filtering by "${field}" is not supported`);
    if (!spec.ops.includes(op)) fail('filters', `${field}: operator "${op}" is not supported`);
    const checked = checkValue(spec, op, value, field);
    return [field, op, lowercaseFields.includes(field) ? checked.toLowerCase() : checked];
  }

  /** A group `[c1, "or", c2, ...]` -> `{ or: [...] }` (or the lone triple), or a ValidationFailure. Only where the section opted in. */
  function parseGroup(group) {
    if (!orGroups) fail('filters', 'each filter must be [field, operator, value]');
    const members = [];
    group.forEach((part, i) => {
      if (i % 2 === 0) members.push(part);
      else if (part !== 'or') fail('filters', 'conditions in a group must be joined with "or"');
    });
    if (group.length % 2 === 0 || members.length < 2) fail('filters', 'an "or" group needs at least two conditions');
    if (members.length > orGroups.maxItems) fail('filters', `an "or" group can hold at most ${orGroups.maxItems} conditions`);
    const triples = members.map((m) => {
      const c = parseCondition(m);
      if (!orGroups.fields.includes(c[0]) || c[1] !== orGroups.op) fail('filters', `an "or" group can only combine "${orGroups.op}" conditions on ${orGroups.fields.join(', ')}`);
      return JSON.stringify(c);
    });
    const unique = [...new Set(triples)].sort().map((t) => JSON.parse(t));
    return unique.length === 1 ? unique[0] : { or: unique };
  }

  const isGroup = (part) => Array.isArray(part) && Array.isArray(part[0]);

  /** The conditions of a `filters` value, in the order the browser sent them (shape checked, values not yet). */
  function splitConditions(raw) {
    if (!Array.isArray(raw) || raw.length === 0) fail('filters', 'filters must be a non-empty array');
    if (typeof raw[0] === 'string') return [raw]; // a single flat [field, op, value]
    const conditions = [];
    raw.forEach((part, i) => {
      if (i % 2 === 0) conditions.push(part);
      else if (part !== 'and') fail('filters', 'conditions must be joined with "and"');
    });
    if (raw.length % 2 === 0) fail('filters', 'filters must not end with "and"');
    return conditions;
  }

  /** ?filters=<json> -> canonical conditions (sorted, de-duplicated), or [] when absent. */
  return function parseFilters(raw) {
    if (!has(raw)) return [];
    const s = oneString('filters', raw);
    if (s.length > maxLength) fail('filters', 'filters is too long');
    let json;
    try { json = JSON.parse(s); } catch { return fail('filters', 'filters must be valid JSON'); }
    const conditions = splitConditions(json);
    // A group's members each count: the provider limits conditions, not list entries.
    const leaves = conditions.reduce((n, c) => n + (isGroup(c) ? c.filter((_, i) => i % 2 === 0).length : 1), 0);
    if (leaves > maxConditions) {
      fail('filters', `at most ${maxConditions} filter conditions can be applied at once (got ${leaves}); remove some filters`);
    }
    const parsed = conditions.map((c) => (isGroup(c) ? parseGroup(c) : parseCondition(c))).map((c) => JSON.stringify(c));
    return [...new Set(parsed)].sort().map((c) => JSON.parse(c));
  };
}

/** Canonical conditions -> DataForSEO's `filters` value: a flat triple for one condition, "and"-joined for several, null for none. */
export function toProviderFilters(conditions) {
  if (!conditions.length) return null;
  // A canonical "or" group becomes the provider's [c1, "or", c2, ...].
  const out = conditions.map((c) => (c && !Array.isArray(c) && Array.isArray(c.or) ? c.or.flatMap((m, i) => (i === 0 ? [m] : ['or', m])) : c));
  if (out.length === 1) return out[0];
  return out.flatMap((c, i) => (i === 0 ? [c] : ['and', c]));
}

/** A short stable fingerprint of canonical filters ("none" for no filters): cache-key material (the `variant` column is 200 chars). */
export const hashFilters = (filters) => (filters.length ? createHash('sha1').update(JSON.stringify(filters)).digest('hex').slice(0, 16) : 'none');

/** The same for any list of strings (the project's exclude list): order- and case-insensitive; "none" for an empty list. */
export function hashList(list) {
  if (!list?.length) return 'none';
  return createHash('sha1').update([...new Set(list.map((s) => String(s).toLowerCase()))].sort().join('\n')).digest('hex').slice(0, 16);
}

/** Shared by the paged sections: an integer query parameter within [min, max]. */
export function parseIntegerParam(field, raw, { min, max }) {
  const s = oneString(field, raw);
  if (!/^\d{1,5}$/.test(s)) fail(field, `${field} must be a whole number`);
  const n = Number(s);
  if (n < min || n > max) fail(field, `${field} must be between ${min} and ${max}`);
  return n;
}
