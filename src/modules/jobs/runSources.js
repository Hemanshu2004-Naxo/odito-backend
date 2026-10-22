/**
 * Execution source of a project-wide pipeline run — the single vocabulary
 * shared by job tracking (Job.input_data.run_source), the project lock
 * (SeoProject.current_run_source), audit history (AuditRun.source), logs and
 * billing. Independent of Job.input_data.mode ('verification' /
 * 'url_verification' / unset), which only selects pipeline shape; the source
 * says WHO/WHAT started the run.
 *
 * Billing rule (see projectAuditService.js): only MANUAL_RECRAWL consumes a
 * manual-recrawl credit. Everything else is free by construction.
 */
export const RUN_SOURCES = Object.freeze({
  /** User pressed "Start Recrawl" — full audit, consumes 1 manual recrawl credit. */
  MANUAL_RECRAWL: 'manual_recrawl',
  /** A project's very first full audit (onboarding / Pre-Audit) — paid for by the project-creation credit. */
  INITIAL_AUDIT: 'initial_audit',
  /** System admin started a full audit on a user's behalf — never billed to the user. */
  ADMIN_RECRAWL: 'admin_recrawl',
  /** User pressed the dashboard "Quick Recheck" — verification pipeline, free. */
  MANUAL_RECHECK: 'manual_recheck',
  /** Weekly scheduler — verification pipeline, free, never uses manual recrawl credits. */
  WEEKLY_RECHECK: 'weekly_recheck',
});

export const RUN_SOURCE_VALUES = Object.freeze(Object.values(RUN_SOURCES));

/** @param {string} source @returns {boolean} whether a run of this source consumes a manual recrawl credit */
export function consumesRecrawlCredit(source) {
  return source === RUN_SOURCES.MANUAL_RECRAWL;
}
