import { createHash } from 'node:crypto';

/**
 * Provider mode and tuning for Google Organic SERP rankings (DataForSEO Live vs Standard task-based API).
 *
 *   DATAFORSEO_SERP_MODE                     live (default) | standard
 *   DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT 0..100 (default 100): with mode=standard, the share of keywords (stable hash of
 *                                            keyword+location+language, so desktop and mobile always agree) that use Standard;
 *                                            the rest keep using Live. Raise it gradually.
 *   DATAFORSEO_SERP_FALLBACK_TO_LIVE         true|false (default false): when a Standard task FINALLY fails (retries used up, or the
 *                                            circuit breaker is open) the caller may buy one Live request instead. Never on a mere
 *                                            timeout (the task is still running) and never for both at once.
 * Everything is read at call time so ops can change it without a deploy of module state.
 */

const int = (raw, fallback, min, max) => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const flag = (raw) => ['true', '1', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());

export function resolveSerpMode(env = process.env) {
  return String(env.DATAFORSEO_SERP_MODE ?? '').trim().toLowerCase() === 'standard' ? 'standard' : 'live';
}

/** Stable 0..99 bucket of a keyword in a market; the same inputs always land in the same bucket. */
export function rolloutBucket(keyword, locationCode, languageCode) {
  const h = createHash('sha1').update(`${String(keyword).trim().toLowerCase()}|${locationCode}|${languageCode}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** The provider ('live' | 'standard') to use for this keyword. */
export function providerFor({ keyword, locationCode, languageCode }, env = process.env) {
  if (resolveSerpMode(env) !== 'standard') return 'live';
  const percent = int(env.DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT, 100, 0, 100);
  return rolloutBucket(keyword, locationCode, languageCode) < percent ? 'standard' : 'live';
}

export const fallbackToLive = (env = process.env) => flag(env.DATAFORSEO_SERP_FALLBACK_TO_LIVE);

export function readStandardConfig(env = process.env) {
  return {
    batchSize: int(env.DATAFORSEO_SERP_STANDARD_BATCH_SIZE, 100, 1, 100), // task_post accepts at most 100 tasks
    claimLeaseMs: 60_000,
    // How long an interactive caller (an HTTP request) waits for its task. Standard averages ~5 min, target 45 min.
    waitMs: int(env.DATAFORSEO_SERP_STANDARD_WAIT_MS, 240_000, 1_000, 3_600_000),
    awaitPollMs: int(env.DATAFORSEO_SERP_STANDARD_AWAIT_POLL_MS, 1_500, 50, 30_000),
    // A completed task's result is reused by an identical request for this long (no second purchase).
    reuseMs: int(env.DATAFORSEO_SERP_STANDARD_REUSE_MS, 30 * 60_000, 0, 24 * 3_600_000),
    // tasks_ready is limited to 20 calls/minute by the provider: never faster than 3 s, grows to pollMaxMs while nothing is ready.
    pollBaseMs: int(env.DATAFORSEO_SERP_STANDARD_POLL_BASE_MS, 5_000, 3_000, 60_000),
    pollMaxMs: int(env.DATAFORSEO_SERP_STANDARD_POLL_MAX_MS, 60_000, 5_000, 600_000),
    // Direct task_get (not billed) for a task the ready list has not reported: first after this long, then exponentially.
    directPollAfterMs: int(env.DATAFORSEO_SERP_STANDARD_DIRECT_POLL_AFTER_MS, 180_000, 1_000, 3_600_000),
    directPollMaxMs: 5 * 60_000,
    directPollsPerTick: int(env.DATAFORSEO_SERP_STANDARD_DIRECT_POLLS_PER_TICK, 20, 1, 100),
    getConcurrency: int(env.DATAFORSEO_SERP_STANDARD_GET_CONCURRENCY, 5, 1, 20),
    // A task still not ready this long after submission is checked one last time, then retried or expired.
    taskTimeoutMs: int(env.DATAFORSEO_SERP_STANDARD_TASK_TIMEOUT_MS, 90 * 60_000, 1_000, 24 * 3_600_000),
    // Odito-level recovery: total submissions per logical request (each already includes the provider's own retries).
    maxAttempts: int(env.DATAFORSEO_SERP_STANDARD_MAX_ATTEMPTS, 3, 1, 10),
    retryBaseMs: int(env.DATAFORSEO_SERP_STANDARD_RETRY_BASE_MS, 5 * 60_000, 1, 3_600_000),
    retryMaxMs: int(env.DATAFORSEO_SERP_STANDARD_RETRY_MAX_MS, 2 * 3_600_000, 1, 24 * 3_600_000),
    maxInFlight: int(env.DATAFORSEO_SERP_STANDARD_MAX_IN_FLIGHT, 1000, 1, 100_000),
    // Circuit breaker over the last `breakerWindow` terminal outcomes.
    breakerWindow: int(env.DATAFORSEO_SERP_STANDARD_BREAKER_WINDOW, 20, 4, 200),
    breakerMinFailures: int(env.DATAFORSEO_SERP_STANDARD_BREAKER_MIN_FAILURES, 10, 2, 200),
    breakerOpenMs: int(env.DATAFORSEO_SERP_STANDARD_BREAKER_OPEN_MS, 10 * 60_000, 1, 6 * 3_600_000),
    // Priority 1 = normal queue (cheapest). 2 costs more and is never used implicitly.
    priority: int(env.DATAFORSEO_SERP_STANDARD_PRIORITY, 1, 1, 2),
    pingbackBaseUrl: String(env.DATAFORSEO_SERP_PINGBACK_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    pingbackSecret: String(env.DATAFORSEO_SERP_PINGBACK_SECRET ?? '').trim(),
    purgeCompletedMs: 7 * 24 * 3_600_000,
    purgeFailedMs: 30 * 24 * 3_600_000,
    workerPollMs: int(env.DATAFORSEO_SERP_STANDARD_WORKER_POLL_MS, 2_000, 10, 60_000),
  };
}
