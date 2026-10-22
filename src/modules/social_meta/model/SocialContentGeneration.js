import mongoose from 'mongoose';
import { CONTENT_RECORD_TTL_DAYS } from '../service/aiContent/contentConfig.js';

/**
 * SocialContentGeneration - the minimal bookkeeping record of ONE single-post
 * AI generation. The PRODUCT of a generation is the real SocialPublication draft
 * (this record only points at it); this record exists because a generation can
 * fail before any draft exists, and because a database-enforced lock is needed so
 * two clicks / tabs / retries cannot create two drafts.
 *
 * It stores no prompt, no provider response, no key and no token. Finished
 * records expire automatically (TTL) - the draft keeps its own provenance.
 *
 * Concurrency (same pattern as SocialAIStrategy):
 *  - unique {project_id} WHERE status = 'generating'  -> at most ONE generation in
 *    flight per project, across processes
 *  - results are written by conditional updates keyed on the lock owner, so an
 *    interrupted / superseded run can never overwrite a newer outcome.
 */
export const CONTENT_GENERATION_STATUSES = ['generating', 'ready', 'failed'];

const socialContentGenerationSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  status: { type: String, enum: CONTENT_GENERATION_STATUSES, required: true, default: 'generating' },

  // What was asked for (already validated against the strategy)
  request: {
    platform: { type: String, required: true },
    contentPillar: { type: String, required: true, maxlength: 100 },
    objective: { type: String, required: true, maxlength: 40 },
  },

  // The stored strategy / profile snapshot the post is written from
  strategy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAIStrategy', required: true },
    version: { type: Number, required: true },
    profileSnapshotHash: { type: String, default: null },
    profileSnapshotGeneratedAt: { type: Date, default: null },
  },
  social_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', required: true },
  // Set only when the post is written FROM a content-calendar item (the plan is then part of the prompt, and the finished
  // draft is linked back to the item). Never read from a request body: the calendar service sets it from a project-scoped lookup.
  calendar_item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialContentCalendarItem', default: null },

  // The result: a pointer to the real draft, plus the AI notes shown beside it
  publication_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialPublication', default: null },
  result: {
    callToAction: { type: String, default: null },
    hashtags: { type: [String], default: [] },
    rationale: { type: String, default: null },
  },

  generation: {
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    promptVersion: { type: String, default: null },
    model: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    usage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 } },
  },

  // Odito-level, user-safe failure (never a provider message, prompt or key)
  failure: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
  },

  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_content_generations',
});

socialContentGenerationSchema.index(
  { project_id: 1 },
  { unique: true, partialFilterExpression: { status: 'generating' }, name: 'unique_content_generating_in_flight' },
);
socialContentGenerationSchema.index({ project_id: 1, createdAt: -1 }, { name: 'content_generation_project_recent' });
// Finished records are bookkeeping only; in-flight ones are handled by stale recovery, never by TTL.
socialContentGenerationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: Math.round(CONTENT_RECORD_TTL_DAYS * 24 * 60 * 60), partialFilterExpression: { status: { $in: ['ready', 'failed'] } }, name: 'content_generation_ttl' },
);

const SocialContentGeneration = mongoose.model('SocialContentGeneration', socialContentGenerationSchema);
export default SocialContentGeneration;
