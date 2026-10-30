import { BACKLINKS_QUERY as Q } from '../config.js';
import { fail, has, oneString } from './filterConditions.js';

/**
 * Pure input handling for the backlinks section (?status=live|lost|all &dofollow=1|0). Nothing here touches the network or MongoDB.
 * The browser chooses only these two things; the rest of the request body is fixed (config.js), so nothing unexpected reaches a paid API.
 */

/** ?status. Absent = "live" (the provider's own default). */
export function parseStatus(raw) {
  if (!has(raw)) return Q.defaultStatus;
  const s = oneString('status', raw);
  if (!Q.statuses.includes(s)) fail('status', `status must be one of ${Q.statuses.join(', ')}`);
  return s;
}

/** ?dofollow=1|true|0|false. Absent = off (no filter is sent at all). */
export function parseDofollow(raw) {
  if (!has(raw)) return false;
  const s = oneString('dofollow', raw);
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return fail('dofollow', 'dofollow must be 1 or 0');
}

/** Cache variant: every request-body input that changes the provider's answer. */
export const buildVariant = ({ status, dofollow }) =>
  `sub${Q.includeSubdomains ? 1 : 0}|l${Q.internalListLimit}|${status}|f:${dofollow ? 'dofollow' : 'none'}`;

/**
 * @param {Record<string, unknown>} query the request's query string
 * @returns {{ status: 'live'|'lost'|'all', dofollow: boolean, variant: string, isDefault: boolean }}
 */
export function parseBacklinksQuery(query = {}) {
  const status = parseStatus(query.status);
  const dofollow = parseDofollow(query.dofollow);
  return { status, dofollow, variant: buildVariant({ status, dofollow }), isDefault: status === Q.defaultStatus && !dofollow };
}

export const BACKLINKS_PARAMS = Object.freeze(['status', 'dofollow']);
/** True when the query string carries any backlinks parameter (even an invalid one). */
export const hasBacklinksParams = (query = {}) => BACKLINKS_PARAMS.some((k) => query[k] !== undefined);
