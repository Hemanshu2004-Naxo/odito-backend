// Verification Batch lifecycle status (F4-012 — infrastructure only).
//
// PENDING     — batch document created, no PageVerificationRun has reached
//               a terminal state yet.
// RUNNING     — at least one member PageVerificationRun is actively
//               verifying (reserved for later-phase orchestration; this
//               phase never sets it).
// AGGREGATING — all member PageVerificationRuns reached a terminal state
//               (completed/failed) and project-wide aggregation (SEO/AI/
//               Task Verification) is in progress (F4-011 Phase 4/5 — not
//               implemented yet).
// COMPLETED   — every URL in the batch succeeded.
// PARTIAL     — some URLs succeeded, some failed.
// FAILED      — every URL in the batch failed.
//
// A single source of truth so no caller ever hardcodes these strings.
export const BATCH_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  AGGREGATING: 'aggregating',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

export const BATCH_STATUSES = Object.values(BATCH_STATUS);
