import { COMPETITORS_QUERY as Q } from '../config.js';
import {
  createFilterParser, fail, has, hashFilters, hashList, oneString, parseIntegerParam, toProviderFilters,
} from './filterConditions.js';

export { toProviderFilters };

/**
 * Pure input handling for the competitors section (?limit &offset &order_by &filters &exclude_top_domains &max_rank_group).
 * Nothing here touches the network or MongoDB. Everything is checked against the whitelists in config.js before a billed call can
 * happen and rewritten into one canonical form (same question -> same cache key). The project's exclude list is NOT a request
 * parameter: the service reads it from the project and adds it to the cache key with `withExcludedList`.
 */

export function parseLimit(raw) {
  if (!has(raw)) return Q.defaultLimit;
  const n = parseIntegerParam('limit', raw, { min: 1, max: Math.max(...Q.limits) });
  if (!Q.limits.includes(n)) fail('limit', `limit must be one of ${Q.limits.join(', ')}`);
  return n;
}

export const parseOffset = (raw) => (has(raw) ? parseIntegerParam('offset', raw, { min: 0, max: Q.maxOffset }) : 0);

/** "<allowed field>,<asc|desc>" -> the same string, or the default ("intersections,desc" = relevance). */
export function parseOrderBy(raw) {
  if (!has(raw)) return Q.defaultOrderBy;
  const s = oneString('order_by', raw);
  const [field, dir, ...rest] = s.split(',');
  if (rest.length || !Q.orderFields.includes(field) || !['asc', 'desc'].includes(dir)) {
    fail('order_by', 'order_by must be "<field>,<asc|desc>" with a sortable field');
  }
  return `${field},${dir}`;
}

/** ?exclude_top_domains=1|true|0|false. Absent = the default (hide the world's largest sites). */
export function parseExcludeTopDomains(raw) {
  if (!has(raw)) return Q.defaultExcludeTopDomains;
  const s = oneString('exclude_top_domains', raw);
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return fail('exclude_top_domains', 'exclude_top_domains must be 1 or 0');
}

/** ?max_rank_group=10|100. Absent = 100. */
export function parseMaxRankGroup(raw) {
  if (!has(raw)) return Q.defaultMaxRankGroup;
  const s = oneString('max_rank_group', raw);
  const n = /^\d{1,3}$/.test(s) ? Number(s) : NaN;
  if (!Q.maxRankGroups.includes(n)) fail('max_rank_group', `max_rank_group must be one of ${Q.maxRankGroups.join(', ')}`);
  return n;
}

export const parseFilters = createFilterParser({ fields: Q.filterFields, maxConditions: Q.maxFilterConditions });

/** Cache-key variant of everything the BROWSER chose (the project's exclude list is appended by `withExcludedList`). */
export function buildVariant({ limit, offset, orderBy, filters, excludeTopDomains, maxRankGroup }) {
  return `l${limit}|o${offset}|${orderBy}|f:${hashFilters(filters)}|t${excludeTopDomains ? 1 : 0}|r${maxRankGroup}`;
}

/** The full cache variant: the browser's choices + the project's exclude list (which is part of the provider's question too). */
export const withExcludedList = (variant, excludedDomains) => `${variant}|x:${hashList(excludedDomains)}`;

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ limit: number, offset: number, orderBy: string, filters: Array, excludeTopDomains: boolean, maxRankGroup: number, variant: string, isDefault: boolean }}
 */
export function parseCompetitorsQuery(query = {}) {
  const limit = parseLimit(query.limit);
  const offset = parseOffset(query.offset);
  const orderBy = parseOrderBy(query.order_by);
  const filters = parseFilters(query.filters);
  const excludeTopDomains = parseExcludeTopDomains(query.exclude_top_domains);
  const maxRankGroup = parseMaxRankGroup(query.max_rank_group);
  return {
    limit, offset, orderBy, filters, excludeTopDomains, maxRankGroup,
    variant: buildVariant({ limit, offset, orderBy, filters, excludeTopDomains, maxRankGroup }),
    isDefault: limit === Q.defaultLimit && offset === 0 && orderBy === Q.defaultOrderBy && filters.length === 0
      && excludeTopDomains === Q.defaultExcludeTopDomains && maxRankGroup === Q.defaultMaxRankGroup,
  };
}

export const COMPETITORS_PARAMS = Object.freeze(['limit', 'offset', 'order_by', 'filters', 'exclude_top_domains', 'max_rank_group']);

/** True when the query string carries any competitors parameter (even an invalid one). */
export const hasCompetitorsParams = (query = {}) => COMPETITORS_PARAMS.some((k) => query[k] !== undefined);
