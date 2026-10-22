/**
 * EvidenceLedger — the traceable record of everything an investigation looked at.
 *
 * Each item carries where it came from, how it was obtained, when, and whether it succeeded, so the
 * model (and the user) can tell live observations from stored crawl data, and so a failure is recorded
 * as a failure rather than silently treated as "nothing found".
 *
 * Also de-duplicates fetches within one investigation: asking for the same URL twice returns the same
 * in-flight promise. A separate, short-lived cross-investigation cache exists for live fetches only; cached
 * items are flagged `fromCache` and keep their ORIGINAL retrieval time, so stale data is never presented as current.
 */

export const EVIDENCE_SOURCE = Object.freeze({
  LIVE_FETCH: 'live_fetch',
  CRAWL_DATA: 'crawl_data',
  DETECTOR: 'issue_detector',
  CAPABILITY: 'capability_registry',
  HISTORY: 'audit_history',
  DERIVED: 'derived_analysis', // computed by Odito from other evidence items (see derivedFrom), not observed directly
});

export const EVIDENCE_STATUS = Object.freeze({ OK: 'ok', UNAVAILABLE: 'unavailable', BLOCKED: 'blocked', ERROR: 'error' });

const LIVE_CACHE_TTL_MS = Number(process.env.INVESTIGATION_LIVE_CACHE_TTL_MS ?? 60_000);
const liveCache = new Map(); // `${projectId}|${url}` -> { at, item }
export const clearLiveEvidenceCache = () => liveCache.clear();

export class EvidenceLedger {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.items = [];
    this._inflight = new Map();
    this._seq = 0;
  }

  /** Adds an item and returns it. `data` must already be bounded by the caller. */
  add({ kind, source, method, url = null, status = EVIDENCE_STATUS.OK, summary = '', data = null, error = null, httpStatus = null, retrievedAt = null, fromCache = false, derivedFrom = null }) {
    this._seq += 1;
    const item = {
      id: `E${this._seq}`, kind, source, method, url, status, httpStatus, summary: String(summary).slice(0, 300),
      retrievedAt: retrievedAt || new Date(this.now()).toISOString(), fromCache, error, data, ...(derivedFrom ? { derivedFrom } : {}),
    };
    this.items.push(item);
    return item;
  }

  /** Runs `loader` once per key for the lifetime of this investigation. */
  once(key, loader) {
    if (!this._inflight.has(key)) this._inflight.set(key, Promise.resolve().then(loader));
    return this._inflight.get(key);
  }

  find(kind) { return this.items.filter((i) => i.kind === kind); }
  first(kind) { return this.items.find((i) => i.kind === kind && i.status === EVIDENCE_STATUS.OK) || null; }
  get ok() { return this.items.filter((i) => i.status === EVIDENCE_STATUS.OK); }
  get failures() { return this.items.filter((i) => i.status !== EVIDENCE_STATUS.OK); }

  /** Age of an item in ms (null if unknown). */
  ageMs(item) { const t = Date.parse(item?.retrievedAt || ''); return Number.isFinite(t) ? Math.max(0, this.now() - t) : null; }
  isFresh(item, maxAgeMs) { const a = this.ageMs(item); return a !== null && a <= maxAgeMs; }

  /** Trace view that is safe to persist/return to the client (no bulky data). */
  toTrace() {
    return this.items.map(({ data, ...rest }) => rest);
  }
}

export function readLiveCache(projectId, url, now = Date.now()) {
  if (LIVE_CACHE_TTL_MS <= 0) return null;
  const hit = liveCache.get(`${projectId}|${url}`);
  if (!hit || now - hit.at > LIVE_CACHE_TTL_MS) { liveCache.delete(`${projectId}|${url}`); return null; }
  return hit.item;
}

export function writeLiveCache(projectId, url, item, now = Date.now()) {
  if (LIVE_CACHE_TTL_MS <= 0 || item.status !== EVIDENCE_STATUS.OK) return;
  if (liveCache.size > 200) liveCache.delete(liveCache.keys().next().value);
  liveCache.set(`${projectId}|${url}`, { at: now, item });
}

export default { EvidenceLedger, EVIDENCE_SOURCE, EVIDENCE_STATUS, readLiveCache, writeLiveCache, clearLiveEvidenceCache };
