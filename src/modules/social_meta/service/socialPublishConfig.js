/**
 * Social publishing reliability configuration — retry/backoff, stale-lock
 * recovery, maximum lateness, reconciliation.
 *
 * Every value is read from process.env AT CALL TIME (never captured in a
 * module-level constant). This project is native ESM: a module's top-level
 * body runs before server.js's dotenv.config() statement, so a top-level
 * `const X = process.env.X` here would permanently freeze the default and
 * silently ignore .env (the exact bug socialSchedulerService.js documents).
 *
 * Conventions follow the repo's other retry configs (aiCampaign's
 * *_RETRY_BASE_MS, delay = base * 2 ** (attempt - 1)): env-overridable
 * integers with safe defaults, invalid/negative values fall back to the
 * default rather than disabling a safety mechanism.
 *
 * Documented in odito_backend/.env.example.
 */

function intEnv(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

const MINUTE = 60 * 1000;

export function getPublishConfig() {
  return {
    // Total attempts per scheduled post, INCLUDING the first one
    // (4 => the first try + up to 3 automatic retries).
    maxAttempts: intEnv('SOCIAL_PUBLISH_MAX_ATTEMPTS', 4),
    // delay before retry n = base * 2 ** (n - 1), capped at retryMaxDelayMs.
    retryBaseMs: intEnv('SOCIAL_PUBLISH_RETRY_BASE_MS', 1 * MINUTE),
    // Throttling needs a much longer cool-down than a blip.
    rateLimitRetryBaseMs: intEnv('SOCIAL_PUBLISH_RATE_LIMIT_BASE_MS', 5 * MINUTE),
    retryMaxDelayMs: intEnv('SOCIAL_PUBLISH_RETRY_MAX_DELAY_MS', 15 * MINUTE),
    // A `publishing` row whose lock is older than this is presumed orphaned
    // (crashed/restarted worker). Must comfortably exceed the longest real
    // publish: Instagram polls a container for ~15s and each Graph call has
    // its own timeout, so a live publish finishes well inside this.
    staleMs: intEnv('SOCIAL_PUBLISH_STALE_MS', 10 * MINUTE),
    // A scheduled post this far past its time is NOT auto-published (e.g.
    // after downtime or the scheduler being disabled) — it is marked
    // failed/SCHEDULE_MISSED and needs a deliberate user action.
    maxLatenessMs: intEnv('SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES', 60) * MINUTE,
    // After an unknown outcome, wait this long before concluding "not found
    // on Meta" means "not published" (Meta needs a moment to surface a post).
    reconcileSettleMs: intEnv('SOCIAL_PUBLISH_RECONCILE_SETTLE_MS', 2 * MINUTE),
    // Stop re-checking an unresolved unknown outcome after this long; the
    // post stays flagged for a human to verify on the platform.
    reconcileGiveUpMs: intEnv('SOCIAL_PUBLISH_RECONCILE_GIVE_UP_MINUTES', 24 * 60) * MINUTE,
    // The final, state-changing publish call is given longer than the
    // generic 10s Graph default — a timeout there creates an unknown
    // outcome, so it should be the exception, not the norm.
    publishTimeoutMs: intEnv('SOCIAL_PUBLISH_TIMEOUT_MS', 30 * 1000),
  };
}

/**
 * Delay (ms) before the retry that follows failed attempt number `attempts`
 * (1-based). Deterministic on purpose (no jitter): the scheduler only ticks
 * once a minute, so sub-minute jitter would be unobservable.
 */
export function computeRetryDelayMs(attempts, category, config = getPublishConfig()) {
  const base = category === 'RATE_LIMIT' ? config.rateLimitRetryBaseMs : config.retryBaseMs;
  const exponent = Math.max(0, attempts - 1);
  return Math.min(base * 2 ** exponent, config.retryMaxDelayMs);
}

export function computeNextRetryAt(attempts, category, now = new Date(), config = getPublishConfig()) {
  return new Date(now.getTime() + computeRetryDelayMs(attempts, category, config));
}

/**
 * Whether a failed attempt may be retried automatically. Only failures the
 * classifier marked retryable AND whose outcome is definitively "not
 * published" qualify — an unknown outcome must be reconciled first, never
 * blindly retried.
 */
export function shouldAutoRetry({ retryable, outcome }, attempts, config = getPublishConfig()) {
  return retryable === true && outcome === 'not_published' && attempts < config.maxAttempts;
}

export default { getPublishConfig, computeRetryDelayMs, computeNextRetryAt, shouldAutoRetry };
