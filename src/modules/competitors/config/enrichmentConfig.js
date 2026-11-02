/**
 * My Competitors SEO enrichment: every limit in one place, all overridable by environment variable (read when asked, never at import,
 * so tests and ops can change them). Cost control: enrichment runs only for competitors a user SAVED (never for the 1,000+ domains of the
 * SEO list), only in the background, never on a page load.
 */
const int = (name, fallback, { min = 0 } = {}) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const flag = (name, fallback) => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(v)) return false;
  if (['true', '1', 'on', 'yes'].includes(v)) return true;
  return fallback;
};

export function getEnrichmentConfig() {
  return Object.freeze({
    /** Kill switch. Off: nothing is claimed or fetched; saved competitors simply wait as `pending`. COMPETITOR_ENRICHMENT_ENABLED=false */
    enabled: flag('COMPETITOR_ENRICHMENT_ENABLED', true),
    sweepEnabled: flag('COMPETITOR_ENRICHMENT_SWEEP_ENABLED', true),
    sweepCron: process.env.COMPETITOR_ENRICHMENT_SWEEP_CRON || '*/1 * * * *',
    /** How long a worker owns a competitor before another may take it over (a crash is recovered after this). */
    leaseMs: int('COMPETITOR_ENRICHMENT_LEASE_MS', 5 * 60_000, { min: 1000 }),
    /** Competitors enriched at the same time by ONE process (the sweep starts at most this many). */
    concurrency: int('COMPETITOR_ENRICHMENT_CONCURRENCY', 2, { min: 1 }),
    /** Competitors one sweep may start (a sweep is every minute, so this also bounds the per-minute spend). */
    maxPerSweep: int('COMPETITOR_ENRICHMENT_MAX_PER_SWEEP', 4, { min: 1 }),
    /** Attempts before a transient failure is final. */
    maxAttempts: int('COMPETITOR_ENRICHMENT_MAX_ATTEMPTS', 4, { min: 1 }),
    backoffBaseMs: int('COMPETITOR_ENRICHMENT_BACKOFF_BASE_MS', 60_000, { min: 0 }),
    backoffMaxMs: int('COMPETITOR_ENRICHMENT_BACKOFF_MAX_MS', 60 * 60_000, { min: 0 }),
    /** REAL provider calls one project may cause per UTC day (cache hits are free and do not count). */
    projectDailyProviderCalls: int('COMPETITOR_ENRICHMENT_PROJECT_DAILY_CALLS', 60, { min: 1 }),
    /** Minimum time between two MANUAL refreshes of the same competitor. */
    refreshCooldownMs: int('COMPETITOR_ENRICHMENT_REFRESH_COOLDOWN_MS', 24 * 60 * 60_000, { min: 0 }),
    /** Data older than this is shown as stale (derived from its age; never stored). */
    staleAfterMs: int('COMPETITOR_ENRICHMENT_STALE_AFTER_MS', 14 * 24 * 60 * 60_000, { min: 1 }),
  });
}

/** Exponential backoff, capped: attempt 1 -> base, 2 -> 2x, 3 -> 4x ... */
export function backoffMs(attempts, config = getEnrichmentConfig()) {
  const exp = Math.max(0, attempts - 1);
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * (2 ** exp));
}
