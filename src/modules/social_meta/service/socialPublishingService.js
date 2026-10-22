import mongoose from 'mongoose';
import SocialPublication from '../model/SocialPublication.js';
import { isPublishingReady } from '../model/SocialAccount.js';
import adapters from './platformAdapters/index.js';
import mediaStorageService from './media/mediaStorageService.js';
import { isValidIanaZone } from './bulkImport/bulkImportTime.js';
import {
  resolveAccount, recordPublished, attachPermalink, settleFailure, reconcileUnknownPublication, getInstanceId, RECONNECT_REQUIRED_CODES, NOT_RETRYABLE_FAILURE_CODES,
} from './publicationLifecycle.js';
import { markAccountExpired } from './metaTokenService.js';
import { recordPublish } from '../../../monitoring/socialAiMetrics.js';
import { markMissedPublications } from './socialPublishRecoveryService.js';
import { getPublishConfig } from './socialPublishConfig.js';
import { getProjectState, activeProjectScope, PROJECT_STATES } from './projectLifecycleGuard.js';
import workflow, {
  PUBLISHABLE_APPROVAL_STATES, APPROVAL_STATES, isApprovalSatisfied, approvalGateError, approvalStageOf, needsChanges, planEditEffects,
} from './approvalWorkflow.js';
import User from '../../user/model/User.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialPublishingService — the ONLY place that creates/edits/publishes a
 * SocialPublication. Mirrors this module's established layering: no HTTP
 * here (the controller owns that), no raw Graph API calls here (the
 * platformAdapters/ own that) — this file is orchestration + persistence,
 * same role facebookAccountService.js and socialSyncService.js play for
 * their own domains. Lock/finalize/retry/reconciliation transitions live in
 * publicationLifecycle.js (shared with the recovery sweeps).
 */

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/**
 * Validates a `media` array's shape AND that every url actually belongs to
 * Odito's own upload pipeline (mediaStorageService) — never an arbitrary
 * caller-supplied URL. Without this, an authenticated client could pass
 * any string as media[].url and it would be handed straight to Meta's
 * Graph API as image_url/video_url; Meta itself would fetch it (never
 * Odito), but Odito's own storage layer is meant to be the only source
 * for media it publishes, so this closes that gap. Returns `{ error }` on
 * failure, `{}` when valid — never throws.
 */
function validateMedia(media) {
  if (media === undefined) return {};
  if (!Array.isArray(media)) {
    return { error: { code: 'INVALID_MEDIA', message: 'media must be an array.' } };
  }
  for (const item of media) {
    if (!item || typeof item.url !== 'string' || !['image', 'video'].includes(item.type)) {
      return { error: { code: 'INVALID_MEDIA', message: 'Each media item needs a url and a type of "image" or "video".' } };
    }
    if (!mediaStorageService.isOwnedUrl(item.url)) {
      return { error: { code: 'INVALID_MEDIA', message: 'Media must be uploaded through Odito\'s own upload endpoint.' } };
    }
  }
  return {};
}

/**
 * What each platform needs to be PUBLISHED, mirrored from the platform adapters (which enforce it at publish time and
 * only forward the URL to Meta): Instagram has no text-only post, and both platforms take a single image/video per post
 * in this phase. Checked when a post is SCHEDULED so a post that could never go out is refused now, with a clear
 * message, instead of failing at its publish time. The adapters stay the final authority.
 */
const MEDIA_REQUIREMENTS = { instagram: { min: 1, max: 1 }, facebook: { min: 0, max: 1 } };

function mediaRequirementError(platform, media) {
  const rule = MEDIA_REQUIREMENTS[platform];
  const count = Array.isArray(media) ? media.length : 0;
  if (!rule) return null;
  if (count < rule.min) {
    return { code: 'MEDIA_REQUIRED', message: `${platform === 'instagram' ? 'Instagram' : 'This platform'} posts need an image or video. Add or generate a design before scheduling.` };
  }
  if (count > rule.max) {
    return { code: 'MEDIA_NOT_SUPPORTED', message: 'Only a single image or video is supported per post in this phase.' };
  }
  return null;
}

/**
 * Can this post actually be scheduled right now? (beyond approval, which approvalGateError owns)
 *  - its media satisfies the platform requirement;
 *  - its social account is still connected and healthy (existing resolveAccount rules - expired/disconnected are refused).
 * No Meta call is made: this reads Odito's own account record only.
 */
async function schedulingReadinessError(doc, media) {
  const mediaError = mediaRequirementError(doc.platform, media);
  if (mediaError) return mediaError;
  // Media is fetched BY META from the public internet, so every attached file must be a stored Odito file on the public HTTPS
  // media origin. Refused here, clearly and before any Meta call, rather than failing on every publish attempt.
  for (const item of Array.isArray(media) ? media : []) {
    const problem = mediaStorageService.publishableMediaProblem(item.url);
    if (problem) {
      return { code: 'MEDIA_URL_NOT_PUBLIC', message: 'Image and video publishing requires a publicly reachable HTTPS media URL. This environment\'s media address cannot be fetched by Facebook or Instagram, so this post cannot be scheduled with its media. Text-only posts are unaffected.' };
    }
    if (!(await mediaStorageService.storedMediaExists(item.url))) {
      return { code: 'MEDIA_FILE_MISSING', message: 'The media file for this post is missing from storage. Upload or generate the design again.' };
    }
  }
  const resolved = await resolveAccount(doc.project_id, doc.platform, String(doc.social_account_id));
  return resolved.error || null;
}

/** Structured schedule event: safe identifiers only (no caption, token, prompt or credential). */
function logSchedule(event, doc, extra = {}) {
  const fields = {
    event,
    projectId: String(doc.project_id),
    publicationId: String(doc._id || doc.id),
    platform: doc.platform,
    contentVersion: doc.contentVersion ?? null,
    designVersion: doc.designVersion ?? null,
    ...extra,
  };
  if (event.endsWith('rejected')) LoggerUtil.warn('[SOCIAL_SCHEDULE]', fields);
  else LoggerUtil.info('[SOCIAL_SCHEDULE]', fields);
}

/** Order-sensitive identity of a media list - what "the design changed" means. */
function mediaSignature(media) {
  return JSON.stringify((media || []).map((m) => [m.type, m.url]));
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches an ISO 8601 datetime with an EXPLICIT offset ("Z" or "+05:30")
// only — never a bare "2026-08-22T11:30:00". A naive string like that has
// no timezone information at all, so `new Date(...)` would silently parse
// it using this SERVER PROCESS's own local timezone (whatever machine/
// container it happens to be running in that day) rather than the
// timezone the user actually selected in the UI. Rejecting it here forces
// every caller (CreatePostDialog via lib/scheduleTime.js's luxon-based
// conversion) to always send a real, unambiguous absolute instant.
const ABSOLUTE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses `scheduledAt` into a Date, requiring it to be an absolute,
 * timezone-explicit ISO string that is STRICTLY IN THE FUTURE. The past-date
 * check is authoritative here, server-side, for every scheduling entry point
 * (create, PATCH, /schedule) — the frontend date input is only a UX hint.
 * No clock-skew tolerance: the comparison is against THIS server's clock and
 * the client sends an absolute instant (never a "now"), so client clock skew
 * cannot make a legitimate future time look past.
 *
 * `allowPast` exists ONLY for internal callers that deliberately create an
 * immediately-due post (bulk import's "publish" action stamps now+1s, which
 * can already be past by the time it is validated) — it is never reachable
 * from an HTTP body. Returns `{ error }` (never throws).
 */
function parseAbsoluteScheduledAt(scheduledAt, { now = new Date(), allowPast = false } = {}) {
  if (typeof scheduledAt !== 'string' || !ABSOLUTE_ISO_RE.test(scheduledAt)) {
    return { error: { code: 'INVALID_SCHEDULE', message: 'scheduledAt must be an absolute ISO datetime with an explicit UTC offset (e.g. 2026-08-22T06:00:00.000Z).' } };
  }
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    return { error: { code: 'INVALID_SCHEDULE', message: 'scheduledAt is not a valid date.' } };
  }
  // JS silently ROLLS an impossible day over ("2031-02-30" -> March 2), which would schedule the post on a day the
  // user never chose. The calendar day written in the string must exist.
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(scheduledAt);
  if (Number(d) < 1 || Number(d) > new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()) {
    return { error: { code: 'INVALID_SCHEDULE', message: 'scheduledAt is not a valid date.' } };
  }
  if (!allowPast && scheduledDate.getTime() <= now.getTime()) {
    return { error: { code: 'SCHEDULE_IN_PAST', message: 'scheduledAt must be in the future. Pick a later time, or use Publish Now to post immediately.' } };
  }
  return { scheduledDate };
}

/** `timezone` is informational (the zone the user picked); when given it must at least be a real IANA zone. */
function validateTimezone(timezone) {
  if (timezone === undefined || timezone === null || timezone === '') return {};
  if (typeof timezone !== 'string' || timezone.length > 100 || !isValidIanaZone(timezone)) {
    return { error: { code: 'INVALID_TIMEZONE', message: 'timezone must be a valid IANA timezone name such as "Asia/Kolkata".' } };
  }
  return {};
}

const SORTABLE = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// A publication can only move INTO 'publishing' from one of these states —
// 'failed' is included so the History tab's "Retry" action reuses this
// exact same, atomically-guarded path rather than a separate one.
const PUBLISHABLE_FROM = ['draft', 'scheduled', 'failed'];
const EDITABLE_STATUSES = ['draft', 'scheduled'];
const DELETABLE_STATUSES = ['draft', 'scheduled', 'failed', 'cancelled', 'published'];
const CANCELLABLE_STATUSES = ['draft', 'scheduled'];

// Cleared whenever a person (re)schedules or unschedules a post: its previous
// retry history no longer describes the new schedule.
const RETRY_STATE_RESET = { attempts: 0, nextRetryAt: null, lastError: null, lastErrorCode: null };

/**
 * Whether a manual "Retry Publish" of this post is SAFE and can reasonably
 * succeed — decided here, once, so no client has to re-implement (and risk
 * contradicting) the retry rules. False for: anything not 'failed'; an
 * unknown outcome (re-sending could duplicate the post); a failure that needs
 * the user to reconnect/re-authorize; invalid content/media/account setup; and
 * a failure the classifier recorded as permanent. Publishing itself still
 * enforces the unknown-outcome gate server-side regardless of this flag.
 */
export function isSafelyRetryable(doc) {
  if (doc.status !== 'failed') return false;
  // Failed only because approval was missing: retryable exactly when it is no longer missing.
  if (doc.failureCode === 'APPROVAL_REQUIRED') return isApprovalSatisfied(doc);
  if (doc.outcomeUnknown) return false;
  if (RECONNECT_REQUIRED_CODES.has(doc.failureCode)) return false;
  if (NOT_RETRYABLE_FAILURE_CODES.has(doc.failureCode)) return false;
  if (doc.failureRetryable === false) return false;
  return true;
}

const idOrNull = (v) => (v ? String(v) : null);

/**
 * The approval-workflow view of a publication. `stage` is the product-facing
 * stage (content_review ... ready_to_schedule | scheduled | published ...);
 * `publishable` is the backend's own verdict (the scheduler/publish path
 * enforces exactly this). Actor ids only — names are attached by
 * decorateActors(). `managed:false` means the post never entered the workflow.
 */
function toApiApproval(doc) {
  return {
    managed: !!doc.approvalState,
    state: doc.approvalState || null,
    stage: approvalStageOf(doc),
    publishable: isApprovalSatisfied(doc),
    needsChanges: needsChanges(doc),
    contentVersion: doc.contentVersion || 1,
    designVersion: doc.designVersion || 1,
    submittedAt: doc.submittedForReviewAt || null,
    submittedBy: idOrNull(doc.submittedBy),
    designSubmittedAt: doc.designSubmittedAt || null,
    designSubmittedBy: idOrNull(doc.designSubmittedBy),
    contentApprovedAt: doc.contentApprovedAt || null,
    contentApprovedBy: idOrNull(doc.contentApprovedBy),
    contentApprovedVersion: doc.contentApprovedVersion ?? null,
    designApprovedAt: doc.designApprovedAt || null,
    designApprovedBy: idOrNull(doc.designApprovedBy),
    designApprovedVersion: doc.designApprovedVersion ?? null,
    changesRequested: doc.changesRequestedAt
      ? { stage: doc.changesRequestedStage, at: doc.changesRequestedAt, by: idOrNull(doc.changesRequestedBy), reason: doc.changesRequestedReason, forVersion: doc.changesRequestedForVersion }
      : null,
  };
}

/** Adds human-readable actor names (one batched User lookup) to the approval block of managed posts. */
async function decorateActors(apiPublications) {
  const ids = new Set();
  const keys = ['submittedBy', 'designSubmittedBy', 'contentApprovedBy', 'designApprovedBy'];
  for (const p of apiPublications) {
    if (!p.approval?.managed) continue;
    for (const k of keys) if (p.approval[k]) ids.add(p.approval[k]);
    if (p.approval.changesRequested?.by) ids.add(p.approval.changesRequested.by);
  }
  if (ids.size === 0) return apiPublications;
  const users = await User.find({ _id: { $in: [...ids] } }).select('firstName lastName').lean();
  const nameOf = new Map(users.map((u) => [String(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim() || null]));
  for (const p of apiPublications) {
    if (!p.approval?.managed) continue;
    for (const k of keys) p.approval[`${k}Name`] = p.approval[k] ? (nameOf.get(p.approval[k]) || null) : null;
    if (p.approval.changesRequested) p.approval.changesRequested.byName = nameOf.get(p.approval.changesRequested.by) || null;
  }
  return apiPublications;
}

/** Safe provenance for the UI: where the text came from and what it was written for. No hash, prompt or provider data. */
function toApiGeneration(doc) {
  const g = doc.generation;
  if (!g || (g.source !== 'ai' && g.source !== 'calendar_plan')) return null;
  const base = { source: g.source, type: g.type || (g.source === 'ai' ? 'social_content' : 'calendar_item'), strategyVersion: g.strategyVersion ?? null, contentPillar: g.contentPillar || null, objective: g.objective || null };
  return g.source === 'calendar_plan' ? { ...base, planRevision: g.planRevision ?? null, planApprovedAt: g.planApprovedAt || null } : base;
}

/** Safe provenance of the current design (only while it still describes the media): no prompt, no provider data. */
function toApiDesign(doc) {
  const d = doc.design;
  if (!d || d.source !== 'ai' || d.designVersion !== doc.designVersion) return null;
  return { source: 'ai', designVersion: d.designVersion, contentVersion: d.contentVersion ?? null, generatedAt: d.generatedAt || null };
}

function toApiPublication(doc) {
  return {
    id: doc._id.toString(),
    socialAccountId: doc.social_account_id.toString(),
    platform: doc.platform,
    externalPostId: doc.externalPostId,
    permalink: doc.permalink || null,
    content: doc.content,
    media: doc.media,
    status: doc.status,
    scheduledAt: doc.scheduledAt,
    timezone: doc.timezone || null,
    publishedAt: doc.publishedAt,
    failedAt: doc.failedAt,
    failureReason: doc.failureReason,
    failureCode: doc.failureCode || null,
    // Reliability metadata — safe, user-facing text/codes only.
    attempts: doc.attempts || 0,
    nextRetryAt: doc.nextRetryAt || null,
    outcomeUnknown: !!doc.outcomeUnknown,
    lastError: doc.lastError || null,
    lastErrorCode: doc.lastErrorCode || null,
    // True when the only fix is re-authorizing the Meta connection.
    requiresReconnect: doc.status === 'failed' && RECONNECT_REQUIRED_CODES.has(doc.failureCode),
    canRetry: isSafelyRetryable(doc),
    approval: toApiApproval(doc),
    generation: toApiGeneration(doc),
    design: toApiDesign(doc),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** The error shape callers/HTTP responses get: safe fields only (never accountAction/Meta internals). */
function toSafeError(error) {
  return {
    code: error?.code || 'PUBLISH_FAILED',
    message: error?.message || 'Publishing failed.',
    ...(error?.category ? { category: error.category } : {}),
    ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    requiresReconnect: !!error?.requiresReconnect || RECONNECT_REQUIRED_CODES.has(error?.code),
  };
}

export async function listPublications(projectId, { platform, status, search, from, to, approval, sort = 'newest', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  const query = { project_id: toObjectId(projectId) };
  // approval: 'managed' (in the workflow) | 'unmanaged' | one approvalState value.
  if (approval === 'managed') query.approvalState = { $in: APPROVAL_STATES };
  else if (approval === 'unmanaged') query.approvalState = null;
  else if (APPROVAL_STATES.includes(approval)) query.approvalState = approval;
  if (platform) query.platform = platform;
  if (status) query.status = status;
  if (search) query.content = { $regex: escapeRegex(search), $options: 'i' };
  if (from || to) {
    query.scheduledAt = {};
    if (from) query.scheduledAt.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) query.scheduledAt.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  const sortSpec = SORTABLE[sort] || SORTABLE.newest;

  const [docs, total] = await Promise.all([
    SocialPublication.find(query).sort(sortSpec).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    SocialPublication.countDocuments(query),
  ]);

  return {
    data: await decorateActors(docs.map(toApiPublication)),
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  };
}

/**
 * Drafts and Scheduled-Today only — Pending Approval is deliberately
 * absent (Phase 12's explicit "remove the fake number, no approval
 * workflow exists"). Uses UTC day boundaries — SeoProject has no
 * per-project timezone field, so this is an honest, documented limitation
 * rather than a fabricated "local time" that isn't actually computed
 * correctly; see the docblock on getPublishingCounts's caller.
 */
export async function getPublishingCounts(projectId) {
  const projectObjectId = toObjectId(projectId);
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const [draftCount, scheduledTodayCount] = await Promise.all([
    SocialPublication.countDocuments({ project_id: projectObjectId, status: 'draft' }),
    SocialPublication.countDocuments({ project_id: projectObjectId, status: 'scheduled', scheduledAt: { $gte: todayStart, $lt: todayEnd } }),
  ]);

  return { drafts: draftCount, scheduledToday: scheduledTodayCount };
}

export async function getPublication(projectId, publicationId) {
  const doc = await findOwned(projectId, publicationId);
  if (!doc) return null;
  const [api] = await decorateActors([toApiPublication(doc)]);
  return api;
}

async function findOwned(projectId, publicationId) {
  if (!mongoose.Types.ObjectId.isValid(publicationId)) return null;
  const doc = await SocialPublication.findById(publicationId);
  if (!doc || doc.project_id.toString() !== projectId.toString()) return null;
  return doc;
}

/**
 * Creates a draft, or a scheduled publication if `scheduledAt` is given,
 * or immediately attempts to publish if `publishNow` is true (scheduling
 * and publishing are mutually exclusive — publishNow takes precedence).
 * Content/media validity for the CHOSEN platform is only fully enforced
 * at actual publish time (by the adapter) — a draft is allowed to be
 * incomplete, matching Phase 6's own "save draft" affordance.
 *
 * `scheduledAt` must be in the future (see parseAbsoluteScheduledAt) except
 * for the internal-only `allowPastSchedule`, used by bulk import's
 * "publish now" rows.
 *
 * `importBatchId` / `importRowNumber` are OPTIONAL bulk-upload
 * provenance. When omitted (every single-post create, and the legacy
 * POST /social/publishing/bulk path) the created SocialPublication has
 * both fields null and behaves exactly as before. When present, they are
 * stamped onto the document and the model's partial unique index on
 * `{importBatchId, importRowNumber}` guarantees one import row can never
 * produce two publications — a concurrent/retried bulk import surfaces
 * that as an E11000 the caller recovers from idempotently.
 */
export async function createPublication(projectId, userId, { platform, socialAccountId, content = '', media = [], scheduledAt, timezone = null, importBatchId = null, importRowNumber = null, allowPastSchedule = false, generation = null } = {}) {
  const resolved = await resolveAccount(projectId, platform, socialAccountId);
  if (resolved.error) return { success: false, error: resolved.error };

  const mediaValidation = validateMedia(media);
  if (mediaValidation.error) return { success: false, error: mediaValidation.error };

  const tzValidation = validateTimezone(timezone);
  if (tzValidation.error) return { success: false, error: tzValidation.error };

  let scheduledDate = null;
  if (scheduledAt) {
    const parsed = parseAbsoluteScheduledAt(scheduledAt, { allowPast: allowPastSchedule });
    if (parsed.error) return { success: false, error: parsed.error };
    scheduledDate = parsed.scheduledDate;
  }

  const doc = await SocialPublication.create({
    project_id: toObjectId(projectId),
    social_account_id: resolved.account._id,
    platform,
    content: content || '',
    media: media || [],
    status: scheduledDate ? 'scheduled' : 'draft',
    scheduledAt: scheduledDate,
    timezone: scheduledDate ? (timezone || null) : null,
    createdBy: userId,
    importBatchId: importBatchId || null,
    importRowNumber: importRowNumber === null || importRowNumber === undefined ? null : importRowNumber,
    // Internal only (never read from an HTTP body): provenance set by the AI content generator.
    ...(generation ? { generation } : {}),
  });

  LoggerUtil.service('SocialPublishing', 'create', 'completed', { projectId: String(projectId), publicationId: doc._id.toString(), platform, status: doc.status });

  return { success: true, publication: toApiPublication(doc) };
}

/**
 * Edits a draft/scheduled publication. A single conditional update
 * (`status ∈ EDITABLE`) — NOT read-then-save — so an edit that races the
 * scheduler's claim either lands before it or is refused after it, and can
 * never write over a row that has already moved to 'publishing'.
 */
export async function updatePublication(projectId, publicationId, userId, { content, media, scheduledAt, timezone } = {}) {
  // Validate request-only inputs once, outside the retry loop.
  if (media !== undefined) {
    const mediaValidation = validateMedia(media);
    if (mediaValidation.error) return { success: false, error: mediaValidation.error };
  }
  let parsedSchedule = null;
  if (scheduledAt !== undefined && scheduledAt !== null) {
    const parsed = parseAbsoluteScheduledAt(scheduledAt);
    if (parsed.error) return { success: false, error: parsed.error };
    const tzValidation = validateTimezone(timezone);
    if (tzValidation.error) return { success: false, error: tzValidation.error };
    parsedSchedule = parsed.scheduledDate;
  }

  // The approval fields an edit must touch (version bump / invalidation) are
  // decided from the row as read, and the write is pinned to exactly that
  // approval state + versions, so a racing approval or edit makes it not match.
  // On such a miss the row is re-read and the decision redone (bounded).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await findOwned(projectId, publicationId);
    if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      return { success: false, error: { code: 'NOT_EDITABLE', message: `A ${existing.status} publication can no longer be edited.` } };
    }

    const set = { updatedBy: userId };
    if (content !== undefined) set.content = content;
    if (media !== undefined) set.media = media;
    if (scheduledAt !== undefined) {
      if (scheduledAt === null) {
        Object.assign(set, { scheduledAt: null, timezone: null, status: 'draft', ...RETRY_STATE_RESET });
      } else {
        Object.assign(set, { scheduledAt: parsedSchedule, timezone: timezone || null, status: 'scheduled', ...RETRY_STATE_RESET });
      }
    }

    const approvalFilter = { approvalState: existing.approvalState || null };
    let inc = null;
    if (existing.approvalState) {
      const contentChanged = content !== undefined && content !== existing.content;
      const mediaChanged = media !== undefined && mediaSignature(media) !== mediaSignature(existing.media);
      const settings = await workflow.getApprovalSettings(projectId);
      const effects = planEditEffects(existing, { contentChanged, mediaChanged }, settings, { userId });
      Object.assign(approvalFilter, effects.filter);
      Object.assign(set, effects.set);
      if (Object.keys(effects.inc).length) inc = effects.inc;
    }

    // Scheduling through an edit goes through the same readiness rules as schedulePublication (platform media + account health),
    // judged on the media the post will have AFTER this edit.
    if (parsedSchedule) {
      const notReady = await schedulingReadinessError(existing, media !== undefined ? media : existing.media);
      if (notReady) return { success: false, error: notReady };
    }

    // Scheduling a managed post requires it to END this edit fully approved
    // (so a request that edits approved content AND schedules it is refused).
    if (parsedSchedule && existing.approvalState) {
      const resulting = set.approvalState !== undefined ? set.approvalState : existing.approvalState;
      if (resulting !== 'design_approved') {
        return { success: false, error: approvalGateError({ approvalState: resulting }) };
      }
    }

    // A SCHEDULED post whose edit withdraws its approval must not stay scheduled: the schedule described a version that
    // is no longer approved, and the scheduler would only fail it when it came due. The schedule is removed in THIS SAME
    // conditional write (status -> draft, scheduledAt/timezone/retry state cleared), so there is no instant at which the
    // row is scheduled and unapproved, and the scheduler's query (status 'scheduled') can never see it. The status is
    // pinned to what was read: a racing scheduler claim ('publishing') or a racing reschedule makes the write not match
    // and the loop re-reads. An edit that leaves the post fully approved (the project does not require that stage) keeps
    // its schedule - there is nothing to invalidate. Draft posts are unaffected.
    const resultingState = set.approvalState !== undefined ? set.approvalState : existing.approvalState;
    const clearsSchedule = existing.status === 'scheduled' && !!existing.approvalState && scheduledAt === undefined && !PUBLISHABLE_APPROVAL_STATES.includes(resultingState);
    if (clearsSchedule) Object.assign(set, { status: 'draft', scheduledAt: null, timezone: null, ...RETRY_STATE_RESET });

    const update = { $set: set, ...(inc ? { $inc: inc } : {}) };
    const updated = await SocialPublication.findOneAndUpdate(
      // For a post in the approval workflow the status is pinned to what was read whenever this edit does not itself set one:
      // otherwise a draft that someone schedules between the read and the write would take this edit's approval withdrawal while
      // staying scheduled. A mismatch just re-reads (now scheduled) and the schedule is cleared with the approval.
      { _id: existing._id, project_id: existing.project_id, status: (clearsSchedule || (existing.approvalState && scheduledAt === undefined)) ? existing.status : { $in: EDITABLE_STATUSES }, ...approvalFilter },
      update,
      { new: true },
    );
    if (updated) {
      if (clearsSchedule) logSchedule('publication_schedule_invalidated', updated, { previousScheduledAt: existing.scheduledAt ? existing.scheduledAt.toISOString() : null, approvalState: updated.approvalState });
      return { success: true, publication: (await decorateActors([toApiPublication(updated)]))[0], scheduleCleared: clearsSchedule };
    }

    const current = await SocialPublication.findById(existing._id).select('status').lean();
    if (!current) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
    if (!EDITABLE_STATUSES.includes(current.status)) {
      return { success: false, error: { code: 'NOT_EDITABLE', message: `A ${current.status} publication can no longer be edited.` } };
    }
    // else: the approval state/version moved under us - loop and re-plan.
  }
  return { success: false, error: { code: 'APPROVAL_CONFLICT', message: 'This post was changed by someone else while you were editing it. Reload and try again.' } };
}

/**
 * Attaches an AI-generated design (ONE stored image) to a managed publication - the design counterpart of the
 * text edit in updatePublication, with the stricter guarantees an unattended background job needs:
 *
 *  - the write is ONE conditional update pinned to the content version the design was made for, the design
 *    version the generation started from, the approval state it saw and `status: 'draft'` - if the caption
 *    was edited, the design replaced, the approval moved or the post scheduled in the meantime, nothing
 *    matches and nothing is written (the caller then discards the stored file);
 *  - the approval consequences are NOT re-implemented: planEditEffects (the same function every edit uses)
 *    decides the version bump and what a changed design does to an existing approval;
 *  - it never sets approvalState itself for the first design: the caller submits it through
 *    submitDesignForApproval, the workflow's own transition.
 *
 * Returns { success:true, publication, designVersion } or { success:false, error:{ code } } where code is
 * NOT_FOUND | STALE_CONTENT | STALE_DESIGN | STALE_STATE | NOT_EDITABLE. Never throws for a lost race.
 */
export async function attachGeneratedDesign(projectId, publicationId, userId, { contentVersion, baseDesignVersion, baseApprovalState, media, design }) {
  const existing = await findOwned(projectId, publicationId);
  if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  if (existing.status !== 'draft') return { success: false, error: { code: 'NOT_EDITABLE', message: `A ${existing.status} publication can no longer be edited.` } };
  if (existing.contentVersion !== contentVersion) return { success: false, error: { code: 'STALE_CONTENT', message: 'The caption changed while the design was being generated.' } };
  if (existing.designVersion !== baseDesignVersion) return { success: false, error: { code: 'STALE_DESIGN', message: 'The design changed while the new one was being generated.' } };
  if (existing.approvalState !== baseApprovalState) return { success: false, error: { code: 'STALE_STATE', message: 'The approval state changed while the design was being generated.' } };

  const settings = await workflow.getApprovalSettings(projectId);
  const effects = planEditEffects(existing, { contentChanged: false, mediaChanged: true }, settings, { userId });
  const nextDesignVersion = existing.designVersion + 1;
  const updated = await SocialPublication.findOneAndUpdate(
    { _id: existing._id, project_id: existing.project_id, status: 'draft', contentVersion, ...effects.filter },
    {
      $set: {
        ...effects.set,
        updatedBy: userId,
        media,
        design: { source: 'ai', generationId: design.generationId, contentVersion, designVersion: nextDesignVersion, model: design.model || null, generatedAt: new Date() },
      },
      $inc: effects.inc,
    },
    { new: true },
  );
  if (!updated) return { success: false, error: { code: 'STALE_STATE', message: 'The post changed while the design was being generated.' } };
  return { success: true, publication: updated, designVersion: updated.designVersion };
}

// Same defensive cap as the sync/discovery services elsewhere in this
// module — a bulk import is a batch operation, not an unbounded one.
const MAX_BULK_ROWS = 200;

/**
 * Bulk import — every valid row becomes a DRAFT, never an immediate
 * publish. This is deliberate: a malformed bulk file could otherwise post
 * garbage straight to a real Facebook Page, and Phase 14's own
 * instruction is explicit that a bulk upload must never partially publish
 * without explicit handling. Reviewing and publishing/scheduling each
 * draft individually afterward is the safe path. Returns per-row results
 * so the caller can show exactly which rows failed and why.
 */
export async function createBulkPublications(projectId, userId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, error: { code: 'INVALID_ROWS', message: 'No rows were provided.' } };
  }
  if (rows.length > MAX_BULK_ROWS) {
    return { success: false, error: { code: 'TOO_MANY_ROWS', message: `A bulk import is limited to ${MAX_BULK_ROWS} rows.` } };
  }

  const results = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const result = await createPublication(projectId, userId, {
      platform: row.platform,
      socialAccountId: row.socialAccountId,
      content: row.content,
      media: row.media,
      scheduledAt: row.scheduledAt,
    });
    results.push(result.success
      ? { row: i, success: true, publicationId: result.publication.id }
      : { row: i, success: false, error: result.error });
  }

  return {
    success: true,
    created: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

/**
 * Removes the Odito record, but ONLY while it is still in the status the
 * caller validated. An unconditional deleteOne would let a delete that races
 * the scheduler's claim erase a row the instant it moves to 'publishing',
 * orphaning the real Meta post that attempt is about to create.
 */
async function deleteIfStatus(doc) {
  const res = await SocialPublication.deleteOne({ _id: doc._id, status: doc.status });
  if (res.deletedCount === 1) return { success: true };
  return { success: false, error: { code: 'NOT_DELETABLE', message: 'That publication changed while it was being deleted (it may have just started publishing). Try again in a moment.' } };
}

/**
 * Deletes a publication. The one status this always refuses is
 * 'publishing' — the brief atomically-claimed in-flight window
 * publishNow() itself sets; deleting mid-publish would race the adapter
 * call/status write already in progress.
 *
 * draft/scheduled/failed/cancelled have no successfully published
 * external post to touch — unchanged, MongoDB-only deletion.
 *
 * 'published' now attempts REAL external deletion where the platform API
 * supports it:
 *   - Facebook: DELETE /{externalPostId} via facebookAdapter.remove(), using
 *     the exact same account/token resolution (resolveAccount) and
 *     permission check (isPublishingReady) publishNow() already uses —
 *     pages_manage_posts is required for both creating AND deleting a Page
 *     post; there is no separate delete scope. The Odito record is only
 *     ever removed AFTER Meta confirms the post is gone (or was already
 *     gone — see facebookAdapter.remove's own idempotent-delete handling).
 *     If the external deletion fails for any other reason, the Odito
 *     record is left completely untouched and a clear, actionable error
 *     is returned.
 *   - Instagram: the Graph API has no DELETE for IG Media at all (verified
 *     against Meta's current documented capabilities — there is no
 *     endpoint to call, so none is attempted). Refused with
 *     EXTERNAL_DELETE_UNSUPPORTED unless the caller explicitly opts into
 *     `historyOnly` (the frontend's separate "Remove from Odito history"
 *     action) — in which case only the Odito record is removed and the
 *     real Instagram post is left completely untouched, exactly as
 *     labeled to the user.
 */
export async function deletePublication(projectId, publicationId, { historyOnly = false } = {}) {
  const doc = await findOwned(projectId, publicationId);
  if (!doc) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  if (!DELETABLE_STATUSES.includes(doc.status)) {
    return { success: false, error: { code: 'NOT_DELETABLE', message: 'A publication that is currently publishing cannot be deleted — wait for it to finish.' } };
  }

  if (doc.status !== 'published') {
    return deleteIfStatus(doc);
  }

  if (doc.platform === 'instagram') {
    if (!historyOnly) {
      return {
        success: false,
        error: {
          code: 'EXTERNAL_DELETE_UNSUPPORTED',
          message: 'Instagram does not support deleting a published post through the API. Remove it directly in the Instagram app, or choose "Remove from Odito history" to delete only this record — the real Instagram post will remain untouched.',
        },
      };
    }
    const removed = await deleteIfStatus(doc);
    if (removed.success) LoggerUtil.service('SocialPublishing', 'delete', 'history_only', { publicationId: doc._id.toString(), platform: doc.platform });
    return removed;
  }

  if (doc.platform !== 'facebook') {
    // Defensive: no other platform can reach 'published' today (only
    // facebook/instagram adapters exist), but never silently allow an
    // unrecognized platform through an external-delete path that doesn't
    // exist for it.
    return { success: false, error: { code: 'PLATFORM_NOT_SUPPORTED', message: `Deleting a published ${doc.platform || 'unknown'} post is not supported.` } };
  }

  if (!doc.externalPostId) {
    // Should never happen for a genuinely 'published' record (publishNow()
    // always sets it on success) — but never attempt an external delete
    // without a real target id, and never remove the Odito record either,
    // since that would silently discard the only evidence something is
    // wrong with this record.
    return { success: false, error: { code: 'EXTERNAL_POST_ID_MISSING', message: 'This post has no recorded Facebook post ID, so Odito cannot verify what to delete on Facebook. The Odito record was NOT deleted.' } };
  }

  const resolved = await resolveAccount(projectId, 'facebook', doc.social_account_id.toString());
  if (resolved.error) {
    return { success: false, error: { code: resolved.error.code, message: `Could not verify the connected Facebook Page (${resolved.error.message}). The Odito record was NOT deleted.` } };
  }
  if (!isPublishingReady(resolved.account)) {
    return { success: false, error: { code: 'FACEBOOK_PERMISSION_MISSING', message: 'This Facebook Page connection is missing posting permission, which is also required to delete a post — reconnect the Page, then try again. The Odito record was NOT deleted.' } };
  }

  const deleteResult = await adapters.facebook.remove({ account: resolved.account, externalPostId: doc.externalPostId });
  if (!deleteResult.success) {
    // A dead token surfaced by the delete call expires the connection too.
    if (deleteResult.error?.code === 'FACEBOOK_TOKEN_INVALID') await markAccountExpired(resolved.account);
    return { success: false, error: deleteResult.error };
  }

  const removed = await deleteIfStatus(doc);
  if (removed.success) {
    LoggerUtil.service('SocialPublishing', 'delete', 'completed', {
      publicationId: doc._id.toString(), platform: doc.platform, externalPostId: doc.externalPostId,
      externallyDeleted: deleteResult.alreadyDeleted ? 'already_gone' : 'deleted',
    });
  }
  return removed;
}

export async function schedulePublication(projectId, publicationId, userId, scheduledAt, timezone = null) {
  const existing = await findOwned(projectId, publicationId);
  if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  const reject = (error) => {
    logSchedule('publication_schedule_rejected', existing, { code: error.code, status: existing.status, approvalState: existing.approvalState || null });
    return { success: false, error };
  };
  logSchedule('publication_schedule_requested', existing, { status: existing.status, approvalState: existing.approvalState || null });

  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return reject({ code: 'NOT_EDITABLE', message: `A ${existing.status} publication cannot be scheduled.` });
  }
  // Approval gate: a post still in review cannot be scheduled (see approvalWorkflow.js).
  const gateError = approvalGateError(existing);
  if (gateError) return reject(gateError);
  const parsed = parseAbsoluteScheduledAt(scheduledAt);
  if (parsed.error) return reject(parsed.error);
  const tzValidation = validateTimezone(timezone);
  if (tzValidation.error) return reject(tzValidation.error);
  const notReady = await schedulingReadinessError(existing, existing.media);
  if (notReady) return reject(notReady);

  // Conditional (status in EDITABLE AND approval still satisfied), same reason as updatePublication. For a post in the
  // approval workflow the write is also pinned to the content + design version that were just read and checked, so an
  // edit that lands in between (which bumps a version and withdraws approval) can never be scheduled as "approved".
  const managedPin = existing.approvalState ? { approvalState: existing.approvalState, contentVersion: existing.contentVersion, designVersion: existing.designVersion } : {};
  const updated = await SocialPublication.findOneAndUpdate(
    { _id: existing._id, project_id: existing.project_id, status: { $in: EDITABLE_STATUSES }, approvalState: { $in: PUBLISHABLE_APPROVAL_STATES }, ...managedPin },
    { $set: { scheduledAt: parsed.scheduledDate, timezone: timezone || null, status: 'scheduled', updatedBy: userId, ...RETRY_STATE_RESET } },
    { new: true },
  );
  if (!updated) {
    const current = await SocialPublication.findById(existing._id).select('status approvalState').lean();
    if (current && EDITABLE_STATUSES.includes(current.status)) {
      const nowBlocked = approvalGateError(current);
      if (nowBlocked) return reject(nowBlocked);
      return reject({ code: 'APPROVAL_CONFLICT', message: 'This post was changed while it was being scheduled. Reload it and try again.' });
    }
    return reject({ code: 'NOT_EDITABLE', message: `A ${current?.status || 'changed'} publication cannot be scheduled.` });
  }
  logSchedule(existing.status === 'scheduled' ? 'publication_rescheduled' : 'publication_scheduled', updated, { scheduledAt: updated.scheduledAt.toISOString(), timezone: updated.timezone || null });
  return { success: true, publication: (await decorateActors([toApiPublication(updated)]))[0] };
}

export async function cancelPublication(projectId, publicationId, userId) {
  const doc = await SocialPublication.findOneAndUpdate(
    { _id: publicationId, project_id: toObjectId(projectId), status: { $in: CANCELLABLE_STATUSES } },
    { $set: { status: 'cancelled', updatedBy: userId, nextRetryAt: null } },
    { new: true },
  );
  if (!doc) return { success: false, error: { code: 'NOT_CANCELLABLE', message: 'That publication cannot be cancelled (it may already be published, failed, or not found).' } };
  logSchedule('publication_cancelled', doc);
  return { success: true, publication: toApiPublication(doc) };
}

/**
 * A 'failed' publication flagged outcomeUnknown (Odito sent a publish request
 * but never got a usable answer) must NEVER be re-sent blindly: Meta may
 * already have created the post, and a second request would duplicate it.
 * Before any manual publish/retry proceeds, ask Meta (reconciliation):
 *   - post found                 -> record it as published; nothing is re-sent
 *   - confidently NOT published  -> clear the flag; the claim below proceeds
 *   - cannot tell / too soon     -> refuse with a clear 409; the user can
 *                                   check the platform, or delete the record
 * Returns null when publishing may proceed, else a final result.
 */
async function gateUnknownOutcome(projectObjectId, publicationId, now) {
  const doc = await SocialPublication.findOne({ _id: publicationId, project_id: projectObjectId });
  if (!doc || doc.status !== 'failed' || !doc.outcomeUnknown) return null;

  const rec = await reconcileUnknownPublication(doc, { requireSettled: true, now });
  if (rec.resolution === 'published') {
    return { success: true, publication: toApiPublication(rec.publication), reconciled: true };
  }
  if (rec.resolution === 'not_published') {
    await SocialPublication.updateOne({ _id: doc._id, status: 'failed', outcomeUnknown: true }, { $set: { outcomeUnknown: false } });
    return null;
  }
  if (rec.resolution === 'pending') {
    return { success: false, error: { code: 'RECONCILIATION_PENDING', message: 'Odito is still verifying whether the previous attempt already published this post. Please try again in a few minutes.' } };
  }
  return {
    success: false,
    error: {
      code: 'OUTCOME_UNKNOWN',
      message: 'Odito could not confirm whether the previous attempt already published this post, so it will not send it again (that could create a duplicate). Check the page on the platform: if the post is live, delete this record; if it is not, delete this record and create the post again.',
    },
  };
}

/**
 * Called when the publish claim matched nothing. If the reason is a missing
 * approval, report it as APPROVAL_REQUIRED (not the generic NOT_PUBLISHABLE) -
 * and for a DUE scheduled post, record it as failed (never published) so the
 * user sees "approval missing" instead of the post silently staying scheduled
 * forever. The failure write is itself conditional (still due, still blocked),
 * and it is retryable only once approval exists (isSafelyRetryable).
 */
async function resolveApprovalBlock(projectObjectId, publicationId, dueFilter, now) {
  const current = await SocialPublication.findOne({ _id: publicationId, project_id: projectObjectId }).select('status approvalState').lean();
  if (!current || !PUBLISHABLE_FROM.includes(current.status)) return null;
  const blocked = approvalGateError(current);
  if (!blocked) return null;
  if (dueFilter) {
    const failed = await SocialPublication.findOneAndUpdate(
      { ...dueFilter, approvalState: { $nin: PUBLISHABLE_APPROVAL_STATES } },
      { $set: { status: 'failed', failedAt: now, failureCode: 'APPROVAL_REQUIRED', failureReason: blocked.message, failureRetryable: null, lastError: blocked.message, lastErrorCode: 'APPROVAL_REQUIRED', nextRetryAt: null } },
      { new: true },
    );
    LoggerUtil.info('[SOCIAL_SCHEDULER_BLOCKED]', { publicationId: String(publicationId), reason: 'APPROVAL_REQUIRED', approvalState: current.approvalState, failedRecorded: !!failed });
    if (failed) return { success: false, error: blocked, publication: toApiPublication(failed) };
  }
  return { success: false, error: blocked };
}

/**
 * A publication may only be dispatched for a project that exists and is not in the trash. A trashed project is simply not
 * dispatched (everything stays as it is, so a restore finds it intact); a project that no longer exists can never come
 * back, so its publication is cancelled - which also stops the scheduler from re-selecting it every minute.
 * Returns null when the project is active, otherwise the final result for the caller.
 */
const PROJECT_UNAVAILABLE = { code: 'PROJECT_UNAVAILABLE', message: 'This project has been deleted, so nothing can be published for it.' };
async function refuseIfProjectInactive(projectObjectId, publicationId, state, now) {
  if (state === PROJECT_STATES.ACTIVE) return null;
  if (state === PROJECT_STATES.MISSING) {
    await SocialPublication.updateOne(
      { _id: publicationId, project_id: projectObjectId, status: { $in: ['draft', 'scheduled'] } },
      { $set: { status: 'cancelled', nextRetryAt: null, failureCode: 'PROJECT_DELETED', lastError: PROJECT_UNAVAILABLE.message, lastErrorCode: 'PROJECT_DELETED' } },
    );
  }
  LoggerUtil.warn('[SOCIAL_PUBLISH_BLOCKED]', { publicationId: String(publicationId), reason: 'PROJECT_' + state.toUpperCase() });
  return { success: false, error: { ...PROJECT_UNAVAILABLE } };
}

/**
 * The real publish path — the only function that ever calls a platform
 * adapter.
 *
 * CLAIM. A single atomic findOneAndUpdate moves the row to 'publishing' and,
 * in the same write, stamps lockedBy / publishingStartedAt / lastAttemptAt and
 * bumps `attempts`. Two workers (or PM2 instances, or a worker and a person
 * clicking Publish) can never both match it, so the loser gets
 * NOT_PUBLISHABLE and never reaches Meta. The database claim — not noOverlap,
 * not in-memory state — is the cross-process safety mechanism.
 *   trigger 'manual'    — from draft/scheduled/failed (a person's click); a
 *                         row flagged outcomeUnknown is excluded and goes
 *                         through gateUnknownOutcome first.
 *   trigger 'scheduler' — only status:'scheduled' rows that are STILL due and
 *                         not too late (re-checked inside the claim, so a post
 *                         a user just rescheduled/cancelled after the scan
 *                         cannot be published from a stale list).
 *
 * FINALIZE. Success is recorded via recordPublished (never loses a real
 * post); every failure goes through settleFailure, which is conditional on
 * still owning the lock. An attempt whose outcome is unknown (timeout /
 * connection reset / 5xx on the publish call) is reconciled against Meta
 * immediately; if that can't prove the post exists it is parked as
 * failed + outcomeUnknown and is not retried until reconciliation resolves
 * it. A dead token marks the SocialAccount expired.
 */
export async function publishNow(projectId, publicationId, userId, { trigger = 'manual', now = new Date() } = {}) {
  if (!mongoose.Types.ObjectId.isValid(publicationId)) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  }
  const projectObjectId = toObjectId(projectId);
  const config = getPublishConfig();
  const owner = getInstanceId();

  const inactive = await refuseIfProjectInactive(projectObjectId, publicationId, await getProjectState(projectId), now);
  if (inactive) return inactive;

  if (trigger !== 'scheduler') {
    // Approval gate, before anything else (and before any Meta reconciliation
    // call): a managed post that is not fully approved is never published.
    const pre = await SocialPublication.findOne({ _id: publicationId, project_id: projectObjectId }).select('status approvalState').lean();
    if (pre && PUBLISHABLE_FROM.includes(pre.status)) {
      const blocked = approvalGateError(pre);
      if (blocked) return { success: false, error: blocked };
    }
    const gate = await gateUnknownOutcome(projectObjectId, publicationId, now);
    if (gate) return gate;
  }

  let claimFilter;
  let claimUpdate;
  let dueFilter = null;
  if (trigger === 'scheduler') {
    const cutoff = new Date(now.getTime() - config.maxLatenessMs);
    dueFilter = {
      _id: publicationId,
      project_id: projectObjectId,
      status: 'scheduled',
      outcomeUnknown: { $ne: true },
      $or: [
        { nextRetryAt: null, scheduledAt: { $lte: now, $gte: cutoff } },
        { nextRetryAt: { $ne: null, $lte: now, $gte: cutoff } },
      ],
    };
    // Approval is part of the ATOMIC claim itself, not only a pre-check, so an
    // approval invalidated a moment ago can never be published from a stale scan.
    claimFilter = { ...dueFilter, approvalState: { $in: PUBLISHABLE_APPROVAL_STATES } };
    claimUpdate = {
      $set: { status: 'publishing', updatedBy: null, publishingStartedAt: now, lockedBy: owner, publishTrigger: 'scheduler', lastAttemptAt: now, nextRetryAt: null },
      $inc: { attempts: 1 },
    };
  } else {
    claimFilter = { _id: publicationId, project_id: projectObjectId, status: { $in: PUBLISHABLE_FROM }, outcomeUnknown: { $ne: true }, approvalState: { $in: PUBLISHABLE_APPROVAL_STATES } };
    // A person's click starts a fresh attempt sequence (attempts: 1).
    claimUpdate = {
      $set: { status: 'publishing', updatedBy: userId || null, publishingStartedAt: now, lockedBy: owner, publishTrigger: 'manual', lastAttemptAt: now, nextRetryAt: null, attempts: 1 },
    };
  }

  const claimed = await SocialPublication.findOneAndUpdate(claimFilter, claimUpdate, { new: true });

  LoggerUtil.info('[SOCIAL_SCHEDULER_CLAIM]', {
    publicationId,
    trigger,
    claimed: !!claimed,
    newStatus: claimed ? claimed.status : null,
    attempt: claimed ? claimed.attempts : null,
    lockedBy: claimed ? owner : null,
  });

  if (!claimed) {
    const blocked = await resolveApprovalBlock(projectObjectId, publicationId, trigger === 'scheduler' ? dueFilter : null, now);
    if (blocked) return blocked;
    return { success: false, error: { code: 'NOT_PUBLISHABLE', message: 'That publication cannot be published right now (it may already be publishing, published, or cancelled).' } };
  }

  LoggerUtil.info('[SOCIAL_PUBLISH_START]', {
    publicationId,
    platform: claimed.platform,
    scheduledAt: claimed.scheduledAt ? claimed.scheduledAt.toISOString() : null,
    currentTime: new Date().toISOString(),
    attempt: claimed.attempts,
  });

  // Every exit from here on settles the row (never leaves 'publishing').
  async function conclude(error, account = null) {
    const safe = toSafeError(error);
    if (account && error?.accountAction === 'expire') {
      await markAccountExpired(account);
    }

    // Unknown outcome: the post may already be live. Look for it right away
    // before parking the row — a match means we are actually done.
    if (error?.outcome === 'unknown' && account) {
      const rec = await reconcileUnknownPublication(claimed, { since: claimed.lastAttemptAt, requireSettled: true });
      if (rec.resolution === 'published') {
        LoggerUtil.info('[SOCIAL_PUBLISH_SUCCESS]', { publicationId, platform: claimed.platform, via: 'reconciliation' });
        return { success: true, publication: toApiPublication(rec.publication), reconciled: true };
      }
    }

    const settled = await settleFailure(claimed, error);
    recordPublish(error?.requiresReconnect || error?.accountAction === 'expire' ? 'reconnect_required' : 'failed');
    const publication = settled.publication || claimed;
    LoggerUtil.info('[SOCIAL_PUBLISH_FAILED]', {
      publicationId,
      platform: claimed.platform,
      error: { code: safe.code, category: safe.category || null },
      retryScheduled: settled.retryScheduled,
      outcomeUnknown: !!publication.outcomeUnknown,
    });
    return { success: false, error: safe, publication: toApiPublication(publication) };
  }

  // The project may have been deleted between the check above and the claim. Re-check now, before any credential is read:
  // a claimed-but-undispatched post is handed back untouched (scheduled again, attempt not counted) or cancelled.
  const stateAfterClaim = await getProjectState(projectId);
  if (stateAfterClaim !== PROJECT_STATES.ACTIVE) {
    await SocialPublication.updateOne(
      { _id: claimed._id, status: 'publishing', lockedBy: owner },
      stateAfterClaim === PROJECT_STATES.MISSING
        ? { $set: { status: 'cancelled', nextRetryAt: null, publishingStartedAt: null, lockedBy: null, failureCode: 'PROJECT_DELETED', lastErrorCode: 'PROJECT_DELETED' } }
        : { $set: { status: 'scheduled', publishingStartedAt: null, lockedBy: null }, $inc: { attempts: -1 } },
    );
    LoggerUtil.warn('[SOCIAL_PUBLISH_BLOCKED]', { publicationId: String(publicationId), reason: 'PROJECT_' + stateAfterClaim.toUpperCase(), stage: 'after_claim' });
    return { success: false, error: { ...PROJECT_UNAVAILABLE } };
  }

  const resolved = await resolveAccount(projectId, claimed.platform, claimed.social_account_id.toString());
  if (resolved.error) {
    return conclude({ ...resolved.error, category: 'PERMANENT', retryable: false, outcome: 'not_published' });
  }

  // Checked BEFORE ever calling Meta — real, live-confirmed root cause:
  // every Facebook Page/Instagram account connected before
  // pages_manage_posts/instagram_content_publish existed still has a
  // token that can read but cannot post. The adapters ALSO detect this
  // from Meta's own OAuthException response (kept as-is, defense in
  // depth for scope data that's somehow stale), but catching it here
  // first means a known-unpublishable account never wastes a real Meta
  // API call at all — including on every manual Retry of a post that
  // already failed for this exact reason.
  if (!isPublishingReady(resolved.account)) {
    const code = claimed.platform === 'instagram' ? 'INSTAGRAM_PERMISSION_MISSING' : 'FACEBOOK_PERMISSION_MISSING';
    const message = claimed.platform === 'instagram'
      ? 'This Instagram connection is missing publishing permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.'
      : 'This Facebook Page is connected but missing posting permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.';
    return conclude({ code, message, category: 'AUTHENTICATION', retryable: false, outcome: 'not_published', requiresReconnect: true }, resolved.account);
  }

  const adapter = adapters[claimed.platform];
  let result;
  try {
    result = await adapter.publish({ account: resolved.account, content: claimed.content, media: claimed.media });
  } catch (error) {
    // An exception AFTER a request may have left the process is
    // indistinguishable from a lost response — treat it as unknown (safe:
    // reconciled before any retry) rather than a definite failure.
    LoggerUtil.error('[SOCIAL_PUBLISHING] Adapter threw unexpectedly', { message: error.message }, { projectId: String(projectId), publicationId });
    return conclude({
      code: 'PUBLISH_OUTCOME_UNKNOWN',
      message: 'An unexpected error occurred while publishing, so Odito cannot confirm whether the post went out. It will not be re-sent until that is verified.',
      category: 'UNKNOWN_OUTCOME', retryable: true, outcome: 'unknown',
    }, resolved.account);
  }

  if (!result.success) {
    return conclude(result.error, resolved.account);
  }

  const recordedPublish = await recordPublished(claimed, result.externalPostId);
  const { duplicate } = recordedPublish;
  let { publication } = recordedPublish;
  // Facebook has accepted the post and it is recorded as published. Only NOW, and only for this confirmed success, look up
  // its canonical permalink (best-effort: a failure leaves permalink null and the post published).
  if (publication && !duplicate) publication = await attachPermalink(publication, resolved.account);
  if (duplicate) {
    return { success: false, error: toSafeError({ code: 'DUPLICATE_EXTERNAL_POST', message: 'Meta returned a post that is already recorded for another Odito post.' }), publication: toApiPublication(publication || claimed) };
  }
  if (!publication) {
    // The row vanished/was already published while the call was in flight;
    // the real post exists, so surface it rather than losing the id.
    LoggerUtil.error('[SOCIAL_PUBLISHING] Published, but the publication record no longer exists to update', {}, { projectId: String(projectId), publicationId, externalPostId: result.externalPostId });
    return { success: true, publication: toApiPublication({ ...claimed.toObject(), status: 'published', externalPostId: result.externalPostId, publishedAt: new Date() }) };
  }

  recordPublish('published');
  LoggerUtil.service('SocialPublishing', 'publish', 'completed', { projectId: String(projectId), publicationId, platform: claimed.platform });
  LoggerUtil.info('[SOCIAL_PUBLISH_SUCCESS]', {
    publicationId,
    platform: claimed.platform,
    publishedAt: publication.publishedAt.toISOString(),
  });
  return { success: true, publication: toApiPublication(publication) };
}

// Hard ceiling per scheduler tick — a defensive cap against a pathological
// backlog blocking the process, same reasoning as metaPageService.js's
// own MAX_PAGES constant.
const MAX_DUE_PER_RUN = 100;

/**
 * Finds every publication across ALL projects that is due AND not too late,
 * and publishes it. Called by socialSchedulerService.js (a cron tick) —
 * exported separately here so it can also be invoked directly (tests, an ops
 * "run now" trigger) without waiting for a tick, matching
 * weeklyRecheckScheduler.js's own runOnce()/startScheduler() split. One
 * publication failing never aborts the run for the others.
 *
 * "Due" means: status 'scheduled', and either (first attempt) scheduledAt has
 * passed, or (a retry) nextRetryAt has passed. "Not too late" means that
 * moment is no older than SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES; anything
 * older — after downtime, a restart, or a disabled scheduler — is NOT
 * published but failed as SCHEDULE_MISSED (markMissedPublications) so a stale
 * post never goes out days late. `projectId` (optional) narrows the run to one
 * project — never passed by the cron tick, which sweeps everything. The same conditions are re-checked inside
 * publishNow's atomic claim, so this list can be stale without consequence.
 */
export async function executeDuePublications({ now = new Date(), projectId = null } = {}) {
  const config = getPublishConfig();
  const cutoff = new Date(now.getTime() - config.maxLatenessMs);

  const { missed } = await markMissedPublications({ now, config, projectId });

  // Trashed projects are skipped (their schedules wait for a restore); see projectLifecycleGuard.js
  const due = await SocialPublication.find({
    ...(await activeProjectScope(projectId)),
    status: 'scheduled',
    outcomeUnknown: { $ne: true },
    $or: [
      { nextRetryAt: null, scheduledAt: { $lte: now, $gte: cutoff } },
      { nextRetryAt: { $ne: null, $lte: now, $gte: cutoff } },
    ],
  })
    .sort({ scheduledAt: 1 })
    .limit(MAX_DUE_PER_RUN);

  const results = [];
  for (const pub of due) {
    LoggerUtil.info('[SOCIAL_SCHEDULER_CHECK]', {
      now: now.toISOString(),
      publicationId: pub._id.toString(),
      scheduledAt: pub.scheduledAt ? pub.scheduledAt.toISOString() : null,
      nextRetryAt: pub.nextRetryAt ? pub.nextRetryAt.toISOString() : null,
      attempts: pub.attempts || 0,
      status: pub.status,
    });
    try {
      const outcome = await publishNow(pub.project_id.toString(), pub._id.toString(), null, { trigger: 'scheduler', now });
      results.push({ id: pub._id.toString(), success: outcome.success, errorCode: outcome.error?.code || null });
    } catch (error) {
      LoggerUtil.error('[SOCIAL_PUBLISHING] Unexpected error executing a due publication', { message: error.message }, { publicationId: pub._id.toString() });
      results.push({ id: pub._id.toString(), success: false, errorCode: 'EXECUTE_FAILED' });
    }
  }

  // Losing the claim race to another worker/PM2 instance is the system
  // working, not a failure — reported separately so metrics aren't polluted.
  const skipped = results.filter((r) => r.errorCode === 'NOT_PUBLISHABLE').length;
  return {
    processed: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success && r.errorCode !== 'NOT_PUBLISHABLE').length,
    skipped,
    missed,
    results,
  };
}

// ── approval workflow (state machine lives in approvalWorkflow.js) ───────

/** Maps a workflow result's raw document into the API publication shape. */
async function toApprovalResult(result) {
  if (!result.success) return result;
  const [publication] = await decorateActors([toApiPublication(result.publication)]);
  return { success: true, publication };
}

export const submitContentForApproval = async (projectId, publicationId, userId) => toApprovalResult(await workflow.submitContent(projectId, publicationId, userId));
export const approveContent = async (projectId, publicationId, userId, version) => toApprovalResult(await workflow.approveContent(projectId, publicationId, userId, version));
export const requestContentChanges = async (projectId, publicationId, userId, input) => toApprovalResult(await workflow.requestContentChanges(projectId, publicationId, userId, input));
export const submitDesignForApproval = async (projectId, publicationId, userId) => toApprovalResult(await workflow.submitDesign(projectId, publicationId, userId));
export const approveDesign = async (projectId, publicationId, userId, version) => toApprovalResult(await workflow.approveDesign(projectId, publicationId, userId, version));
export const requestDesignChanges = async (projectId, publicationId, userId, input) => toApprovalResult(await workflow.requestDesignChanges(projectId, publicationId, userId, input));
export const getApprovalSummary = (projectId) => workflow.getApprovalSummary(projectId);
export const getApprovalSettings = (projectId) => workflow.getApprovalSettings(projectId);
export const updateApprovalSettings = (projectId, userId, input) => workflow.updateApprovalSettings(projectId, userId, input);

export default {
  submitContentForApproval,
  approveContent,
  requestContentChanges,
  submitDesignForApproval,
  approveDesign,
  requestDesignChanges,
  getApprovalSummary,
  getApprovalSettings,
  updateApprovalSettings,
  listPublications,
  getPublishingCounts,
  getPublication,
  createPublication,
  createBulkPublications,
  updatePublication,
  attachGeneratedDesign,
  deletePublication,
  schedulePublication,
  cancelPublication,
  publishNow,
  executeDuePublications,
};
