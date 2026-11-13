import { DATASETS, DATASET_FRESH_MS } from '../config.js';
import { SECTIONS } from '../../domain_overview/config.js';

/**
 * How long each dataset counts as fresh. NOT one TTL: it follows how often the data really changes and what the provider charges.
 *   - a stored row set (keywords, backlinks, referring domains) is fresh for DATASET_FRESH_MS (config.js, per kind);
 *   - every other dataset is fresh for the `ttlMs` of its section (domain_overview/config.js): 24 h for most, 7 days for the history and the
 *     profile-level counts. That is also the deadline stored with the answer, so "stale" here and "stale" on the page are the same thing.
 * Nothing is deleted when a deadline passes; a stale dataset is still served while its refresh runs.
 */
export function freshMsOf(datasetId) {
  const def = DATASETS[datasetId];
  if (!def) throw new Error(`Unknown dataset: ${datasetId}`);
  if (def.collector) return DATASET_FRESH_MS[def.collector];
  return SECTIONS[def.section].ttlMs;
}

/** { datasetId: freshMs } for documentation, the status endpoint and tests. */
export const freshnessPolicy = () => Object.fromEntries(Object.keys(DATASETS).map((id) => [id, freshMsOf(id)]));
