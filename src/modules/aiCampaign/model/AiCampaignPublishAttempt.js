import mongoose from 'mongoose';
import { PUBLISH_ATTEMPT_STATUSES, PUBLISH_RESOURCE_TYPES, PUBLISH_ERROR_CODES } from '../constants/publishEnums.js';

/**
 * AiCampaignPublishAttempt — Phase 6: the durable record of one attempt to
 * publish one exact version of an AiCampaignDraft into Google Ads.
 *
 * IDEMPOTENCY (spec §8): unique on `{projectId, draftId, draftVersion}` —
 * at most ONE attempt document can ever exist for a given draft version,
 * for the lifetime of that version. A retry after a network timeout, an
 * ambiguous Google response, or a duplicate click all resolve to the SAME
 * document (found via that unique key), never a new one. Publishing the
 * draft again after it changes (a new `draftVersion`) creates a genuinely
 * new attempt — exactly matching "a new version needs a new publish
 * decision" (spec §10).
 *
 * CONCURRENCY (spec §9): the atomic lock is a `findOneAndUpdate` that
 * requires `status` to be in `RETRYABLE_ATTEMPT_STATUSES` in its FILTER and
 * sets it to `'publishing'` in the SAME write (see
 * publishAttemptService.claimPublishLock) — MongoDB's single-document write
 * atomicity is the actual concurrency guarantee, not application-level
 * `if (status === ...)` logic.
 *
 * RESOURCE MAPPING (spec §15): `resources[]` is appended to incrementally,
 * one entry per successfully created Google Ads resource, immediately after
 * each mutation succeeds — not batched up in memory until the end. A crash
 * mid-publish still leaves an accurate record of what actually exists in
 * Google Ads (spec §42).
 *
 * NEVER stores: OAuth tokens, refresh tokens, client secrets, raw Google API
 * request/response payloads. `failureMessage` is always a short, already-
 * classified, safe string — never a raw provider error object or stack
 * trace (see campaignPublishService.js's error classification).
 */

const { Schema } = mongoose;

const publishResourceSchema = new Schema(
  {
    type: { type: String, required: true, enum: PUBLISH_RESOURCE_TYPES },
    // The Odito-side identifier this Google resource maps to — an ad group
    // id, keyword text+matchType key, or ad id. null for the singleton
    // CAMPAIGN_BUDGET/CAMPAIGN/location/language rows.
    oditoId: { type: String, trim: true, maxlength: 300, default: null },
    // Human-readable parent linkage for ad-group-scoped resources (keywords,
    // negatives, ads) — the Odito ad group id they belong to. Lets the
    // mapping answer "which resources belong to which ad group" without a
    // second collection.
    parentOditoId: { type: String, trim: true, maxlength: 300, default: null },
    googleResourceName: { type: String, required: true, trim: true, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const aiCampaignPublishAttemptSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    // The exact AiCampaignDraft.version this attempt publishes — the
    // version-binding fingerprint (spec §10), and half of the idempotency
    // key (see the unique index below).
    draftVersion: { type: Number, required: true, min: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Digits-only Google Ads customer id this attempt targets, plus the
    // manager (MCC) login-customer-id when the account sits under one.
    // Resolved server-side at publish time — never trusted from the client.
    customerId: { type: String, required: true, trim: true, match: /^\d{10}$/ },
    loginCustomerId: { type: String, trim: true, default: null },

    status: { type: String, required: true, enum: PUBLISH_ATTEMPT_STATUSES, default: 'pending' },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    failureCode: { type: String, trim: true, enum: [...PUBLISH_ERROR_CODES, null], default: null },
    failureMessage: { type: String, trim: true, maxlength: 500, default: null },

    resources: { type: [publishResourceSchema], default: [] },

    // sha256 of the deterministic publish plan's own JSON — lets a retry
    // detect "the draft looks the same version, but the plan I'd build now
    // differs from what I already started creating" (defence in depth on
    // top of the draftVersion check; never trusted alone).
    publishPlanHash: { type: String, trim: true, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_publish_attempts',
  },
);

// Idempotency key + the one real "latest attempt for this draft" read.
aiCampaignPublishAttemptSchema.index(
  { projectId: 1, draftId: 1, draftVersion: 1 },
  { unique: true, name: 'unique_project_draft_version' },
);
// Audit/history view: every attempt for a draft, newest first.
aiCampaignPublishAttemptSchema.index({ projectId: 1, draftId: 1, createdAt: -1 });

aiCampaignPublishAttemptSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

const AiCampaignPublishAttempt = mongoose.model('AiCampaignPublishAttempt', aiCampaignPublishAttemptSchema);

export default AiCampaignPublishAttempt;
