/**
 * Google AI Overview Visibility configuration. Server-side only, read lazily from the environment; nothing here can come from a
 * request body or from provider output.
 *
 * QUESTIONS_PER_RUN is a CONSTANT, not configuration: every run asks exactly five questions, so no environment variable, request or
 * stored document can change the number of paid Google SERP requests a run makes.
 */

export const QUESTIONS_PER_RUN = 5;

/** The only SERP endpoint this feature calls (DataForSEO Google Organic SERP, Live, Advanced). */
export const GOOGLE_AIO_ENDPOINT = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

const num = (v, dflt, { min = 0 } = {}) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && v !== '' && v != null ? n : dflt;
};
const posInt = (v, dflt) => {
  const n = Math.floor(num(v, dflt, { min: 1 }));
  return n >= 1 ? n : dflt;
};
const bool = (v, dflt) => {
  if (v == null || String(v).trim() === '') return dflt;
  return ['true', '1', 'on', 'yes'].includes(String(v).trim().toLowerCase());
};

export function getGoogleAioConfig(env = process.env) {
  return Object.freeze({
    // Nothing paid happens until an operator opts in.
    enabled: bool(env.GOOGLE_AIO_VISIBILITY_ENABLED, false),

    // ── provider request (server-chosen) ──
    // depth is the number of organic results requested. The AI Overview sits above them, so the smallest page keeps the task cheap.
    depth: Math.min(100, posInt(env.GOOGLE_AIO_VISIBILITY_DEPTH, 10)),
    // false = DataForSEO returns an ai_overview item only when it is cached. true asks it to load the overview asynchronously
    // (+$0.002 per request, refunded by the provider when no overview element comes back). Default on.
    loadAsyncAiOverview: bool(env.GOOGLE_AIO_VISIBILITY_LOAD_ASYNC, true),
    timeoutMs: posInt(env.GOOGLE_AIO_VISIBILITY_TIMEOUT_MS, 90_000),
    // Retries are for TRANSIENT transport failures only (429 / 5xx / timeout / network). An absent AI Overview is never retried.
    maxRetries: Math.min(2, Math.floor(num(env.GOOGLE_AIO_VISIBILITY_MAX_RETRIES, 1))),
    retryBaseDelayMs: posInt(env.GOOGLE_AIO_VISIBILITY_RETRY_BASE_DELAY_MS, 2_000),
    retryMaxDelayMs: posInt(env.GOOGLE_AIO_VISIBILITY_RETRY_MAX_DELAY_MS, 20_000),
    costUnit: (env.GOOGLE_AIO_VISIBILITY_COST_UNIT || 'USD').trim().slice(0, 20),

    // ── concurrency (PER PROCESS) ──
    maxConcurrentQuestions: posInt(env.GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_QUESTIONS, 2),
    maxConcurrentRuns: posInt(env.GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_RUNS, 2),
    maxGlobalRunning: posInt(env.GOOGLE_AIO_VISIBILITY_MAX_GLOBAL_RUNNING, 4),

    // ── lease / recovery ──
    leaseMs: posInt(env.GOOGLE_AIO_VISIBILITY_LEASE_MS, 180_000),
    maxClaims: posInt(env.GOOGLE_AIO_VISIBILITY_MAX_CLAIMS, 3),
    sweepCron: (env.GOOGLE_AIO_VISIBILITY_SWEEP_CRON || '* * * * *').trim(),
    sweepEnabled: bool(env.GOOGLE_AIO_VISIBILITY_SWEEP_ENABLED, true),

    // ── cost and abuse controls (off by default, like the other visibility features) ──
    limitsEnabled: bool(env.GOOGLE_AIO_VISIBILITY_LIMITS_ENABLED, false),
    maxRunsPerProjectPerDay: posInt(env.GOOGLE_AIO_VISIBILITY_MAX_RUNS_PER_PROJECT, 3),
    // Stop sending further questions once the KNOWN provider cost of the run reaches this. 0 disables the guard.
    maxRunCost: num(env.GOOGLE_AIO_VISIBILITY_MAX_RUN_COST, 0),

    evidenceRetentionDays: Math.floor(num(env.AI_VISIBILITY_EVIDENCE_RETENTION_DAYS, 365)),
  });
}

export default { getGoogleAioConfig, QUESTIONS_PER_RUN, GOOGLE_AIO_ENDPOINT };
