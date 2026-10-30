import DataForSeoCacheEntry from './DataForSeoCacheEntry.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Get-or-fetch for billed DataForSEO calls.
 *
 *  - A fresh cached entry is returned without calling the provider.
 *  - `refresh` skips the cache, EXCEPT when the entry was fetched less than MIN_REFRESH_INTERVAL_MS ago: a second click (or a
 *    second tab) inside that window would only buy the same data again, so it is answered from the entry it would replace.
 *  - Identical misses that overlap in time share ONE provider call (single-flight), so a double page load is billed once.
 *  - Only successes are cached; a failed call is never stored, and a cache/DB hiccup never blocks a fetch or loses its result.
 */

export const MIN_REFRESH_INTERVAL_MS = 60_000;

const inFlight = new Map();

/** MongoDB-backed store. Replaceable in tests. */
export const mongoStore = {
  async read(key) {
    return DataForSeoCacheEntry.findOne({ key }).lean();
  },
  async write(entry) {
    await DataForSeoCacheEntry.findOneAndUpdate({ key: entry.key }, { $set: entry }, { upsert: true, new: true, setDefaultsOnInsert: true });
  },
};

export const cacheKey = ({ endpoint, target, location = '', language = '', variant = '' }) =>
  [endpoint, target, location, language, variant].map((p) => String(p).trim().toLowerCase()).join('|');

/**
 * @param {{ endpoint: string, target: string, location?: string, language?: string, variant?: string, ttlMs: number,
 *           refresh?: boolean, fetcher: () => Promise<{ payload: object, cost?: number|null }> }} args
 * @param {{ store?: typeof mongoStore, now?: () => number }} [deps]
 * @returns {Promise<{ payload: object, fetchedAt: Date, cached: boolean, refreshThrottled: boolean }>}
 */
export async function getOrFetch(args, { store = mongoStore, now = () => Date.now() } = {}) {
  const { endpoint, target, location = '', language = '', variant = '', ttlMs, refresh = false, fetcher } = args;
  const key = cacheKey({ endpoint, target, location, language, variant });

  let existing = null;
  try {
    existing = await store.read(key);
  } catch (err) {
    LoggerUtil.warn('DataForSEO cache: read failed, fetching instead', { endpoint, error: err?.message });
  }

  if (existing && new Date(existing.expiresAt).getTime() > now()) {
    const fetchedAt = new Date(existing.fetchedAt);
    if (!refresh) return { payload: existing.payload, fetchedAt, cached: true, refreshThrottled: false };
    if (now() - fetchedAt.getTime() < MIN_REFRESH_INTERVAL_MS) return { payload: existing.payload, fetchedAt, cached: true, refreshThrottled: true };
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const run = (async () => {
    const { payload, cost = null } = await fetcher();
    const fetchedAt = new Date(now());
    try {
      await store.write({
        key, endpoint, target: String(target).toLowerCase(), location, language, variant, payload, cost,
        fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlMs),
      });
    } catch (err) {
      LoggerUtil.warn('DataForSEO cache: could not store the response (it is still returned)', { endpoint, error: err?.message });
    }
    return { payload, fetchedAt, cached: false, refreshThrottled: false };
  })().finally(() => { inFlight.delete(key); });

  inFlight.set(key, run);
  return run;
}

/**
 * Peek: the cached entry for a question, or null — NEVER a provider call. A miss, an expired entry and a store that cannot be read are all
 * null (a peek that fails is just "not cached"). For callers that only want to show what is already known.
 * @param {{ endpoint: string, target: string, location?: string, language?: string, variant?: string }} args
 * @returns {Promise<{ payload: object, fetchedAt: Date, cached: true, refreshThrottled: false }|null>}
 */
export async function getCachedOnly(args, { store = mongoStore, now = () => Date.now() } = {}) {
  const key = cacheKey(args);
  let existing = null;
  try {
    existing = await store.read(key);
  } catch (err) {
    LoggerUtil.warn('DataForSEO cache: peek failed, treated as not cached', { endpoint: args.endpoint, error: err?.message });
    return null;
  }
  if (!existing || !(new Date(existing.expiresAt).getTime() > now())) return null;
  return { payload: existing.payload, fetchedAt: new Date(existing.fetchedAt), cached: true, refreshThrottled: false };
}

/** Test helper: forget any in-flight calls. */
export function __resetInFlightForTests() {
  inFlight.clear();
}
