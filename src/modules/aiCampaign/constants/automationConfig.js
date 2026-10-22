/**
 * Phase 8 automation guardrail limits — every value here is a CEILING the
 * server enforces regardless of what a policy document says.
 * `effectiveLimit = min(userConfiguredLimit, systemMaximum)` is computed at
 * evaluation time (automationGuardrails.js), never cached onto the policy —
 * tightening a system maximum here protects every existing policy
 * immediately, with no migration.
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// ── System-wide ceilings (spec: "system-level maximums") ─────────────────
export const SYSTEM_MAX_ACTIONS_PER_RUN = num(process.env.AI_CAMPAIGN_AUTOMATION_MAX_ACTIONS_PER_RUN, 10);
export const SYSTEM_MIN_COOLDOWN_HOURS = num(process.env.AI_CAMPAIGN_AUTOMATION_MIN_COOLDOWN_HOURS, 6);
// Reuses Phase 7's own budget-safety ceiling (optimizationConfig.js) as the
// system maximum here too — one source of truth for "how much a campaign's
// daily budget may move in one automated step."
export const SYSTEM_MAX_BUDGET_CHANGE_PERCENT = num(process.env.AI_CAMPAIGN_AUTOMATION_MAX_BUDGET_CHANGE_PERCENT, 30);

// ── User-configurable defaults (a policy may request less, never more) ───
export const DEFAULT_MAX_ACTIONS_PER_RUN = 5;
export const DEFAULT_COOLDOWN_HOURS = 24;
export const DEFAULT_MAX_BUDGET_CHANGE_PERCENT = 15;

// Absolute upper bound accepted on a policy's OWN requested limit fields at
// write time (request-shape validation) — independent of, and looser than,
// the system ceiling above, which is still re-applied at every run.
export const USER_LIMIT_CEILING = Object.freeze({
  maxActionsPerRun: 50,
  cooldownHours: 24 * 30, // 30 days
  maxBudgetChangePercent: 100,
});

// ── Data sufficiency (mirrors Phase 7 CONFIDENCE_THRESHOLDS) ─────────────
/** A rule's own `minimumClicks` may not go below this — never let a policy match on statistically meaningless volume. */
export const MIN_ALLOWED_RULE_MINIMUM_CLICKS = 5;
export const DEFAULT_RULE_MINIMUM_CLICKS = 30;

// ── Rule / policy shape limits ────────────────────────────────────────────
export const MAX_RULES_PER_POLICY = 10;
export const MAX_ACTIONS_RECORDED_PER_RUN = 100; // audit-trail cap on the actions[] array itself, independent of the execution limit above

// ── Scheduler ──────────────────────────────────────────────────────────
/** How often the scheduler scans for due policies — a polling cadence, not the automation interval itself (mirrors weeklyRecheckScheduler.js's own daily-poll-vs-weekly-window split). */
export const AUTOMATION_SCHEDULER_CRON = process.env.AI_CAMPAIGN_AUTOMATION_SCHEDULER_CRON || '*/15 * * * *';
/** Global kill switch (spec: "not exposed to normal project users") — same convention as every other scheduler kill switch in this codebase (WEEKLY_RECRAWL_ENABLED, STALE_LOCK_CLEANUP_ENABLED, etc.): an operator-only env var, default ON, requiring a redeploy to change — deliberately consistent with codebase norms rather than introducing a new persisted config collection this repo has never had. */
export const AUTOMATION_SYSTEM_ENABLED = process.env.AI_CAMPAIGN_AUTOMATION_ENABLED !== 'false';

// ── Performance snapshot reuse ────────────────────────────────────────────
export const AUTOMATION_DEFAULT_DATE_RANGE_DAYS = 30;

export default {
  SYSTEM_MAX_ACTIONS_PER_RUN,
  SYSTEM_MIN_COOLDOWN_HOURS,
  SYSTEM_MAX_BUDGET_CHANGE_PERCENT,
  DEFAULT_MAX_ACTIONS_PER_RUN,
  DEFAULT_COOLDOWN_HOURS,
  DEFAULT_MAX_BUDGET_CHANGE_PERCENT,
  USER_LIMIT_CEILING,
  MIN_ALLOWED_RULE_MINIMUM_CLICKS,
  DEFAULT_RULE_MINIMUM_CLICKS,
  MAX_RULES_PER_POLICY,
  MAX_ACTIONS_RECORDED_PER_RUN,
  AUTOMATION_SCHEDULER_CRON,
  AUTOMATION_SYSTEM_ENABLED,
  AUTOMATION_DEFAULT_DATE_RANGE_DAYS,
};
