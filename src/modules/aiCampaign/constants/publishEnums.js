/**
 * Google Ads Publish Pipeline — controlled vocabulary (Phase 6).
 *
 * Single source of truth for the publish-attempt lifecycle and the kinds of
 * Google Ads resources this pipeline creates. Deliberately its own file
 * (not added to aiCampaignEnums.js) — same "obviously a later-phase policy"
 * convention `constants/editableStatuses.js` and `constants/validationEnums.js`
 * already established.
 */

// ── Publish attempt status ────────────────────────────────────────────────
// pending      — attempt row exists, mutation has not started yet
// publishing   — this attempt currently holds the exclusive publish lock
//                for its (draftId, draftVersion) and is actively mutating
// published    — every planned resource was created successfully
// failed       — stopped with ZERO Google Ads resources created
// partially_published — stopped after SOME resources were created; the
//                exact set lives in `resources[]` — never silently reported
//                as `published` (spec §17)
export const PUBLISH_ATTEMPT_STATUSES = [
  'pending',
  'publishing',
  'published',
  'failed',
  'partially_published',
];

// Statuses a NEW publish request is allowed to resume/retry from. `publishing`
// is deliberately excluded — that status is the active lock itself, only the
// atomic claim (see publishAttemptService) may leave it.
export const RETRYABLE_ATTEMPT_STATUSES = ['pending', 'failed', 'partially_published'];

// Crash recovery (spec §42): if a process dies WHILE an attempt is
// `publishing` — before it ever reaches a terminal status — the lock would
// otherwise be held forever (nothing else transitions an attempt OUT of
// `publishing`). A `publishing` attempt whose `startedAt` is older than this
// is treated as abandoned and may be reclaimed by a fresh publish request,
// same as `failed`/`partially_published` (see publishAttemptService.claimPublishLock).
// A real, in-progress publish always completes in well under a minute (a
// handful of Google Ads mutate calls); this is set generously above that so
// a legitimately slow attempt is never preempted mid-flight.
export const PUBLISH_LOCK_STALE_MS = 10 * 60 * 1000;

export const PUBLISH_ATTEMPT_TRANSITIONS = Object.freeze({
  pending: ['publishing'],
  publishing: ['published', 'failed', 'partially_published'],
  failed: ['publishing'],
  partially_published: ['publishing'],
  published: [],
});

export function canTransitionPublishAttemptStatus(from, to) {
  if (from === to) return true;
  return (PUBLISH_ATTEMPT_STATUSES.includes(from) && PUBLISH_ATTEMPT_TRANSITIONS[from]?.includes(to)) || false;
}

// ── Resource types this pipeline creates, in their dependency order ───────
// (spec §14). CAMPAIGN_BUDGET and CAMPAIGN are created together, atomically,
// as one mutateResources batch — everything after is its own sequential step.
export const PUBLISH_RESOURCE_TYPES = [
  'CAMPAIGN_BUDGET',
  'CAMPAIGN',
  'CAMPAIGN_CRITERION_LOCATION',
  'CAMPAIGN_CRITERION_LANGUAGE',
  'AD_GROUP',
  'KEYWORD',
  'NEGATIVE_KEYWORD',
  'AD',
  // Campaign-level extension assets (Phase 9, RSA/Ad-Strength quality work) —
  // each row's googleResourceName is the ASSET resource name; the linking
  // CAMPAIGN_ASSET resource name isn't independently needed (it's derivable,
  // and never referenced again once created), so one row per asset is enough
  // — unlike CAMPAIGN_BUDGET/CAMPAIGN, which need two rows because Step 3
  // (ad groups) et al. reference the campaign resource name by itself.
  'SITELINK',
  'CALLOUT',
  'STRUCTURED_SNIPPET',
];

// ── Safe, classified failure codes surfaced to the frontend ───────────────
// Never a raw Google Ads / gRPC error — see campaignPublishService.js.
export const PUBLISH_ERROR_CODES = [
  'ACCOUNT_UNAVAILABLE',
  'AUTHORIZATION_FAILED',
  'VALIDATION_STALE',
  'VALIDATION_NOT_READY',
  'DRAFT_NOT_PUBLISHABLE',
  'DRAFT_CHANGED',
  'PUBLISH_ALREADY_IN_PROGRESS',
  'PUBLISH_ALREADY_COMPLETED',
  'TARGETING_UNRESOLVED',
  'PLAN_INVALID',
  'GOOGLE_QUOTA',
  'GOOGLE_POLICY',
  'GOOGLE_VALIDATION',
  'GOOGLE_NETWORK',
  'GOOGLE_UNKNOWN',
  'PARTIAL_PUBLISH',
  'RECONCILIATION_REQUIRED',
];

export default {
  PUBLISH_ATTEMPT_STATUSES,
  RETRYABLE_ATTEMPT_STATUSES,
  PUBLISH_ATTEMPT_TRANSITIONS,
  canTransitionPublishAttemptStatus,
  PUBLISH_RESOURCE_TYPES,
  PUBLISH_ERROR_CODES,
};
