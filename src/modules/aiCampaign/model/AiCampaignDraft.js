import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  DRAFT_STATUSES,
  DEFAULT_DRAFT_STATUS,
  CAMPAIGN_OBJECTIVES,
  BIDDING_STRATEGIES,
  LOCATION_TYPES,
  KEYWORD_MATCH_TYPES,
  AD_TYPES,
  DEFAULT_AD_TYPE,
  AI_PROVIDERS,
  CHANGE_SOURCES,
  CHANGE_ACTIONS,
  MICROS_PER_UNIT,
  CURRENCY_CODE_PATTERN,
  COUNTRY_CODE_PATTERN,
  LANGUAGE_CODE_PATTERN,
  GOOGLE_ADS_CUSTOMER_ID_PATTERN,
  STRUCTURED_SNIPPET_HEADERS,
} from '../constants/aiCampaignEnums.js';

/**
 * AiCampaignDraft — an AI Campaign Builder draft.
 *
 * PHASE 1 (this file): the domain foundation only. A draft is a campaign
 * that exists ONLY inside Odito and has NOT necessarily been created in
 * Google Ads. It is authored either by a user (Phase 3 UI) or by Claude
 * (Phase 2), iterated on (Phase 4), validated (Phase 5), and finally
 * published through the EXISTING Google Ads services (Phase 6). None of
 * those later phases may require a schema rewrite — every field below is
 * shaped for that.
 *
 * Conventions (deliberately matching the repo's newer project-scoped
 * feature collections — Lead.js, Task.js, SocialImportBatch.js — not
 * SeoProject.js's older snake_case core-model style):
 *   - camelCase field names.
 *   - `projectId` is the tenant boundary; every query is project-scoped.
 *   - Soft delete via `isDeleted`/`deletedAt`.
 *   - Normalized values only. No raw provider (Claude/Google) payloads are
 *     stored in the document — `aiMetadata.rawResponseRef` is a POINTER to
 *     external storage, added in a later phase, never the payload itself.
 *
 * MONEY / BUDGET DECISION (spec §21):
 *   The repo has no single money convention, but the Google Ads module
 *   (GoogleAdsCampaign.budget.amount_micros) uses integer MICROS, and Phase
 *   6 will publish through that module. So budgets here are the source of
 *   truth as `campaign.dailyBudgetMicros` — an INTEGER count of micros
 *   (1 unit = 1_000_000 micros), exactly Google's representation. No
 *   floating-point money is ever stored. A read-only virtual
 *   `campaign.dailyBudget` exposes the human-facing major-unit number
 *   (micros / 1e6) for convenience; the service accepts either
 *   `dailyBudget` (major units, ≤2 dp) or `dailyBudgetMicros` on input and
 *   normalizes to micros. Currency is NEVER assumed — `campaign.currency`
 *   (ISO 4217) is required and validated for shape only; the connected
 *   Google Ads account remains the real authority at publish time.
 */

const { Schema } = mongoose;

// A value object — no _id, compared/edited by its own fields.
const valueObjectOpts = { _id: false };

// ── Location targeting ─────────────────────────────────────────────────────
// Structured, not a plain string. Extensible to future LOCATION_TYPES and to
// a resolved Google Ads geo-target criterion id (added in a later phase)
// without a migration.
const locationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // ISO 3166-1 alpha-2. Uppercased. Required so a draft is never
    // ambiguous about which country a city/region sits in — no India-
    // specific default.
    countryCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [COUNTRY_CODE_PATTERN, 'countryCode must be an ISO 3166-1 alpha-2 code'],
    },
    type: {
      type: String,
      required: true,
      enum: LOCATION_TYPES,
    },
    // Optional structured extras — safe to populate later, no migration.
    region: { type: String, trim: true, maxlength: 200, default: null },
    postalCode: { type: String, trim: true, maxlength: 20, default: null },
    // Reserved: the resolved Google Ads geo target constant id, filled in
    // by a future resolution step. Never populated in Phase 1.
    googleAdsGeoTargetId: { type: String, trim: true, default: null },
  },
  valueObjectOpts,
);

// ── Language targeting ─────────────────────────────────────────────────────
const languageSchema = new Schema(
  {
    // BCP-47-ish primary subtag, optionally with a region (`en`, `en-US`).
    code: {
      type: String,
      required: true,
      trim: true,
      match: [LANGUAGE_CODE_PATTERN, 'language code must look like "en" or "en-US"'],
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Reserved: resolved Google Ads language constant id.
    googleAdsLanguageId: { type: String, trim: true, default: null },
  },
  valueObjectOpts,
);

// ── Keyword ────────────────────────────────────────────────────────────────
// Room for future per-keyword metadata (cpcBid, aiScore, source, …) with no
// breaking change.
const keywordSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 250 },
    matchType: {
      type: String,
      required: true,
      enum: KEYWORD_MATCH_TYPES,
      default: 'BROAD',
    },
  },
  valueObjectOpts,
);

// ── Negative keyword ───────────────────────────────────────────────────────
// Same normalized match-type strategy. `matchType` optional here — a bare
// negative term defaults to BROAD, which is how negatives are most commonly
// expressed.
const negativeKeywordSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 250 },
    matchType: {
      type: String,
      enum: KEYWORD_MATCH_TYPES,
      default: 'BROAD',
    },
  },
  valueObjectOpts,
);

// ── RSA asset (headline / description) ─────────────────────────────────────
// Structured entries, NOT opaque strings — this is what lets later phases do
// AI-generated variants, AI scoring, per-asset change tracking, pinning, and
// asset-level performance without a migration.
const headlineAssetSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 60 },
    // Google Ads lets an asset be pinned to position 1/2/3. Null = unpinned.
    pinnedField: {
      type: String,
      enum: ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', null],
      default: null,
    },
  },
  valueObjectOpts,
);

const descriptionAssetSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 120 },
    pinnedField: {
      type: String,
      enum: ['DESCRIPTION_1', 'DESCRIPTION_2', null],
      default: null,
    },
  },
  valueObjectOpts,
);

// ── Ad ─────────────────────────────────────────────────────────────────────
const adSchema = new Schema(
  {
    // Stable draft-local id so the Phase 3 UI and Phase 4 diff engine can
    // address an ad across edits even before it has any Google Ads id.
    id: { type: String, required: true, default: () => randomUUID() },
    type: {
      type: String,
      required: true,
      enum: AD_TYPES,
      default: DEFAULT_AD_TYPE,
    },
    headlines: { type: [headlineAssetSchema], default: [] },
    descriptions: { type: [descriptionAssetSchema], default: [] },
    // Deterministic, network-free URL shape check. Full policy/landing-page
    // validation is a later phase (see structure validator).
    finalUrl: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator(v) {
          if (v == null || v === '') return true;
          try {
            const u = new URL(v);
            return u.protocol === 'http:' || u.protocol === 'https:';
          } catch {
            return false;
          }
        },
        message: 'finalUrl must be a valid http(s) URL',
      },
    },
    path1: { type: String, trim: true, maxlength: 15, default: null },
    path2: { type: String, trim: true, maxlength: 15, default: null },
  },
  { _id: false },
);

// ── Ad group ───────────────────────────────────────────────────────────────
const adGroupSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    keywords: { type: [keywordSchema], default: [] },
    negativeKeywords: { type: [negativeKeywordSchema], default: [] },
    ads: { type: [adSchema], default: [] },
  },
  { _id: false },
);

// ── Campaign extension assets (sitelinks / callouts / structured snippets) ─
// Campaign-scoped (not per-ad-group) — see aiCampaignEnums.js's ASSET_LIMITS
// comment for why. Generated only by Phase 2 (this feature); Claude never
// supplies a sitelink's `finalUrl` directly — generatedCampaignMapper.js
// always forces it from a server-resolved trusted URL (sitelinkResolver.js).
const sitelinkSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    text: { type: String, required: true, trim: true, maxlength: 25 },
    description1: { type: String, trim: true, maxlength: 35, default: null },
    description2: { type: String, trim: true, maxlength: 35, default: null },
    finalUrl: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          try {
            const u = new URL(v);
            return u.protocol === 'http:' || u.protocol === 'https:';
          } catch {
            return false;
          }
        },
        message: 'sitelink finalUrl must be a valid http(s) URL',
      },
    },
  },
  valueObjectOpts,
);

const calloutSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    text: { type: String, required: true, trim: true, maxlength: 25 },
  },
  valueObjectOpts,
);

const structuredSnippetSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    header: { type: String, required: true, trim: true, enum: STRUCTURED_SNIPPET_HEADERS },
    values: { type: [String], default: [] },
  },
  valueObjectOpts,
);

// ── Campaign ───────────────────────────────────────────────────────────────
const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 255 },
    objective: {
      type: String,
      required: true,
      enum: CAMPAIGN_OBJECTIVES,
    },
    // Integer micros — see the money decision in the file header.
    dailyBudgetMicros: {
      type: Number,
      required: true,
      min: [1, 'dailyBudgetMicros must be a positive integer'],
      validate: {
        validator: (v) => Number.isInteger(v),
        message: 'dailyBudgetMicros must be an integer (micros)',
      },
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [CURRENCY_CODE_PATTERN, 'currency must be an ISO 4217 alpha-3 code'],
    },
    biddingStrategy: {
      type: String,
      required: true,
      enum: BIDDING_STRATEGIES,
      default: 'MAXIMIZE_CONVERSIONS',
    },
    locations: { type: [locationSchema], default: [] },
    languages: { type: [languageSchema], default: [] },
    // Additive (see file header §33 note) — every existing draft simply has
    // empty arrays here until regenerated or explicitly edited.
    sitelinks: { type: [sitelinkSchema], default: [] },
    callouts: { type: [calloutSchema], default: [] },
    structuredSnippets: { type: [structuredSnippetSchema], default: [] },
  },
  { _id: false },
);

// Human-facing major-unit budget (micros / 1e6). Read-only — writers set
// dailyBudgetMicros. The sub-schema needs its own virtuals:true toJSON/
// toObject options — the root document's settings don't cascade to
// sub-documents.
campaignSchema.virtual('dailyBudget').get(function getDailyBudget() {
  if (this.dailyBudgetMicros == null) return null;
  return this.dailyBudgetMicros / MICROS_PER_UNIT;
});
campaignSchema.set('toJSON', { virtuals: true });
campaignSchema.set('toObject', { virtuals: true });

// ── AI metadata ────────────────────────────────────────────────────────────
// Provider-agnostic. Deliberately small: identifiers about a generation,
// never the generation's raw output.
const aiMetadataSchema = new Schema(
  {
    provider: { type: String, enum: [...AI_PROVIDERS, null], default: null },
    model: { type: String, trim: true, default: null },
    promptVersion: { type: String, trim: true, default: null },
    generationId: { type: String, trim: true, default: null },
    generatedAt: { type: Date, default: null },
    // POINTER to raw-response storage (e.g. an object-store key / GridFS id)
    // added in a later phase — NOT the payload. Keeps documents small and
    // avoids dumping arbitrary provider JSON into the collection.
    rawResponseRef: { type: String, trim: true, default: null },

    // ── Phase 2 (Claude generation) — all optional, null until a generation
    //    runs. Additive only; nothing in Phase 1 populates or reads these.
    // Normalized token usage (never the prompt or the response text).
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    // Wall-clock duration of the provider call(s) for one generation.
    generationDurationMs: { type: Number, default: null },
    // SAFE last-error record for a failed generation — a classified code and
    // a short message only, never a raw provider error or stack trace.
    lastError: {
      code: { type: String, trim: true, default: null },
      message: { type: String, trim: true, default: null },
      generationId: { type: String, trim: true, default: null },
      at: { type: Date, default: null },
    },
  },
  { _id: false },
);

// ── Change history entry ───────────────────────────────────────────────────
// Foundation for Phase 4 (AI conversational editing → diff → approval).
// `before`/`after` are Mixed because a change can touch a string, a number,
// or a whole sub-object. Key sanitisation against prototype pollution is
// done in the service before anything reaches here.
const changeSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    source: { type: String, required: true, enum: CHANGE_SOURCES },
    action: { type: String, required: true, enum: CHANGE_ACTIONS },
    // Dot/bracket path into the draft, e.g.
    // "adGroups[0].ads[0].headlines[2].text".
    path: { type: String, required: true, trim: true, maxlength: 500 },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// ── Root document ──────────────────────────────────────────────────────────
const aiCampaignDraftSchema = new Schema(
  {
    // Tenant boundary. No standalone index — every compound index below is
    // projectId-prefixed (same reasoning as Lead.js).
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // The Google Ads customer this draft targets. Digits-only, 10 chars, no
    // dashes — matches GoogleConnection.google_ads_customer_id. Shape only
    // in Phase 1; live verification against the connected account happens at
    // publish time (Phase 6).
    googleAdsCustomerId: {
      type: String,
      required: true,
      trim: true,
      match: [
        GOOGLE_ADS_CUSTOMER_ID_PATTERN,
        'googleAdsCustomerId must be a 10-digit Google Ads customer ID (no dashes)',
      ],
    },

    status: {
      type: String,
      enum: DRAFT_STATUSES,
      default: DEFAULT_DRAFT_STATUS,
      required: true,
    },

    campaign: { type: campaignSchema, required: true },
    adGroups: { type: [adGroupSchema], default: [] },

    aiMetadata: { type: aiMetadataSchema, default: () => ({}) },

    // Iterative-editing foundation. Starts at 1; a later phase increments it
    // on each accepted modification. Phase 1 does not implement the full
    // version-history engine but nothing here prevents it.
    version: {
      type: Number,
      default: 1,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'version must be an integer',
      },
    },
    changes: { type: [changeSchema], default: [] },

    // ── Google Ads published identifiers ──────────────────────────────────
    // Reserved. NEVER populated until an actual publish (Phase 6). Kept null
    // here so the model can represent a post-publish draft later without a
    // migration.
    googleAdsCampaignId: { type: String, trim: true, default: null },
    googleAdsAdGroupIds: { type: [String], default: [] },
    googleAdsAdIds: { type: [String], default: [] },
    publishedAt: { type: Date, default: null },

    // Soft delete — matches Lead.js / Task.js.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_drafts',
  },
);

// ── Indexes ────────────────────────────────────────────────────────────────
// Each maps to a concrete access pattern. isDeleted is a low-cardinality
// equality filter that rides inside the project-scoped compound indexes
// (same choice as Lead.js/Task.js) rather than getting its own index.

// Primary list view: a project's drafts, newest first.
aiCampaignDraftSchema.index({ projectId: 1, createdAt: -1 });
// Project + status filter (list?status=…, and Phase 5/6 "ready/validated" scans).
aiCampaignDraftSchema.index({ projectId: 1, status: 1, createdAt: -1 });
// Drafts targeting a specific connected Google Ads account.
aiCampaignDraftSchema.index({ projectId: 1, googleAdsCustomerId: 1 });
// "Drafts I created" (future cross-project view).
aiCampaignDraftSchema.index({ createdBy: 1, createdAt: -1 });

// ── JSON shape ─────────────────────────────────────────────────────────────
// Expose virtuals (campaign.dailyBudget); drop __v.
aiCampaignDraftSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});
aiCampaignDraftSchema.set('toObject', { virtuals: true });

const AiCampaignDraft = mongoose.model('AiCampaignDraft', aiCampaignDraftSchema);

export default AiCampaignDraft;
