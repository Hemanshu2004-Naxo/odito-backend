import mongoose from 'mongoose';
import SocialPublication from '../model/SocialPublication.js';
import SocialApprovalSettings, { APPROVAL_SETTING_DEFAULTS } from '../model/SocialApprovalSettings.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * ApprovalWorkflow — the content/design approval state machine for a
 * SocialPublication. A SECOND axis next to the publication's own `status`
 * (see SocialPublication.js `approvalState`): `status` keeps meaning "where is
 * this in the publishing lifecycle", `approvalState` means "how far did its
 * CONTENT and DESIGN get through review".
 *
 *   (null = not in the workflow: legacy/direct posts, behave exactly as before)
 *
 *   draft ──submitContent──► content_review ──approveContent──► content_approved
 *                               │  ▲                                  │
 *               requestChanges ─┘  │ (stays; reason persisted)        │ submitDesign
 *                                                                      ▼
 *   design_approved ◄──approveDesign── design_review ◄────────────────┘
 *        │                                │  ▲
 *        │ (the ONLY state a managed       └──┘ requestChanges (stays; reason persisted)
 *        │  post may be scheduled/published from — "ready to schedule" while draft)
 *
 * Which stages are really REQUIRED is the project's setting
 * (SocialApprovalSettings), applied here, in the backend:
 *   content not required  -> submit lands directly in content_approved
 *   design  not required  -> approved content lands directly in design_approved
 * (an auto-approved stage records approvedBy: null).
 *
 * EVERY transition is ONE conditional findOneAndUpdate whose filter names the
 * state (and the approved VERSION) it is legal from — never read/check/save —
 * so two actors racing on one post (approve vs request-changes) cannot both win.
 * Every action is scoped by project_id, so another project's post is simply
 * "not found".
 *
 * Versions: contentVersion bumps when `content` changes, designVersion when
 * `media` changes (media IS the design until a design-generation phase adds
 * more). Approve/request-changes carry the version the reviewer SAW, and the
 * write only matches if it is still current — approving stale content fails —
 * and editing approved content/design invalidates the approval (planEditEffects).
 */

export const APPROVAL_STATES = ['content_review', 'content_approved', 'design_review', 'design_approved'];
/** `$in` list for "may be scheduled/published": unmanaged (null/missing) or fully approved. */
export const PUBLISHABLE_APPROVAL_STATES = [null, 'design_approved'];
/** Approval changes only apply while the post is still pre-publication. */
export const APPROVABLE_STATUSES = ['draft', 'scheduled'];
export const MAX_REASON_LENGTH = 2000;

const REVIEW_LABEL = {
  content_review: 'waiting for content approval',
  content_approved: 'waiting for its design to be submitted',
  design_review: 'waiting for design approval',
  design_approved: 'fully approved',
};

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

const fail = (code, message) => ({ success: false, error: { code, message } });

const CLEAR_CONTENT_APPROVAL = { contentApprovedAt: null, contentApprovedBy: null, contentApprovedVersion: null };
const CLEAR_DESIGN_APPROVAL = { designApprovedAt: null, designApprovedBy: null, designApprovedVersion: null, designSubmittedAt: null, designSubmittedBy: null };
const CLEAR_CHANGES = { changesRequestedAt: null, changesRequestedBy: null, changesRequestedReason: null, changesRequestedStage: null, changesRequestedForVersion: null };

// ── pure helpers ────────────────────────────────────────────────────────

/** Unmanaged posts and fully-approved posts may be scheduled/published; anything mid-review may not. */
export function isApprovalSatisfied(doc) {
  return !doc.approvalState || doc.approvalState === 'design_approved';
}

/** The `{ code, message }` the publish/schedule paths return when approval is missing, else null. */
export function approvalGateError(doc) {
  if (isApprovalSatisfied(doc)) return null;
  const messages = {
    content_review: 'This post\'s content has not been approved yet. Approve the content before it can be scheduled or published.',
    content_approved: 'This post\'s design has not been submitted for approval yet. It cannot be scheduled or published until the design is approved.',
    design_review: 'This post\'s design has not been approved yet. Approve the design before it can be scheduled or published.',
  };
  return { code: 'APPROVAL_REQUIRED', message: messages[doc.approvalState] || 'This post is not fully approved yet.' };
}

/**
 * The product-facing workflow stage: the approval state while in review, and —
 * once fully approved — "ready_to_schedule" while still a draft, else the
 * publishing status. null for posts not in the workflow.
 */
export function approvalStageOf(doc) {
  if (!doc.approvalState) return null;
  if (doc.approvalState !== 'design_approved') return doc.approvalState;
  return doc.status === 'draft' ? 'ready_to_schedule' : doc.status;
}

/** True while a reviewer's "request changes" has not yet been answered by a new version. */
export function needsChanges(doc) {
  if (doc.approvalState === 'content_review') return doc.changesRequestedStage === 'content' && doc.changesRequestedForVersion === doc.contentVersion;
  if (doc.approvalState === 'design_review') return doc.changesRequestedStage === 'design' && doc.changesRequestedForVersion === doc.designVersion;
  return false;
}

function afterContentApproved(settings, { contentVersion, designVersion }, now, approvedBy) {
  const base = { contentApprovedAt: now, contentApprovedBy: approvedBy, contentApprovedVersion: contentVersion, ...CLEAR_CHANGES };
  if (!settings.designApprovalRequired) {
    return { ...base, approvalState: 'design_approved', designApprovedAt: now, designApprovedBy: null, designApprovedVersion: designVersion, designSubmittedAt: null, designSubmittedBy: null };
  }
  return { ...base, approvalState: 'content_approved', ...CLEAR_DESIGN_APPROVAL };
}

/**
 * What editing a MANAGED post does to its approval (the version-safety rule).
 * Returns { filter, set, inc } to merge into the edit's single conditional
 * update — the filter pins the state+versions that were read, so a racing
 * approval or edit makes the write not match instead of overwriting.
 *
 *   content changed (past content_review)  -> approval invalidated, back to
 *        content_review (or auto-approved again if the project doesn't require it)
 *   media/design changed while design_approved -> design approval invalidated,
 *        back to design_review (or auto re-approved if not required)
 *   either change while already in that review -> stays; the version bump is
 *        what marks any earlier "changes requested" as answered
 */
export function planEditEffects(existing, { contentChanged, mediaChanged }, settings, { now = new Date(), userId = null } = {}) {
  if (!existing.approvalState) return { filter: { approvalState: null }, set: {}, inc: {} };

  const filter = { approvalState: existing.approvalState, contentVersion: existing.contentVersion, designVersion: existing.designVersion };
  const inc = {};
  const set = {};
  if (contentChanged) inc.contentVersion = 1;
  if (mediaChanged) inc.designVersion = 1;
  const newVersions = {
    contentVersion: existing.contentVersion + (contentChanged ? 1 : 0),
    designVersion: existing.designVersion + (mediaChanged ? 1 : 0),
  };
  const state = existing.approvalState;

  if (contentChanged && state !== 'content_review') {
    if (settings.contentApprovalRequired) {
      Object.assign(set, { approvalState: 'content_review', submittedForReviewAt: now, submittedBy: userId, ...CLEAR_CONTENT_APPROVAL, ...CLEAR_DESIGN_APPROVAL, ...CLEAR_CHANGES });
    } else {
      Object.assign(set, afterContentApproved(settings, newVersions, now, null));
    }
  } else if (mediaChanged && !contentChanged && state === 'design_approved') {
    if (settings.designApprovalRequired) {
      Object.assign(set, { approvalState: 'design_review', designSubmittedAt: now, designSubmittedBy: userId, designApprovedAt: null, designApprovedBy: null, designApprovedVersion: null, ...CLEAR_CHANGES });
    } else {
      Object.assign(set, { designApprovedAt: now, designApprovedBy: null, designApprovedVersion: newVersions.designVersion });
    }
  }
  return { filter, set, inc };
}

// ── settings ────────────────────────────────────────────────────────────

/** The project's approval settings (defaults when none were ever saved — nothing is created by reading). */
export async function getApprovalSettings(projectId) {
  const doc = await SocialApprovalSettings.findOne({ project_id: toObjectId(projectId) }).lean();
  return {
    contentApprovalRequired: doc ? doc.contentApprovalRequired !== false : APPROVAL_SETTING_DEFAULTS.contentApprovalRequired,
    designApprovalRequired: doc ? doc.designApprovalRequired !== false : APPROVAL_SETTING_DEFAULTS.designApprovalRequired,
    updatedAt: doc?.updatedAt || null,
  };
}

export async function updateApprovalSettings(projectId, userId, { contentApprovalRequired, designApprovalRequired } = {}) {
  const set = { updatedBy: userId };
  for (const [key, value] of Object.entries({ contentApprovalRequired, designApprovalRequired })) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return fail('INVALID_SETTINGS', `${key} must be true or false.`);
    set[key] = value;
  }
  if (Object.keys(set).length === 1) return fail('INVALID_SETTINGS', 'Provide contentApprovalRequired and/or designApprovalRequired.');
  await SocialApprovalSettings.findOneAndUpdate(
    { project_id: toObjectId(projectId) },
    { $set: set, $setOnInsert: { project_id: toObjectId(projectId) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { success: true, settings: await getApprovalSettings(projectId) };
}

// ── transitions ─────────────────────────────────────────────────────────

function parseVersion(version) {
  const n = Number(version);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Why a guarded update matched nothing — never a guess: the row is re-read. */
async function explainNoMatch(projectId, publicationId, action, { expectedStates, versionField = null, version = null }) {
  const current = await SocialPublication.findOne({ _id: publicationId, project_id: toObjectId(projectId) })
    .select('status approvalState contentVersion designVersion').lean();
  if (!current) return fail('NOT_FOUND', 'That publication was not found.');
  if (!APPROVABLE_STATUSES.includes(current.status)) {
    return fail('INVALID_APPROVAL_STATE', `Approval cannot change for a ${current.status} post.`);
  }
  const state = current.approvalState || null;
  if (!expectedStates.includes(state)) {
    const where = state ? REVIEW_LABEL[state] : 'not part of the approval workflow';
    return fail('INVALID_APPROVAL_STATE', `Cannot ${action}: this post is ${where}.`);
  }
  if (versionField && version !== null && current[versionField] !== version) {
    return fail('VERSION_MISMATCH', `This ${versionField === 'contentVersion' ? 'content' : 'design'} was changed since you reviewed it (you saw version ${version}, current is ${current[versionField]}). Reload and review the latest version.`);
  }
  return fail('APPROVAL_CONFLICT', 'This post was changed by someone else while you were acting on it. Reload and try again.');
}

async function guarded(projectId, publicationId, action, { filter, update, expectedStates, versionField, version, event }) {
  const updated = await SocialPublication.findOneAndUpdate(
    { _id: publicationId, project_id: toObjectId(projectId), status: { $in: APPROVABLE_STATUSES }, ...filter },
    update,
    { new: true },
  );
  if (!updated) return explainNoMatch(projectId, publicationId, action, { expectedStates, versionField, version });
  // Structured log only — there is no audit-log or notification system for
  // social publications yet (documented gap); this is NOT presented as one.
  LoggerUtil.info('[SOCIAL_APPROVAL]', { event, projectId: String(projectId), publicationId: String(publicationId), approvalState: updated.approvalState });
  return { success: true, publication: updated };
}

async function loadForAction(projectId, publicationId) {
  if (!mongoose.Types.ObjectId.isValid(publicationId)) return null;
  return SocialPublication.findOne({ _id: publicationId, project_id: toObjectId(projectId) });
}

/** draft -> content_review (or content_approved [-> design_approved] when those stages aren't required). */
export async function submitContent(projectId, publicationId, userId) {
  const cur = await loadForAction(projectId, publicationId);
  if (!cur) return fail('NOT_FOUND', 'That publication was not found.');
  const settings = await getApprovalSettings(projectId);
  const now = new Date();
  const versions = { contentVersion: cur.contentVersion || 1, designVersion: cur.designVersion || 1 };

  const entry = { submittedForReviewAt: now, submittedBy: userId, ...CLEAR_CONTENT_APPROVAL, ...CLEAR_DESIGN_APPROVAL, ...CLEAR_CHANGES };
  const set = settings.contentApprovalRequired
    ? { ...entry, approvalState: 'content_review' }
    : { ...entry, ...afterContentApproved(settings, versions, now, null) };

  return guarded(projectId, publicationId, 'submit this post for review', {
    // only a DRAFT that is not yet in the workflow can enter it
    filter: { status: 'draft', approvalState: null },
    update: { $set: set, $max: { contentVersion: 1, designVersion: 1 } },
    expectedStates: [null],
    event: 'CONTENT_SUBMITTED',
  });
}

export async function approveContent(projectId, publicationId, userId, version) {
  const v = parseVersion(version);
  if (v === null) return fail('VERSION_REQUIRED', 'version (the content version being approved) is required.');
  const cur = await loadForAction(projectId, publicationId);
  if (!cur) return fail('NOT_FOUND', 'That publication was not found.');
  const settings = await getApprovalSettings(projectId);
  const set = afterContentApproved(settings, { contentVersion: v, designVersion: cur.designVersion || 1 }, new Date(), userId);

  return guarded(projectId, publicationId, 'approve content', {
    // designVersion is pinned only when the design is auto-approved here (its version is recorded then).
    filter: { approvalState: 'content_review', contentVersion: v, ...(settings.designApprovalRequired ? {} : { designVersion: cur.designVersion || 1 }) },
    update: { $set: set },
    expectedStates: ['content_review'], versionField: 'contentVersion', version: v,
    event: 'CONTENT_APPROVED',
  });
}

export async function requestContentChanges(projectId, publicationId, userId, { version, reason } = {}) {
  const v = parseVersion(version);
  if (v === null) return fail('VERSION_REQUIRED', 'version (the content version being reviewed) is required.');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return fail('REASON_REQUIRED', 'A reason is required when requesting changes.');
  if (text.length > MAX_REASON_LENGTH) return fail('REASON_TOO_LONG', `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`);

  return guarded(projectId, publicationId, 'request content changes', {
    filter: { approvalState: 'content_review', contentVersion: v },
    update: { $set: { changesRequestedAt: new Date(), changesRequestedBy: userId, changesRequestedReason: text, changesRequestedStage: 'content', changesRequestedForVersion: v } },
    expectedStates: ['content_review'], versionField: 'contentVersion', version: v,
    event: 'CONTENT_CHANGES_REQUESTED',
  });
}

/** content_approved -> design_review (or design_approved when design approval isn't required). */
export async function submitDesign(projectId, publicationId, userId) {
  const cur = await loadForAction(projectId, publicationId);
  if (!cur) return fail('NOT_FOUND', 'That publication was not found.');
  const settings = await getApprovalSettings(projectId);
  const now = new Date();
  const dv = cur.designVersion || 1;
  const set = settings.designApprovalRequired
    ? { approvalState: 'design_review', designSubmittedAt: now, designSubmittedBy: userId, designApprovedAt: null, designApprovedBy: null, designApprovedVersion: null, ...CLEAR_CHANGES }
    : { approvalState: 'design_approved', designSubmittedAt: now, designSubmittedBy: userId, designApprovedAt: now, designApprovedBy: null, designApprovedVersion: dv, ...CLEAR_CHANGES };

  return guarded(projectId, publicationId, 'submit the design for review', {
    filter: { approvalState: 'content_approved', designVersion: dv },
    update: { $set: set },
    expectedStates: ['content_approved'],
    event: 'DESIGN_SUBMITTED',
  });
}

export async function approveDesign(projectId, publicationId, userId, version) {
  const v = parseVersion(version);
  if (v === null) return fail('VERSION_REQUIRED', 'version (the design version being approved) is required.');
  return guarded(projectId, publicationId, 'approve the design', {
    filter: { approvalState: 'design_review', designVersion: v },
    update: { $set: { approvalState: 'design_approved', designApprovedAt: new Date(), designApprovedBy: userId, designApprovedVersion: v, ...CLEAR_CHANGES } },
    expectedStates: ['design_review'], versionField: 'designVersion', version: v,
    event: 'DESIGN_APPROVED',
  });
}

export async function requestDesignChanges(projectId, publicationId, userId, { version, reason } = {}) {
  const v = parseVersion(version);
  if (v === null) return fail('VERSION_REQUIRED', 'version (the design version being reviewed) is required.');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return fail('REASON_REQUIRED', 'A reason is required when requesting changes.');
  if (text.length > MAX_REASON_LENGTH) return fail('REASON_TOO_LONG', `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`);

  return guarded(projectId, publicationId, 'request design changes', {
    filter: { approvalState: 'design_review', designVersion: v },
    update: { $set: { changesRequestedAt: new Date(), changesRequestedBy: userId, changesRequestedReason: text, changesRequestedStage: 'design', changesRequestedForVersion: v } },
    expectedStates: ['design_review'], versionField: 'designVersion', version: v,
    event: 'DESIGN_CHANGES_REQUESTED',
  });
}

// ── counts ──────────────────────────────────────────────────────────────

/**
 * Backend aggregation for the Overview tiles — computed by MongoDB, not from a
 * client-side list. Counts only pre-publication posts (draft/scheduled).
 */
export async function getApprovalSummary(projectId) {
  const base = { project_id: toObjectId(projectId), status: { $in: APPROVABLE_STATUSES } };
  const [contentReview, designReview, awaitingDesignSubmission, readyToSchedule, needsChangesCount] = await Promise.all([
    SocialPublication.countDocuments({ ...base, approvalState: 'content_review' }),
    SocialPublication.countDocuments({ ...base, approvalState: 'design_review' }),
    SocialPublication.countDocuments({ ...base, approvalState: 'content_approved' }),
    SocialPublication.countDocuments({ project_id: base.project_id, status: 'draft', approvalState: 'design_approved' }),
    SocialPublication.countDocuments({
      ...base,
      $or: [
        { approvalState: 'content_review', changesRequestedStage: 'content', $expr: { $eq: ['$changesRequestedForVersion', '$contentVersion'] } },
        { approvalState: 'design_review', changesRequestedStage: 'design', $expr: { $eq: ['$changesRequestedForVersion', '$designVersion'] } },
      ],
    }),
  ]);
  return { contentReview, designReview, awaitingDesignSubmission, readyToSchedule, needsChanges: needsChangesCount };
}

export default {
  APPROVAL_STATES, PUBLISHABLE_APPROVAL_STATES, isApprovalSatisfied, approvalGateError, approvalStageOf, needsChanges, planEditEffects,
  getApprovalSettings, updateApprovalSettings, submitContent, approveContent, requestContentChanges, submitDesign, approveDesign,
  requestDesignChanges, getApprovalSummary,
};
