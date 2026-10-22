/**
 * AI Campaign Change Proposal — controlled vocabulary (Phase 4).
 *
 * Single source of truth for the domain-level edit operations Claude may
 * propose and the campaign fields they may touch. This is the enforcement
 * mechanism for spec §5/§6/§7 ("no arbitrary paths"): a proposed change is
 * NEVER a string path that gets parsed/traversed — it is always
 * `{ operation, target, adGroupId?, adId?, before?, after? }`, where
 * `operation` and `target` are closed enums and PROPOSAL_OPERATION_MATRIX
 * is the only place that decides which (operation, target) pairs are legal.
 * campaignProposalApplier.js then applies each change with a hand-written
 * switch on `target` — there is no dynamic property access, no path
 * parsing, and nothing from the proposal is ever used as an object key or a
 * Mongo update path.
 *
 * The target list is deliberately drawn from the ACTUAL Phase 1 schema
 * (model/AiCampaignDraft.js) — nothing here is invented. Fields the schema
 * doesn't support (e.g. a campaign-level "finalUrl" — Phase 1 stores
 * finalUrl per-ad, not per-campaign) are intentionally absent.
 */

// ── Operations ─────────────────────────────────────────────────────────────
export const PROPOSAL_OPERATIONS = ['add', 'remove', 'replace'];

// ── Targets ────────────────────────────────────────────────────────────────
// Scalar campaign fields (targetId is always null; matched/replaced whole).
export const CAMPAIGN_SCALAR_TARGETS = [
  'CAMPAIGN_NAME',
  'CAMPAIGN_DAILY_BUDGET',
  'CAMPAIGN_BIDDING_STRATEGY',
  'CAMPAIGN_LOCATION',
  'CAMPAIGN_LANGUAGE',
];

// Ad-group-level targets. adGroupId identifies the parent ad group (or, for
// AD_GROUP `add`, is null — a new group carries no id yet).
export const AD_GROUP_TARGETS = ['AD_GROUP', 'AD_GROUP_NAME', 'KEYWORD', 'NEGATIVE_KEYWORD', 'AD'];

// Ad-level targets. adId identifies the parent ad within its ad group.
export const AD_TARGETS = ['AD_HEADLINE', 'AD_DESCRIPTION', 'AD_FINAL_URL'];

export const PROPOSAL_TARGETS = [...CAMPAIGN_SCALAR_TARGETS, ...AD_GROUP_TARGETS, ...AD_TARGETS];

/**
 * The allowed-operation matrix (spec §7). A change whose (target, operation)
 * pair is not listed here is rejected outright — never silently coerced.
 */
export const PROPOSAL_OPERATION_MATRIX = Object.freeze({
  CAMPAIGN_NAME: ['replace'],
  CAMPAIGN_DAILY_BUDGET: ['replace'],
  CAMPAIGN_BIDDING_STRATEGY: ['replace'],
  CAMPAIGN_LOCATION: ['replace'],
  CAMPAIGN_LANGUAGE: ['replace'],
  AD_GROUP: ['add', 'remove'],
  AD_GROUP_NAME: ['replace'],
  KEYWORD: ['add', 'remove'],
  NEGATIVE_KEYWORD: ['add', 'remove'],
  AD: ['add', 'remove'],
  AD_HEADLINE: ['add', 'remove', 'replace'],
  AD_DESCRIPTION: ['add', 'remove', 'replace'],
  AD_FINAL_URL: ['replace'],
});

/**
 * Whether (target, operation) is legal. Checks `target` against the
 * PROPOSAL_TARGETS allow-list FIRST, before any property access on
 * PROPOSAL_OPERATION_MATRIX — a plain object literal returns its real
 * prototype for `matrix['__proto__']` (not undefined), so an unguarded
 * lookup would let a Claude-supplied `target: "__proto__"` sail through as
 * "found" instead of being rejected. This is the concrete case spec §7/§52
 * warn about; PROPOSAL_TARGETS.includes() is a safe Array method and never
 * exhibits that behaviour.
 */
export function isOperationAllowedForTarget(target, operation) {
  if (!PROPOSAL_TARGETS.includes(target)) return false;
  return (PROPOSAL_OPERATION_MATRIX[target] || []).includes(operation);
}

/** Whether a target requires an `adGroupId` to resolve its parent ad group. */
export function targetRequiresAdGroupId(target) {
  return AD_GROUP_TARGETS.includes(target) && target !== 'AD_GROUP';
}
/** Whether a target requires an `adId` to resolve its parent ad. */
export function targetRequiresAdId(target) {
  return AD_TARGETS.includes(target);
}

// ── Proposal lifecycle ───────────────────────────────────────────────────
// generating → ready → accepted | rejected | stale | expired; failed is
// reachable from generating only (a Claude/parse/validation failure before
// any changes exist to review). stale/expired are computed at accept-time
// (spec §27 — "a simple status/freshness check is sufficient", no scheduled
// cleanup job) and then persisted so the record doesn't need recomputing.
export const PROPOSAL_STATUSES = ['generating', 'ready', 'accepted', 'rejected', 'stale', 'expired', 'failed'];
export const DEFAULT_PROPOSAL_STATUS = 'generating';

export const PROPOSAL_STATUS_TRANSITIONS = Object.freeze({
  generating: ['ready', 'failed'],
  // 'failed' from 'ready' is the rare case where the individual changes all
  // validated fine but re-applying them at accept time still failed the
  // complete-campaign validator (spec §12) — fail closed rather than pretend
  // the proposal never existed.
  ready: ['accepted', 'rejected', 'stale', 'expired', 'failed'],
  accepted: [],
  rejected: [],
  stale: [],
  expired: [],
  failed: [],
});

export function canTransitionProposalStatus(from, to) {
  if (from === to) return true;
  // Same defensive-lookup rationale as isOperationAllowedForTarget above —
  // `from` is always Mongoose-enum-constrained in practice, but the guard
  // is free and keeps this function safe to call with any input.
  if (!PROPOSAL_STATUSES.includes(from)) return false;
  return (PROPOSAL_STATUS_TRANSITIONS[from] || []).includes(to);
}

/** Max number of changes accepted in a single proposal — abuse / review-size guard. */
export const PROPOSAL_MAX_CHANGES = 30;
