import { createHash } from 'node:crypto';
import { ANCHORS_QUERY as Q } from '../config.js';
import { createFilterParser, fail, has, oneString, parseIntegerParam } from './filterConditions.js';

/**
 * Pure input handling for the anchors section (?status &limit &offset &order_by &filters). Nothing here touches the network or MongoDB.
 * Every value is checked against the whitelists in config.js and rewritten into ONE canonical form, so nothing unexpected reaches a paid
 * API and the same question always produces the same cache key.
 *
 *  - `order_by` is ONE rule, "<field>,<asc|desc>" (the page sorts by one column).
 *  - `filters` is the shared JSON grammar: up to 8 conditions joined with "and".
 *  - \`offset\` + \`limit\` may not pass the provider's 20,000 window.
 */

export function parseStatus(raw) {
  if (!has(raw)) return Q.defaultStatus;
  const s = oneString('status', raw);
  if (!Q.statuses.includes(s)) fail('status', `status must be one of ${Q.statuses.join(', ')}`);
  return s;
}

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

/**
 * A short stable key for everything that changes the provider's answer — `internal_list_limit` included, so a change of it can never be
 * answered from an entry computed with another value. The cache `variant` column is 200 characters.
 */
export function buildVariant({ status, limit, offset, orderBy, filters }) {
  const hash = createHash('sha1').update(JSON.stringify({ status, limit, offset, orderBy, filters, ilimit: Q.internalListLimit })).digest('hex').slice(0, 28);
  return `${status}|l${limit}|o${offset}|${orderBy}|i${Q.internalListLimit}|${hash}`;
}

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ status: string, limit: number, offset: number, orderBy: string, filters: Array, variant: string, isDefault: boolean }}
 */
export function parseAnchorsQuery(query = {}) {
  const status = parseStatus(query.status);
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  if (offset + limit > Q.maxOffsetWindow) fail('offset', `offset + limit must be at most ${Q.maxOffsetWindow}`);
  const orderBy = parseOrderBy(query.order_by);
  const filters = parseFilters(query.filters);
  return {
    status, limit, offset, orderBy, filters,
    variant: buildVariant({ status, limit, offset, orderBy, filters }),
    isDefault: status === Q.defaultStatus && limit === Q.defaultLimit && offset === 0 && orderBy === Q.defaultOrderBy && filters.length === 0,
  };
}

export const ANCHORS_PARAMS = Object.freeze(['status', 'limit', 'offset', 'order_by', 'filters']);
