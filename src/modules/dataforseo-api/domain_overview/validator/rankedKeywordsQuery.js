import { RANKED_KEYWORDS_LIMIT, RANKED_KEYWORDS_QUERY as Q } from '../config.js';
import {
  createFilterParser, fail, has, hashFilters, oneString, parseIntegerParam, toProviderFilters as toProviderFiltersShared,
} from './filterConditions.js';

/**
 * Pure input handling for the ranked-keywords section's paging / sorting / filtering (?limit &offset &order_by &filters).
 * Nothing here touches the network or MongoDB. The browser sends DataForSEO-shaped values; every one is checked against the
 * whitelists in config.js and rewritten into ONE canonical form, so (a) nothing unexpected reaches a paid API and (b) the same
 * question always produces the same cache key whatever order the browser listed its conditions in.
 *
 * The `filters` grammar (a condition, or conditions joined with "and") is shared with the competitors section: see filterConditions.js.
 */

export function parseLimit(raw) {
  if (!has(raw)) return RANKED_KEYWORDS_LIMIT;
  const n = parseIntegerParam('limit', raw, { min: 1, max: Math.max(...Q.limits) });
  if (!Q.limits.includes(n)) fail('limit', `limit must be one of ${Q.limits.join(', ')}`);
  return n;
}

export const parseOffset = (raw) => (has(raw) ? parseIntegerParam('offset', raw, { min: 0, max: Q.maxOffset }) : 0);

/** "<allowed field>,<asc|desc>" -> the same string, or the default. */
export function parseOrderBy(raw) {
  if (!has(raw)) return Q.defaultOrderBy;
  const s = oneString('order_by', raw);
  const [field, dir, ...rest] = s.split(',');
  if (rest.length || !Q.orderFields.includes(field) || !['asc', 'desc'].includes(dir)) {
    fail('order_by', 'order_by must be "<field>,<asc|desc>" with a sortable field');
  }
  return `${field},${dir}`;
}

// The provider's `like` is case-SENSITIVE (live check: %EYE% matched 0 rows, %eye% 2,464) and every keyword it stores is lowercase,
// so a keyword pattern is lowercased: "Eye" finds what the user means, and "Eye" / "eye" share one cache entry.
/** ?filters=<json> -> canonical conditions (sorted, de-duplicated), or [] when absent. */
export const parseFilters = createFilterParser({
  fields: Q.filterFields,
  maxConditions: Q.maxFilterConditions,
  patternMaxLength: Q.patternMaxLength,
  intents: Q.intents,
  lowercaseFields: ['keyword_data.keyword'],
  orGroups: Q.orGroups,
});

/** Canonical conditions -> DataForSEO's `filters` value: a flat triple for one condition, "and"-joined for several, null for none. */
export const toProviderFilters = toProviderFiltersShared;

/** Cache-key variant: every input that changes the provider's answer, as a short stable string (the cache `variant` column is 200 chars). */
export function buildVariant({ limit, offset, orderBy, filters }) {
  return `l${limit}|o${offset}|${orderBy}|f:${hashFilters(filters)}`;
}

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ limit: number, offset: number, orderBy: string, filters: Array, variant: string, isDefault: boolean }}
 */
export function parseRankedKeywordsQuery(query = {}) {
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  const orderBy = parseOrderBy(query.order_by);
  const filters = parseFilters(query.filters);
  return {
    limit, offset, orderBy, filters,
    variant: buildVariant({ limit, offset, orderBy, filters }),
    isDefault: limit === RANKED_KEYWORDS_LIMIT && offset === 0 && orderBy === Q.defaultOrderBy && filters.length === 0,
  };
}

/** True when the query string carries any paging / sorting / filtering parameter (even an invalid one). */
export const hasRankedKeywordsParams = (query = {}) => ['limit', 'offset', 'order_by', 'filters'].some((k) => query[k] !== undefined);
