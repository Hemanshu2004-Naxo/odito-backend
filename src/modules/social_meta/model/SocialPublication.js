import mongoose from 'mongoose';

/**
 * SocialPublication — an Odito-authored post: draft, scheduled, or
 * actually published (or failed to publish) through a connected
 * SocialAccount. Distinct from SocialPost (social_meta/model/SocialPost.js),
 * which is the READ-side mirror of posts that already existed on Meta
 * before Odito ever touched them (the Feeds page's sync target). This
 * model is the WRITE side — content Odito itself created and sent (or
 * will send) to a platform. No token of any kind lives here; publishing
 * always loads the token fresh from the referenced SocialAccount.
 */

const PLATFORMS = ['facebook', 'instagram'];
const STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'];

const socialPublicationSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  social_account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    required: true,
  },
  // Meta's own post/media ID — set only once a real publish attempt has
  // actually succeeded (never invented, never set on a failure).
  externalPostId: {
    type: String,
    default: null,
    trim: true,
  },
  // The platform's CANONICAL link to the live post (Facebook: permalink_url from `GET /{post-id}?fields=permalink_url`).
  // Set only from that response, only after a confirmed publish, and only if it is an https facebook.com URL. NEVER built
  // from externalPostId (the numeric segment of the real permalink is not the Page id inside the post id). null when the
  // lookup failed or has not run - the post is published either way.
  permalink: {
    type: String,
    default: null,
    trim: true,
    maxlength: 500,
  },
  content: {
    type: String,
    default: '',
  },
  // URLs only (no raw file storage in this phase — see
  // socialPublishingService.js's createPublication for why an attached
  // file is rejected with a clear error rather than silently dropped).
  media: {
    type: [{
      url: { type: String, required: true },
      type: { type: String, enum: ['image', 'video'], required: true },
    }],
    default: [],
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'draft',
    index: true,
  },
  scheduledAt: {
    type: Date,
    default: null,
    index: true,
  },
  // The IANA zone the user had selected when they scheduled this post
  // (e.g. "Asia/Kolkata") — purely informational metadata for displaying
  // the time back the way the user set it. scheduledAt itself is always
  // the authoritative absolute UTC instant; this field is never used for
  // date math. Optional/nullable so existing documents created before this
  // field existed remain valid with no migration (default null renders as
  // "display in viewer's own timezone" in the UI).
  timezone: {
    type: String,
    default: null,
  },
  publishedAt: {
    type: Date,
    default: null,
  },
  failedAt: {
    type: Date,
    default: null,
  },
  // A short, safe, user-facing reason only — never Meta's raw error
  // message/fbtrace_id/any token-adjacent detail (same discipline as
  // every other *Service.js file in this module's error normalization).
  failureReason: {
    type: String,
    default: null,
  },
  // A stable, machine-readable classification of failureReason (e.g.
  // "INSTAGRAM_PERMISSION_MISSING", "FACEBOOK_MEDIA_URL_UNREACHABLE") —
  // added because failureReason alone was found to be un-triaged after
  // the fact: the adapter DID classify each failure into a specific code
  // at the moment it happened, but that code only ever reached the
  // caller's one-time HTTP response and was never persisted, so a later
  // look at the database (or a support/debugging session) saw nothing but
  // a generic-sounding message with no way to tell which real Meta error
  // family caused it. Optional/nullable so existing documents created
  // before this field existed remain valid with no migration.
  failureCode: {
    type: String,
    default: null,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Bulk-upload provenance (additive, nullable — every existing
  // publication has both null and is completely unaffected). Set ONLY
  // when a publication was created by the bulk-upload importer (a later
  // phase) from a specific SocialImportRow. The partial unique index
  // below guarantees one import row can never produce two publications.
  importBatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialImportBatch',
    default: null,
  },
  importRowNumber: {
    type: Number,
    default: null,
  },

  // ── Publishing lock / reliability metadata (all additive + nullable, so
  //    every pre-existing document stays valid with no migration) ──────────
  //
  // Set atomically together with status:'publishing' by the claim in
  // socialPublishingService.js. They identify WHO holds the in-flight
  // publish and SINCE WHEN, which is what lets a sweeper recognize an
  // orphaned 'publishing' row (crashed/restarted/OOM-killed worker) without
  // ever touching one a live worker is still working on. The final status
  // write is conditional on lockedBy still matching, so a worker whose lock
  // was recovered can never overwrite the recovery's decision.
  publishingStartedAt: {
    type: Date,
    default: null,
  },
  lockedBy: {
    type: String,
    default: null,
  },
  // Who started the in-flight/last attempt: the cron ('scheduler') or a
  // person clicking Publish/Retry ('manual'). Only scheduler-triggered
  // attempts are retried automatically; a manual attempt that fails just
  // becomes 'failed' for the person to act on.
  publishTrigger: {
    type: String,
    enum: ['scheduler', 'manual', null],
    default: null,
  },
  // Incremented AT CLAIM TIME (not on completion) so an attempt that
  // crashes the process still counts toward the maximum.
  attempts: {
    type: Number,
    default: 0,
    min: 0,
  },
  lastAttemptAt: {
    type: Date,
    default: null,
  },
  // Earliest time the scheduler may attempt this (status:'scheduled') post
  // again after a retryable failure; null for a first attempt.
  nextRetryAt: {
    type: Date,
    default: null,
  },
  // Safe, user-facing text + stable code of the most recent failed attempt.
  // Kept separately from failureReason/failureCode, which only describe a
  // post that is currently terminally 'failed' — a post waiting for its
  // next retry is still 'scheduled' but its last error is worth keeping.
  lastError: {
    type: String,
    default: null,
  },
  lastErrorCode: {
    type: String,
    default: null,
  },
  // The classifier's verdict on the failure that left this row 'failed':
  // true = a later attempt can succeed with no change, false = it cannot
  // (permanent Meta rejection, invalid content/media, ...), null = not
  // recorded (rows from before this field). Surfaced to clients only as the
  // derived `canRetry` (see socialPublishingService.js) so UIs never guess
  // retry safety.
  failureRetryable: {
    type: Boolean,
    default: null,
  },
  // True while Odito cannot tell whether Meta actually created the post
  // (the publish request was sent but no usable answer came back). While
  // set, the post must NOT be published again — see publishNow's
  // reconciliation gate. Cleared only by a confident reconciliation result.
  outcomeUnknown: {
    type: Boolean,
    default: false,
  },
  reconcileCheckedAt: {
    type: Date,
    default: null,
  },
  reconcileAttempts: {
    type: Number,
    default: 0,
    min: 0,
  },

  // ── Content approval workflow (all additive + nullable) ─────────────────
  //
  // A SECOND AXIS on the existing publication — `status` (draft/scheduled/
  // publishing/published/failed/cancelled) is untouched and remains the
  // publishing lifecycle; `approvalState` says how far the CONTENT and DESIGN
  // got through review. One document, no second collection.
  //
  //   null              not in the workflow ("unmanaged": every post created
  //                     before this feature, via /app/social, bulk import, ...).
  //                     Behaves exactly as before.
  //   content_review    submitted, waiting for the caption to be approved
  //   content_approved  caption approved, design not yet submitted/approved
  //   design_review     design (media) submitted, waiting for approval
  //   design_approved   everything required is approved — the ONLY state a
  //                     managed post may be scheduled/published from. (The
  //                     product's "READY TO SCHEDULE" is this state while the
  //                     post is still a draft; see approvalStageOf().)
  //
  // Which review stages actually happen is decided by the project's approval
  // settings (SocialApprovalSettings) at submit time — an unrequired stage is
  // auto-approved — and enforced here in the backend, never in a client.
  approvalState: {
    type: String,
    enum: ['content_review', 'content_approved', 'design_review', 'design_approved', null],
    default: null,
  },
  // What an approval applies to. contentVersion bumps whenever `content`
  // changes, designVersion whenever `media` changes (media IS the design until
  // a design-generation phase adds richer design metadata). An approval stores
  // the version it approved; a later edit bumps the version and invalidates it.
  contentVersion: { type: Number, default: 1, min: 1 },
  designVersion: { type: Number, default: 1, min: 1 },

  submittedForReviewAt: { type: Date, default: null },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  designSubmittedAt: { type: Date, default: null },
  designSubmittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // *ApprovedBy is null when the stage was AUTO-approved because the project
  // does not require it (the timestamp/version are still recorded).
  contentApprovedAt: { type: Date, default: null },
  contentApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  contentApprovedVersion: { type: Number, default: null },
  designApprovedAt: { type: Date, default: null },
  designApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  designApprovedVersion: { type: Number, default: null },

  // The latest "request changes" decision. Persisted (never client state);
  // `changesRequestedForVersion` is the version that was rejected, so "has the
  // author revised it yet?" is simply version > changesRequestedForVersion.
  changesRequestedAt: { type: Date, default: null },
  changesRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  changesRequestedReason: { type: String, default: null },
  changesRequestedStage: { type: String, enum: ['content', 'design', null], default: null },
  changesRequestedForVersion: { type: Number, default: null },

  // ── Provenance of AI-generated content (additive + nullable) ─────────────
  // Set only when this draft was produced by the single-post AI content
  // generator (service/aiContent/). It says WHERE the text came from, not how
  // it is published: it never changes status, approval or scheduling. It holds
  // no prompt, no provider response, no key and no token — only which strategy
  // version / profile snapshot / pillar / objective the text was written for.
  // A post created any other way has `source: null`.
  generation: {
    // 'ai'            the text was written by the single-post AI generator (from a plan, or from a pillar + objective)
    // 'calendar_plan' the text IS the caption a person reviewed in the content calendar, copied verbatim into this draft (no AI call)
    source: { type: String, enum: ['ai', 'calendar_plan', null], default: null },
    type: { type: String, enum: ['social_content', 'calendar_item', null], default: null },
    generationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    strategyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    strategyVersion: { type: Number, default: null },
    profileSnapshotHash: { type: String, default: null },
    profileSnapshotGeneratedAt: { type: Date, default: null },
    contentPillar: { type: String, default: null, maxlength: 100 },
    objective: { type: String, default: null, maxlength: 40 },
    // The content-calendar item this draft was written from (null for a post written without a plan).
    calendarItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // For source 'calendar_plan': which state of the plan item the text was taken from (its revision) and when that plan was approved -
    // so the text of a draft can always be traced to the exact approved plan it came from.
    planRevision: { type: Number, default: null },
    planApprovedAt: { type: Date, default: null },
  },
  // Provenance of the CURRENT design (media) when an AI design generation produced it: which generation,
  // for which content version, as which design version. No prompt, no provider output, no key. It describes
  // the media only while `design.designVersion === designVersion`; any later media change moves designVersion
  // on and the API stops reporting it (see toApiDesign). A design uploaded by hand never sets it.
  design: {
    source: { type: String, enum: ['ai', null], default: null },
    generationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    contentVersion: { type: Number, default: null },
    designVersion: { type: Number, default: null },
    model: { type: String, default: null },
    generatedAt: { type: Date, default: null },
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

socialPublicationSchema.index({ project_id: 1, approvalState: 1, status: 1 });
socialPublicationSchema.index({ project_id: 1, scheduledAt: 1 });
socialPublicationSchema.index({ project_id: 1, status: 1, scheduledAt: 1 });
socialPublicationSchema.index({ project_id: 1, platform: 1, scheduledAt: 1 });
// listPublications' default (and only) sort is createdAt (newest/oldest),
// always filtered by project_id — this is the index that query actually
// uses; without it, Posts/History pagination degrades to a collection
// scan as a project's publication history grows.
socialPublicationSchema.index({ project_id: 1, createdAt: -1 });
// Prevents duplicate publication records for the SAME real Meta post.
// Partial: only applies once externalPostId is actually set (a real
// publish succeeded) — many draft/scheduled/failed rows legitimately
// share externalPostId: null and must never collide on that.
socialPublicationSchema.index(
  { social_account_id: 1, externalPostId: 1 },
  { unique: true, partialFilterExpression: { externalPostId: { $type: 'string' } } },
);
// One SocialImportRow -> at most one SocialPublication. Partial: only
// applies once importBatchId is actually set (a bulk-imported post) —
// every manually-created publication has importBatchId: null and must
// never collide on that. Same partial-index discipline as the
// externalPostId guarantee above.
socialPublicationSchema.index(
  { importBatchId: 1, importRowNumber: 1 },
  { unique: true, partialFilterExpression: { importBatchId: { $type: 'objectId' } } },
);
// The scheduler's own due-publication scan (Phase 9): status='scheduled'
// across ALL projects, ordered by scheduledAt.
socialPublicationSchema.index({ status: 1, scheduledAt: 1 });
// Retry scan: status:'scheduled' rows waiting on a backoff.
socialPublicationSchema.index({ status: 1, nextRetryAt: 1 });
// Stale-lock sweeper: status:'publishing' ordered by lock age.
socialPublicationSchema.index({ status: 1, publishingStartedAt: 1 });
// Unknown-outcome reconciliation pass: status:'failed' + outcomeUnknown:true.
socialPublicationSchema.index({ status: 1, outcomeUnknown: 1, lastAttemptAt: 1 });

const SocialPublication = mongoose.model('SocialPublication', socialPublicationSchema);
export default SocialPublication;
export { PLATFORMS, STATUSES };
