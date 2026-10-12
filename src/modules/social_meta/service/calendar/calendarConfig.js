import { STRATEGY_MODEL } from '../aiStrategy/strategyConfig.js';

/**
 * Content Calendar planning — configuration. Every knob lives here (env overrides, non-positive / non-finite values
 * rejected); nothing is hardcoded in the service or provider. Planning is strategy-adjacent work, so it uses the same
 * Claude provider as the AI Strategy (no second provider); the model:
 *   SOCIAL_AI_CALENDAR_MODEL -> the strategy model.
 */
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const CALENDAR_MODEL = process.env.SOCIAL_AI_CALENDAR_MODEL || STRATEGY_MODEL;
/**
 * One call covers a batch of slots, so no single prompt / answer grows with the length of the calendar. Every post now carries its
 * full written copy (caption, hashtags and, for a two-platform post, a version per platform), so a batch is small enough for the
 * answer to fit the output budget: 4 posts x (plan + caption + up to two adapted captions) stays well under it.
 */
export const CALENDAR_BATCH_SIZE = num(process.env.SOCIAL_AI_CALENDAR_BATCH_SIZE, 4);
export const CALENDAR_MAX_OUTPUT_TOKENS = num(process.env.SOCIAL_AI_CALENDAR_MAX_OUTPUT_TOKENS, 8_000);
export const CALENDAR_TIMEOUT_MS = num(process.env.SOCIAL_AI_CALENDAR_TIMEOUT_MS, 300_000);
/** Transient provider failures only (timeout / overloaded / rate-limit / network). */
export const CALENDAR_PROVIDER_RETRIES = num(process.env.SOCIAL_AI_CALENDAR_PROVIDER_RETRIES, 1);
/** Extra model calls allowed per batch when its output fails Odito's validation. Exactly one repair, never a loop. */
export const CALENDAR_MAX_REPAIR_ATTEMPTS = num(process.env.SOCIAL_AI_CALENDAR_REPAIR_ATTEMPTS, 1);
/**
 * LIVENESS of a running generation is a LEASE, not a guess about how long a run may take. The worker that owns a generation
 * renews its lease every HEARTBEAT_MS; if the process dies or hangs the renewals stop and the lease expires after LEASE_MS, at
 * which point any instance may take the generation over and continue it from the batches already saved. LEASE_MS must be
 * several heartbeats long, so one slow tick never costs a run its lease. A run's total length is bounded separately by the
 * number of batches and RUN_ATTEMPTS below (and, as a last resort, MAX_RUN_MS), never by a timer that has to out-wait the
 * slowest possible run.
 */
export const CALENDAR_LEASE_MS = num(process.env.SOCIAL_AI_CALENDAR_LEASE_MS, 90_000);
export const CALENDAR_HEARTBEAT_MS = Math.min(num(process.env.SOCIAL_AI_CALENDAR_HEARTBEAT_MS, 30_000), Math.floor(CALENDAR_LEASE_MS / 3));
/** How many times one generation may be (re)started - the first run counts - before it stops as `partial` / `failed`. Permanent (validation) failures are never retried automatically. */
export const CALENDAR_MAX_RUN_ATTEMPTS = num(process.env.SOCIAL_AI_CALENDAR_RUN_ATTEMPTS, 3);
/** Wait before an automatic retry after a transient failure: BASE x 2^(attempt - 1), capped. */
export const CALENDAR_RETRY_BACKOFF_MS = num(process.env.SOCIAL_AI_CALENDAR_RETRY_BACKOFF_MS, 60_000);
export const CALENDAR_RETRY_BACKOFF_MAX_MS = num(process.env.SOCIAL_AI_CALENDAR_RETRY_BACKOFF_MAX_MS, 15 * 60_000);
/** Absolute ceiling for ONE run (a runaway safety net; it ends as `partial`, resumable). */
export const CALENDAR_MAX_RUN_MS = num(process.env.SOCIAL_AI_CALENDAR_MAX_RUN_MS, 6 * 60 * 60 * 1000);
/** AI planning runs executing at the same time IN THIS PROCESS (each one is sequential inside; exclusivity per calendar is the database lease). */
export const CALENDAR_MAX_CONCURRENT_RUNS = num(process.env.SOCIAL_AI_CALENDAR_MAX_CONCURRENT_RUNS, 2);
/** How often the recovery sweep looks for generations whose lease expired (cron, every minute by default). */
export const CALENDAR_RECOVERY_CRON = process.env.SOCIAL_AI_CALENDAR_RECOVERY_CRON || '* * * * *';
export const CALENDAR_RECOVERY_ENABLED = process.env.SOCIAL_AI_CALENDAR_RECOVERY_ENABLED !== 'false';

/**
 * The planning window. A calendar covers whole CALENDAR MONTHS counted from its start date (see calendarPlanner.periodEndDate):
 * 1 to 6. MIN_DAYS only applies to the legacy { startDate, endDate } request (a range shorter than a week cannot carry a weekly
 * frequency); MAX_DAYS is the longest a 6-month period can ever be (184 days: Jul 1 - Dec 31) and is reported to clients as
 * `limits.maxDays` for backward compatibility.
 */
export const CALENDAR_MIN_MONTHS = 1;
export const CALENDAR_MAX_MONTHS = 6;
export const CALENDAR_MIN_DAYS = num(process.env.SOCIAL_AI_CALENDAR_MIN_DAYS, 7);
export const CALENDAR_MAX_DAYS = 184;
/** How far ahead a calendar may start: a plan for a start date years away is a typo, and would hold the generation slot. */
export const CALENDAR_MAX_START_AHEAD_DAYS = num(process.env.SOCIAL_AI_CALENDAR_MAX_START_AHEAD_DAYS, 365);
/**
 * Safety ceiling on the posts of ONE calendar (checked before any AI call). 7 posts a week for the longest 6-month period is
 * 184 posts, so the default of 200 never refuses a valid request, yet bounds the work and spend of a runaway one.
 */
export const CALENDAR_MAX_POSTS = num(process.env.SOCIAL_AI_CALENDAR_MAX_POSTS, 200);
/** Room for hand-added posts on top of a full generated calendar. */
export const CALENDAR_MAX_ITEMS = CALENDAR_MAX_POSTS + 50;

/** Archived (superseded) calendar versions kept per project. Versions that own a real post are never pruned. */
export const CALENDAR_HISTORY_LIMIT = num(process.env.SOCIAL_AI_CALENDAR_HISTORY_LIMIT, 10);

export const CALENDAR_RATE_LIMIT = Object.freeze({
  windowMs: num(process.env.SOCIAL_AI_CALENDAR_RATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.SOCIAL_AI_CALENDAR_RATE_MAX, 6),
});
