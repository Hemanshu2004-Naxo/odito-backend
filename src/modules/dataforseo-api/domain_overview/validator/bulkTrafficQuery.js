import { createHash } from 'node:crypto';
import { normalizeDomainInput } from '../../shared/targetDomain.js';
import { BULK_TRAFFIC } from '../config.js';
import { fail, has, oneString } from './filterConditions.js';

/**
 * Pure input handling for the bulk-traffic section (the Compare section): `?targets=a.com,b.com` = the competitors to compare
 * with the project. The project's own domain is added by the server and never taken from the request. Every target is cleaned
 * with the same rule the saved lists use, deduplicated and capped BEFORE a billed call can happen.
 */

export const BULK_TRAFFIC_PARAMS = Object.freeze(['targets']);
export const hasBulkTrafficParams = (query = {}) => BULK_TRAFFIC_PARAMS.some((k) => query[k] !== undefined);

/**
 * @param {Record<string, unknown>} query the request's query string
 * @param {string} projectDomain the project's own (clean) domain
 * @returns {{ targets: string[], variant: string }} `targets` = project first, then the competitors sorted; `variant` is the cache variant
 */
export function parseBulkTrafficQuery(query = {}, projectDomain) {
  if (!has(query.targets)) fail('targets', 'targets is required: the domains to compare with this project');
  const raw = oneString('targets', query.targets);
  if (raw.length > 4000) fail('targets', 'targets is too long');
  const clean = new Set();
  for (const part of raw.split(',')) {
    if (!part.trim()) continue;
    const domain = normalizeDomainInput(part);
    if (!domain) fail('targets', `"${part.trim().slice(0, 60)}" is not a valid domain`);
    if (domain !== projectDomain) clean.add(domain);
  }
  if (clean.size === 0) fail('targets', 'targets must include at least one domain besides this project');
  if (clean.size > BULK_TRAFFIC.maxExtraTargets) fail('targets', `at most ${BULK_TRAFFIC.maxExtraTargets} domains can be compared at once`);
  const sorted = [...clean].sort();
  const hash = createHash('sha1').update([projectDomain, ...sorted].sort().join('\n')).digest('hex').slice(0, 20);
  return { targets: [projectDomain, ...sorted], variant: `t:${hash}|i:${BULK_TRAFFIC.itemTypes.join(',')}` };
}
