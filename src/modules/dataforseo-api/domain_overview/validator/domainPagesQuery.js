import { createHash } from 'node:crypto';
import { DOMAIN_PAGES_QUERY as Q } from '../config.js';
import { createFilterParser, fail, has, oneString, parseIntegerParam } from './filterConditions.js';

/**
 * Pure input handling for the domain-pages section (?limit &offset &order_by &filters). Nothing here touches the network or MongoDB. Every
 * value is checked against the whitelists in config.js and rewritten into ONE canonical form, so nothing unexpected reaches a paid API and
 * the same question always produces the same cache key.
 *
 *  - Only live links are asked for (there is no status parameter).
 *  - `order_by` is ONE rule, "<field>,<asc|desc>". `filters` is the shared JSON grammar: up to 8 conditions joined with "and" (the page puts its
 *    tab's own status filters, and its always-on backlinks >= 1, in here too, so the limit counts them).
 *  - `offset` + `limit` may not pass the provider's 20,000 window.
 */

export function parseLimit(raw) {
  if (!has(raw)) return Q.defaultLimit;
  const n = parseIntegerParam('limit', raw, { min: 1, max: Math.max(...Q.limits) });
  if (!Q.limits.includes(n)) fail('limit', `limit must be one of ${Q.limits.join(', ')}`);
  return n;
}

export const parseOffset = (raw) => (has(raw) ? parseIntegerParam('offset', raw, { min: 0, max: Q.maxOffsetWindow }) : 0);

/** ?order_by=<field>,<asc|desc> -> the canonical "field,dir", or the default. */
export function parseOrderBy(raw) {
  if (!has(raw)) return Q.defaultOrderBy;
  const s = oneString('order_by', raw);
  const [field, dir, ...rest] = s.split(',');
  if (rest.length || !Q.orderFields.includes(field) || !['asc', 'desc'].includes(dir)) {
    fail('order_by', `order_by must be "<field>,<asc|desc>" with one of ${Q.orderFields.join(', ')}`);
  }
  return `${field},${dir}`;
}

export const parseFilters = createFilterParser({
  fields: Q.filterFields,
  maxConditions: Q.maxFilterConditions,
  patternMaxLength: Q.patternMaxLength,
});

/** Canonical filters -> the provider's `filters` value. */
export { toProviderFilters } from './filterConditions.js';

/** A short stable key for everything that changes the provider's answer — `internal_list_limit` included. The cache `variant` column is 200 characters. */
export function buildVariant({ limit, offset, orderBy, filters }) {
  const hash = createHash('sha1').update(JSON.stringify({ limit, offset, orderBy, filters, ilimit: Q.internalListLimit })).digest('hex').slice(0, 28);
  return `${Q.status}|l${limit}|o${offset}|${orderBy}|i${Q.internalListLimit}|${hash}`;
}

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ limit: number, offset: number, orderBy: string, filters: Array, variant: string, isDefault: boolean }}
 */
export function parseDomainPagesQuery(query = {}) {
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  if (offset + limit > Q.maxOffsetWindow) fail('offset', `offset + limit must be at most ${Q.maxOffsetWindow}`);
  const orderBy = parseOrderBy(query.order_by);
  const filters = parseFilters(query.filters);
  return {
    limit, offset, orderBy, filters,
    variant: buildVariant({ limit, offset, orderBy, filters }),
    isDefault: limit === Q.defaultLimit && offset === 0 && orderBy === Q.defaultOrderBy && filters.length === 0,
  };
}

export const DOMAIN_PAGES_PARAMS = Object.freeze(['limit', 'offset', 'order_by', 'filters']);
