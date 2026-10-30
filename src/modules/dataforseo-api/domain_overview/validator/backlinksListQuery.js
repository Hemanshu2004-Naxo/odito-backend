import { createHash } from 'node:crypto';
import { BACKLINKS_LIST_QUERY as Q } from '../config.js';
import { createFilterParser, fail, has, oneString, parseIntegerParam } from './filterConditions.js';

/**
 * Pure input handling for the backlinks-list section (?status &mode &limit &offset &token &order_by &filters). Nothing here touches the
 * network or MongoDB. Every value is checked against the whitelists in config.js and rewritten into ONE canonical form, so nothing
 * unexpected reaches a paid API and the same question always produces the same cache key.
 *
 *  - `order_by` is given once per rule: ?order_by=domain_from_rank,desc&order_by=first_seen,asc (at most 3, one per field).
 *  - `filters` is the same JSON grammar as the other paged sections (conditions joined with "and"; the Backlinks page puts its tab's own
 *    filter — is_new / is_broken — in here too, so the 8-condition limit counts it).
 *  - Paging: \`offset\` works while offset + limit <= 20,000. Past that the provider needs the previous response's \`search_after_token\`,
 *    sent as \`token\` with every other parameter identical; offset and token are never sent together.
 */

export function parseStatus(raw) {
  if (!has(raw)) return Q.defaultStatus;
  const s = oneString('status', raw);
  if (!Q.statuses.includes(s)) fail('status', `status must be one of ${Q.statuses.join(', ')}`);
  return s;
}

export function parseMode(raw) {
  if (!has(raw)) return Q.defaultMode;
  const s = oneString('mode', raw);
  if (!Q.modes.includes(s)) fail('mode', `mode must be one of ${Q.modes.join(', ')}`);
  return s;
}

export function parseLimit(raw) {
  if (!has(raw)) return Q.defaultLimit;
  const n = parseIntegerParam('limit', raw, { min: 1, max: Math.max(...Q.limits) });
  if (!Q.limits.includes(n)) fail('limit', `limit must be one of ${Q.limits.join(', ')}`);
  return n;
}

export const parseOffset = (raw) => (has(raw) ? parseIntegerParam('offset', raw, { min: 0, max: Q.maxOffsetWindow }) : 0);

export function parseToken(raw) {
  if (!has(raw)) return null;
  const s = oneString('token', raw);
  if (s.length > Q.tokenMaxLength || !/^[A-Za-z0-9+/=_\-.~]+$/.test(s)) fail('token', 'token is not a valid search_after_token');
  return s;
}

/** ?order_by=<field>,<asc|desc> (repeat for more rules) -> canonical ["field,dir", ...], or the default. */
export function parseOrderBy(raw) {
  if (!has(raw)) return [...Q.defaultOrderBy];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > Q.maxOrderRules) fail('order_by', `at most ${Q.maxOrderRules} sort rules can be used at once`);
  const seen = new Set();
  return list.map((r) => {
    if (typeof r !== 'string') fail('order_by', 'order_by must be "<field>,<asc|desc>"');
    const [field, dir, ...rest] = r.split(',');
    if (rest.length || !Q.orderFields.includes(field) || !['asc', 'desc'].includes(dir)) fail('order_by', 'order_by must be "<field>,<asc|desc>" with a sortable field');
    if (seen.has(field)) fail('order_by', `${field} is sorted twice`);
    seen.add(field);
    return `${field},${dir}`;
  });
}

export const parseFilters = createFilterParser({
  fields: Q.filterFields,
  maxConditions: Q.maxFilterConditions,
  patternMaxLength: Q.patternMaxLength,
});

/** Canonical filters -> the provider's \`filters\` value (a flat triple for one condition, "and"-joined for several), null for none. */
export { toProviderFilters } from './filterConditions.js';

/** A short stable key for everything that changes the provider's answer. The cache `variant` column is 200 characters. */
export function buildVariant({ status, mode, limit, offset, token, orderBy, filters }) {
  const hash = createHash('sha1').update(JSON.stringify({ status, mode, limit, offset, token, orderBy, filters })).digest('hex').slice(0, 28);
  return `${status}|${mode}|l${limit}|${token ? 'tok' : `o${offset}`}|${hash}`;
}

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ status: string, mode: string, limit: number, offset: number, token: string|null, orderBy: string[], filters: Array, variant: string, isDefault: boolean }}
 */
export function parseBacklinksListQuery(query = {}) {
  const status = parseStatus(query.status);
  const mode = parseMode(query.mode);
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  const token = parseToken(query.token);
  if (token && offset) fail('token', 'offset and token cannot be used together');
  // The provider's window: a deeper page must continue from the previous response's token.
  if (!token && offset + limit > Q.maxOffsetWindow) fail('offset', `offset + limit must be at most ${Q.maxOffsetWindow}; continue with the previous response's search_after_token`);
  const orderBy = parseOrderBy(query.order_by);
  const filters = parseFilters(query.filters);
  return {
    status, mode, limit, offset, token, orderBy, filters,
    variant: buildVariant({ status, mode, limit, offset, token, orderBy, filters }),
    isDefault: status === Q.defaultStatus && mode === Q.defaultMode && limit === Q.defaultLimit && offset === 0 && !token
      && orderBy.length === 1 && orderBy[0] === Q.defaultOrderBy[0] && filters.length === 0,
  };
}

export const BACKLINKS_LIST_PARAMS = Object.freeze(['status', 'mode', 'limit', 'offset', 'token', 'order_by', 'filters']);
