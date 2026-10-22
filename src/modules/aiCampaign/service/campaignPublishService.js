/**
 * campaignPublishService — Phase 6: Google Ads Publish Pipeline orchestrator
 * (spec §1-§10, §40).
 *
 *   publishDraft: assertDraftPublishable → resolve Google Ads account →
 *     claim the atomic publish lock → bind to the exact draft version →
 *     build the deterministic plan → execute it (googleAdsPublishProvider,
 *     via publishExecutor) → finalize (draft + attempt)
 *
 * CORE RULE (spec §3): Claude proposes, Odito validates, the user
 * explicitly approves (this endpoint is only ever called by an authenticated
 * user's own explicit request — never by Claude, never automatically), Odito
 * publishes, Google Ads executes. This file is the ONLY code path in the
 * whole codebase allowed to reach a Google Ads mutation for an AiCampaignDraft.
 *
 * REUSES PHASE 5, NEVER DUPLICATES IT (spec §43): readiness is decided
 * entirely by reading the persisted `AiCampaignValidationResult` via
 * campaignValidationService.getLatestValidationResult() — this file
 * contains no validation rule of its own. A stale or non-ready result is
 * rejected outright; Phase 6 never silently re-runs or reinterprets Phase
 * 5's rules to "make publishing easier."
 *
 * ARCHITECTURE (spec §16/§40): this orchestrator only sequences collaborators
 * — it authenticates nothing itself (the controller + AuthUtil upstream
 * already did that), builds no GAQL, and issues no Google Ads mutation
 * directly:
 *   readiness      → campaignValidationService (Phase 5, reused as-is)
 *   account        → GoogleConnection + googleAdsService (reused as-is)
 *   idempotency/
 *   concurrency     → service/publish/publishAttemptService.js
 *   targeting       → service/publish/targetingResolver.js
 *   plan            → service/publish/publishPlanBuilder.js
 *   mutation        → service/publish/publishExecutor.js → providers/googleAdsPublishProvider.js
 */

import { LoggerUtil } from '../../../utils/LoggerUtil.js';

import campaignDraftService from './campaignDraftService.js';
import campaignValidationService from './campaignValidationService.js';
import { EDITABLE_DRAFT_STATUSES } from '../constants/editableStatuses.js';
import { RETRYABLE_ATTEMPT_STATUSES, PUBLISH_LOCK_STALE_MS } from '../constants/publishEnums.js';

import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import googleAdsService from '../../../services/googleAdsService.js';

import * as publishAttemptService from './publish/publishAttemptService.js';
import { resolveTargeting, TargetingResolutionError } from './publish/targetingResolver.js';
import { buildGoogleAdsPublishPlan, summarizePlan, PublishPlanError } from './publish/publishPlanBuilder.js';
import { executePublishPlan, PublishExecutionError } from './publish/publishExecutor.js';
import realProvider from '../providers/googleAdsPublishProvider.js';

const GOOGLE_ADS_PURPOSE = 'google_ads';

export class CampaignPublishError extends Error {
  constructor(code, httpStatus, message, details = null) {
    super(message);
    this.name = 'CampaignPublishError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.type = 'CAMPAIGN_PUBLISH_ERROR';
    if (details) this.details = details;
  }
}

// ── provider seam (mirrors campaignGenerationService.js / campaignProposalService.js) ──
// Combines the real Google Ads mutation provider with the (also-real, also
// network-dependent) targeting resolver behind ONE injectable surface, so
// tests can swap in a single mock with zero network/Mongo.
const DEFAULT_PROVIDER = { ...realProvider, resolveTargeting };
let _providerOverride = null;
export function setProviderOverride(provider) { _providerOverride = provider || null; }
export function resetProviderOverride() { _providerOverride = null; }
function getProvider() { return _providerOverride || DEFAULT_PROVIDER; }

const resourceNameToId = (resourceName) => (resourceName ? resourceName.split('/').pop() : null);

/**
 * Copy a `published` attempt's resolved resource ids onto the draft. Called
 * both right after a successful publish AND as a self-healing step on an
 * idempotent replay (spec §42 — if the process crashed between marking the
 * attempt `published` and finishing this exact write, the draft would
 * otherwise be stuck showing stale ids/status forever; a replay heals it
 * instead of silently returning an inconsistent "already published" result).
 * Never re-derives ids from anywhere but the attempt's own persisted
 * `resources[]` — never re-touches Google Ads.
 */
async function finalizeDraftAsPublished(draftId, attempt) {
  const draft = await campaignDraftService.getDraft(draftId);
  const resources = attempt.resources || [];
  const campaignId = resourceNameToId(resources.find((r) => r.type === 'CAMPAIGN')?.googleResourceName);
  const adGroupIds = resources.filter((r) => r.type === 'AD_GROUP').map((r) => resourceNameToId(r.googleResourceName));
  const adIds = resources.filter((r) => r.type === 'AD').map((r) => resourceNameToId(r.googleResourceName));

  if (draft.status === 'published' && draft.googleAdsCampaignId === campaignId) {
    return draft; // already fully finalized — nothing to heal
  }

  if (draft.status !== 'published') {
    if (draft.status !== 'publishing') {
      // Best-effort: walk whatever legal hops remain to reach 'publishing',
      // mirroring the main flow's own ordering.
      await moveDraftIntoPublishing(draft).catch(() => {});
    }
    await campaignDraftService.transitionStatus(draftId, 'published');
  }

  const reloaded = await campaignDraftService.getDraft(draftId);
  reloaded.googleAdsCampaignId = campaignId;
  reloaded.googleAdsAdGroupIds = adGroupIds;
  reloaded.googleAdsAdIds = adIds;
  if (!reloaded.publishedAt) reloaded.publishedAt = new Date();
  await reloaded.save();
  return reloaded;
}

/**
 * Walk the draft through whatever LEGAL, already-existing transitions
 * (aiCampaignEnums.DRAFT_STATUS_TRANSITIONS) are needed to reach
 * 'publishing'. Three starting points are legal here:
 *   draft/ready/validated — the normal, first-ever publish
 *   failed                — a RETRY after a prior publish attempt failed
 *                            partway through (spec §43 — `failed -> publishing`
 *                            is a narrow, documented, additive transition
 *                            added specifically for this; see aiCampaignEnums.js)
 * Nothing here invents a status; every hop below was already legal in the
 * (now slightly extended) table before this function existed.
 */
async function moveDraftIntoPublishing(draft) {
  let current = draft;
  if (current.status === 'draft') current = await campaignDraftService.transitionStatus(current._id, 'ready');
  if (current.status === 'ready') current = await campaignDraftService.transitionStatus(current._id, 'validated');
  if (current.status === 'validated' || current.status === 'failed') {
    current = await campaignDraftService.transitionStatus(current._id, 'publishing');
  }
  return current;
}

/**
 * True when this draft is allowed to (re-)enter publishing despite not
 * being in EDITABLE_DRAFT_STATUSES, covering two cases — both require a
 * publish attempt to already exist AT THE DRAFT'S CURRENT VERSION:
 *   - `failed`: the failure came from a Phase 6 publish attempt (not, say,
 *     a Phase 2 generation failure) that is itself retryable.
 *   - `publishing`: a PRIOR attempt's lock has gone stale (spec §42 — the
 *     process that claimed it almost certainly crashed; see
 *     PUBLISH_LOCK_STALE_MS). A still-genuinely-active publish (fresh
 *     `startedAt`) is NOT retryable here — it must fail fast instead.
 */
async function isRetryablePublishState(draft, { projectId }) {
  if (draft.status !== 'failed' && draft.status !== 'publishing') return false;
  const attempt = await publishAttemptService.getLatestAttempt({ draftId: draft._id, projectId });
  if (!attempt || attempt.draftVersion !== draft.version) return false;
  if (RETRYABLE_ATTEMPT_STATUSES.includes(attempt.status)) return true;
  if (attempt.status === 'publishing' && attempt.startedAt) {
    return Date.now() - new Date(attempt.startedAt).getTime() > PUBLISH_LOCK_STALE_MS;
  }
  return false;
}

/**
 * The single authoritative "is this draft allowed to publish right now"
 * check (spec §5). Reads Phase 5's persisted result; never re-derives
 * readiness rules itself. Does NOT handle `published`/`publishing` — those
 * are short-circuited earlier in publishDraft() itself (idempotent replay /
 * fast-fail respectively), before this function (and its Google Ads account
 * checks further down) ever runs.
 */
async function assertDraftPublishable(draft, { projectId }) {
  const retryable = await isRetryablePublishState(draft, { projectId });
  if (!EDITABLE_DRAFT_STATUSES.includes(draft.status) && !retryable) {
    throw new CampaignPublishError('DRAFT_NOT_PUBLISHABLE', 400, `A campaign in status "${draft.status}" cannot be published.`);
  }

  const validation = await campaignValidationService.getLatestValidationResult({ draftId: draft._id, projectId });
  if (!validation) {
    throw new CampaignPublishError('VALIDATION_NOT_READY', 400, 'This campaign has not been checked for readiness yet. Check readiness before publishing.');
  }
  if (!validation.isCurrent) {
    throw new CampaignPublishError('VALIDATION_STALE', 409, 'This campaign has changed since it was last checked. Re-check readiness before publishing.');
  }
  if (validation.status !== 'ready') {
    throw new CampaignPublishError('VALIDATION_NOT_READY', 400, 'This campaign is not ready to publish yet. Fix the readiness errors first.');
  }
  return validation;
}

/** Resolve + live-validate the Google Ads account (spec §6). Never mutates anything. */
async function resolveAndVerifyAccount(draft, { userId, projectId }) {
  const connection = await GoogleConnection.findActiveConnection(userId, projectId, GOOGLE_ADS_PURPOSE);
  if (!connection || !connection.google_ads_customer_id) {
    throw new CampaignPublishError('ACCOUNT_UNAVAILABLE', 400, 'No connected Google Ads account is available for this project. Connect Google Ads before publishing.');
  }
  if (connection.google_ads_customer_id !== draft.googleAdsCustomerId) {
    throw new CampaignPublishError('ACCOUNT_UNAVAILABLE', 409, 'The connected Google Ads account has changed since this campaign was drafted. Regenerate or update the draft first.');
  }

  let info;
  try {
    info = await googleAdsService.validateGoogleAdsAccountAccess(
      connection,
      connection.google_ads_customer_id,
      connection.google_ads_login_customer_id,
    );
  } catch (err) {
    throw new CampaignPublishError('ACCOUNT_UNAVAILABLE', 502, 'Could not verify the connected Google Ads account. Please try again.', { cause: err?.message });
  }

  if (info.isManager) {
    throw new CampaignPublishError('ACCOUNT_UNAVAILABLE', 400, 'Campaigns cannot be published directly to a Google Ads manager (MCC) account. Select a client account.');
  }
  if (info.status && info.status !== 'ENABLED') {
    throw new CampaignPublishError('ACCOUNT_UNAVAILABLE', 400, `The connected Google Ads account is not active (status: ${info.status}).`);
  }

  return { connection, customerId: connection.google_ads_customer_id, loginCustomerId: connection.google_ads_login_customer_id || null, info };
}

function mapPreflightError(err) {
  if (err.type === 'CAMPAIGN_PUBLISH_ERROR') return err;
  if (err instanceof TargetingResolutionError) return new CampaignPublishError('TARGETING_UNRESOLVED', 400, err.message, err.details);
  if (err instanceof PublishPlanError) return new CampaignPublishError('PLAN_INVALID', 400, err.message, err.details);
  if (err?.category === 'quota') return new CampaignPublishError('GOOGLE_QUOTA', 429, 'Google Ads is rate-limiting this account right now. Please try again shortly.');
  if (err?.category === 'authentication' || err?.category === 'authorization') {
    return new CampaignPublishError('AUTHORIZATION_FAILED', 403, 'Google Ads denied access. Please reconnect Google Ads.');
  }
  return new CampaignPublishError('GOOGLE_UNKNOWN', 500, 'Publishing failed unexpectedly. Nothing was changed. Please try again.');
}

/**
 * @param {object} args
 * @param {string} args.draftId
 * @param {string} args.userId
 * @param {string} args.projectId
 * @returns {Promise<{attempt: object, draft: object, alreadyPublished?: boolean}>}
 */
export async function publishDraft({ draftId, userId, projectId }) {
  const provider = getProvider();
  const draft = await campaignDraftService.getDraft(draftId);

  // `published`/`publishing` are short-circuited BEFORE assertDraftPublishable
  // (and before any account resolution) — a duplicate "publish" click on an
  // already-published draft is a normal idempotent replay (spec §8), not an
  // error. A draft mid-publish fails fast UNLESS its lock has gone stale
  // (spec §42 — the process that claimed it almost certainly crashed), in
  // which case it falls through to the normal flow, which is able to
  // reclaim it (see isRetryablePublishState / claimPublishLock).
  if (draft.status === 'publishing' && !(await isRetryablePublishState(draft, { projectId }))) {
    throw new CampaignPublishError('PUBLISH_ALREADY_IN_PROGRESS', 409, 'This campaign is already being published.');
  }
  if (draft.status === 'published') {
    const latestAttempt = await publishAttemptService.getLatestAttempt({ draftId, projectId });
    if (latestAttempt?.status === 'published') {
      LoggerUtil.info('AI campaign publish: idempotent no-op (already published)', { draftId: String(draftId), attemptId: String(latestAttempt._id) });
      const healedDraft = await finalizeDraftAsPublished(draftId, latestAttempt);
      return { attempt: latestAttempt, draft: healedDraft.toObject(), alreadyPublished: true };
    }
    throw new CampaignPublishError('PUBLISH_ALREADY_COMPLETED', 409, 'This campaign has already been published.');
  }

  await assertDraftPublishable(draft, { projectId });
  const { connection, customerId, loginCustomerId } = await resolveAndVerifyAccount(draft, { userId, projectId });

  const draftVersion = draft.version;
  let attempt = await publishAttemptService.findOrCreateAttempt({ projectId, draftId, draftVersion, userId, customerId, loginCustomerId });

  if (attempt.status === 'published') {
    LoggerUtil.info('AI campaign publish: idempotent no-op (already published)', { draftId: String(draftId), draftVersion, attemptId: String(attempt._id) });
    const healedDraft = await finalizeDraftAsPublished(draftId, attempt);
    return { attempt: attempt.toObject ? attempt.toObject() : attempt, draft: healedDraft.toObject(), alreadyPublished: true };
  }

  const claimed = await publishAttemptService.claimPublishLock(attempt._id);
  if (!claimed) {
    throw new CampaignPublishError('PUBLISH_ALREADY_IN_PROGRESS', 409, 'This campaign is already being published.');
  }
  attempt = claimed;

  LoggerUtil.info('AI campaign publish requested', { attemptId: String(attempt._id), draftId: String(draftId), draftVersion, customerId });

  // Version binding (spec §10) — re-confirm nothing changed the draft between
  // the validation-freshness check above and acquiring the lock just now.
  const freshDraft = await campaignDraftService.getDraft(draftId);
  if (freshDraft.version !== draftVersion) {
    await publishAttemptService.markFailed(attempt._id, { code: 'DRAFT_CHANGED', message: 'The campaign changed after this publish attempt started.', hasResources: false });
    throw new CampaignPublishError('DRAFT_CHANGED', 409, 'This campaign changed after publishing started. Re-check readiness and try again.');
  }

  await moveDraftIntoPublishing(freshDraft);

  let plan;
  let customer;
  try {
    customer = await provider.buildPublishCustomer(connection, { customerId, loginCustomerId });
    const resolvedTargeting = await provider.resolveTargeting(customer, {
      locations: freshDraft.campaign.locations,
      languages: freshDraft.campaign.languages,
    });
    plan = buildGoogleAdsPublishPlan(freshDraft.toObject(), { customerId, loginCustomerId }, resolvedTargeting);
  } catch (err) {
    const mapped = mapPreflightError(err);
    await publishAttemptService.markFailed(attempt._id, { code: mapped.code, message: mapped.message, hasResources: false });
    await campaignDraftService.transitionStatus(draftId, 'failed');
    throw mapped;
  }

  LoggerUtil.info('AI campaign publish plan built', { attemptId: String(attempt._id), draftId: String(draftId), ...summarizePlan(plan) });

  try {
    await executePublishPlan({ provider, publishAttemptService, customer, plan, attempt });
  } catch (err) {
    const isExecError = err instanceof PublishExecutionError;
    const code = isExecError ? err.code : 'GOOGLE_UNKNOWN';
    const hasResources = isExecError ? err.partial : false;
    await publishAttemptService.markFailed(attempt._id, { code, message: err.message, hasResources });
    await campaignDraftService.transitionStatus(draftId, 'failed');
    LoggerUtil.error('AI campaign publish failed', err, { attemptId: String(attempt._id), draftId: String(draftId), code, hasResources });
    throw new CampaignPublishError(hasResources ? 'PARTIAL_PUBLISH' : code, hasResources ? 409 : 502, hasResources
      ? 'Publishing stopped partway through. Some resources were created in Google Ads — contact support before retrying.'
      : 'Publishing failed. Nothing was created in Google Ads. Please try again.');
  }

  const finalAttempt = await publishAttemptService.markPublished(attempt._id);
  const publishedDraft = await finalizeDraftAsPublished(draftId, finalAttempt);

  LoggerUtil.info('AI campaign published', {
    attemptId: String(attempt._id), draftId: String(draftId), draftVersion, customerId,
    campaignId: publishedDraft.googleAdsCampaignId,
    adGroupCount: publishedDraft.googleAdsAdGroupIds.length,
    adCount: publishedDraft.googleAdsAdIds.length,
  });

  return { attempt: finalAttempt.toObject ? finalAttempt.toObject() : finalAttempt, draft: publishedDraft.toObject() };
}

export async function getPublishStatus({ draftId, projectId }) {
  const draft = await campaignDraftService.getDraft(draftId);
  const latest = await publishAttemptService.getLatestAttempt({ draftId, projectId });
  return { draft: draft.toObject(), attempt: latest || null };
}

export default { publishDraft, getPublishStatus, setProviderOverride, resetProviderOverride, CampaignPublishError };
