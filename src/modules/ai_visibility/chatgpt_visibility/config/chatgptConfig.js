/**
 * ChatGPT Visibility configuration. All values are server-side and read lazily from the environment, so a deploy (or a
 * test) can change them without code changes. Nothing here is ever taken from a request body or from model output.
 *
 * Every limit is a conservative default; none of them encodes a billing policy. Provider cost is only RECORDED
 * (see maxRunCost for the one guard that uses it).
 */

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
const list = (v, dflt) => (v == null || String(v).trim() === '' ? dflt : String(v).split(',').map((s) => s.trim()).filter(Boolean));

export function getChatGptConfig(env = process.env) {
  return Object.freeze({
    // ── feature switches (both default OFF: nothing paid happens until an operator opts in) ──
    enabled: bool(env.CHATGPT_VISIBILITY_ENABLED, false),
    autoRun: bool(env.CHATGPT_VISIBILITY_AUTO_RUN, false),
    // Which full-audit run sources may auto-start a visibility run. Quick rechecks never reach the audit-start path.
    // initial_audit / manual_recrawl are user-initiated; admin_recrawl is excluded by default (it is unbilled and bulk-capable).
    autoRunSources: list(env.CHATGPT_VISIBILITY_AUTO_RUN_SOURCES, ['initial_audit', 'manual_recrawl']),

    // ── provider request (server-chosen; never client- or model-chosen) ──
    // Must be a model_name from DataForSEO's ChatGPT model list (GET /v3/ai_optimization/chat_gpt/llm_responses/models).
    // There is no plain "gpt-6" there; the GPT-6 family is gpt-6-sol / gpt-6-luna / gpt-6-astra / gpt-6.1-sol.
    model: (env.CHATGPT_VISIBILITY_MODEL || 'gpt-6-sol').trim(),
    webSearch: bool(env.CHATGPT_VISIBILITY_WEB_SEARCH, true),
    // Reasoning models (GPT-6) spend part of this budget thinking before they answer, so it is higher than for gpt-4o-mini.
    maxOutputTokens: posInt(env.CHATGPT_VISIBILITY_MAX_OUTPUT_TOKENS, 4096),
    timeoutMs: posInt(env.CHATGPT_VISIBILITY_TIMEOUT_MS, 120_000),
    maxRetries: Math.min(5, Math.floor(num(env.CHATGPT_VISIBILITY_MAX_RETRIES, 2))),
    retryBaseDelayMs: posInt(env.CHATGPT_VISIBILITY_RETRY_BASE_DELAY_MS, 1_500),
    retryMaxDelayMs: posInt(env.CHATGPT_VISIBILITY_RETRY_MAX_DELAY_MS, 20_000),
    // The DataForSEO response states no currency or unit (verified live), so costs are labelled 'provider_reported' and stored exactly as
    // reported. An operator who has confirmed the unit against their DataForSEO billing may set CHATGPT_VISIBILITY_COST_UNIT (e.g. USD).
    costUnit: (env.CHATGPT_VISIBILITY_COST_UNIT || 'provider_reported').trim().slice(0, 20),

    // ── concurrency (all PER PROCESS, see runWorker.js for the multi-instance caveat) ──
    maxConcurrentPrompts: posInt(env.CHATGPT_VISIBILITY_MAX_CONCURRENT_PROMPTS, 2),
    maxConcurrentRuns: posInt(env.CHATGPT_VISIBILITY_MAX_CONCURRENT_RUNS, 2),
    // Best-effort cap on runs in 'running' across ALL instances (checked against the database before claiming; not atomic).
    maxGlobalRunning: posInt(env.CHATGPT_VISIBILITY_MAX_GLOBAL_RUNNING, 4),

    // ── lease / recovery ──
    leaseMs: posInt(env.CHATGPT_VISIBILITY_LEASE_MS, 120_000),
    maxClaims: posInt(env.CHATGPT_VISIBILITY_MAX_CLAIMS, 3),
    sweepCron: (env.CHATGPT_VISIBILITY_SWEEP_CRON || '* * * * *').trim(),
    sweepEnabled: bool(env.CHATGPT_VISIBILITY_SWEEP_ENABLED, true),
    // A full audit that started within this window with no visibility record is repaired by the sweep (crash safety).
    repairWindowMs: posInt(env.CHATGPT_VISIBILITY_REPAIR_WINDOW_MS, 2 * 60 * 60 * 1000),

    // ── cost and abuse controls ──
    // Master switch for the run limits below (cooldown, per-project and per-account daily caps). OFF by default for now:
    // set CHATGPT_VISIBILITY_LIMITS_ENABLED=true to enforce them again.
    limitsEnabled: bool(env.CHATGPT_VISIBILITY_LIMITS_ENABLED, false),
    cooldownMs: Math.floor(num(env.CHATGPT_VISIBILITY_COOLDOWN_MS, 0)), // 0 = no cooldown between runs (temporarily off by default)
    maxRunsPerProjectPerDay: posInt(env.CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT, 3),
    dailyUserLimit: posInt(env.CHATGPT_VISIBILITY_DAILY_USER_LIMIT, 10),
    // Stop scheduling further prompts once the KNOWN provider cost of the run reaches this. Cost is only known after a prompt
    // completes, so the bound is "this + what was in flight". 0 disables the guard.
    maxRunCost: num(env.CHATGPT_VISIBILITY_MAX_RUN_COST, 0), // 0 = no per-run cost cap (off by default for now)

    // ── approved-question runs ──
    // Upper bound on questions snapshotted into one approved-question run (a run that would exceed it is truncated, and says so).
    maxQuestionsPerRun: Math.min(100, posInt(env.CHATGPT_VISIBILITY_MAX_QUESTIONS_PER_RUN, 50)),
    // Evidence (answers + citations) is deleted by a TTL index this many days after it was recorded. 0 keeps it until the project is deleted.
    evidenceRetentionDays: Math.floor(num(env.AI_VISIBILITY_EVIDENCE_RETENTION_DAYS, 365)),
  });
}

export default { getChatGptConfig };
