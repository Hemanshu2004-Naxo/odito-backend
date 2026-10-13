import mongoose from 'mongoose';

/**
 * SocialAIStrategy — one document per strategy VERSION per project.
 *
 * Every generation attempt creates its own document: it starts as
 * `generating`, and ends `ready` (validated strategy saved) or `failed`.
 * When a newer version becomes `ready`, the previous ready version is marked
 * `archived`, so history is kept without a history UI and a FAILED attempt
 * never replaces the last good strategy. "The current strategy" is the highest
 * `ready` version.
 *
 * States (only the ones the flow needs): generating | ready | failed | archived.
 *
 * Concurrency is enforced by the database, not by memory:
 *  - unique {project_id, version}                       -> versions never collide
 *  - unique {project_id} WHERE status = 'generating'    -> at most ONE generation
 *    in flight per project, even across processes/instances
 *  - every status transition is a conditional update that names the state (and,
 *    for the generation result, the lock owner) it is legal from, so a stale or
 *    interrupted run can never overwrite a newer outcome.
 *
 * `profileSnapshot` is the exact (compact, token-free) business profile the AI
 * was given, plus a deterministic hash used to tell later whether the Business
 * Profile has changed since. It stores no Google tokens, connection ids or
 * credentials — only the business facts.
 */
export const STRATEGY_STATUSES = ['generating', 'ready', 'failed', 'archived'];

const gapSchema = new mongoose.Schema({
  field: { type: String, required: true, maxlength: 60 },
  reason: { type: String, required: true, maxlength: 300 },
  importance: { type: String, enum: ['high', 'medium', 'low'], required: true },
  source: { type: String, enum: ['profile', 'ai'], default: 'profile' },
}, { _id: false });

const socialAIStrategySchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  status: { type: String, enum: STRATEGY_STATUSES, required: true, default: 'generating' },

  // The validated strategy (see service/aiStrategy/strategyOutputSchema.js). Empty while generating / failed.
  strategy: { type: mongoose.Schema.Types.Mixed, default: null },
  strategyGaps: { type: [gapSchema], default: [] },

  // The person's planning choice made when this version was created (posts per week, months, platforms, the planner's estimate). null on
  // versions saved before the wizard existed: those stay readable and simply have no saved choice. Never edited in place: a new choice is a new version.
  planning: {
    type: new mongoose.Schema({
      postsPerWeek: { type: Number, required: true, min: 1, max: 7 },
      months: { type: Number, required: true, min: 1, max: 6 },
      platforms: { type: [String], default: [] },
      estimatedPosts: { type: Number, default: null },
      basisStartDate: { type: String, default: null },
      confirmedAt: { type: Date, default: null },
    }, { _id: false }),
    default: null,
  },

  profileSnapshot: {
    generatedAt: { type: Date, default: null },
    hash: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },

  generation: {
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    // the client's idempotency key for this start: the same key never creates a second version (a retry after a lost response)
    requestId: { type: String, default: null, maxlength: 80 },
    promptVersion: { type: String, default: null },
    model: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
    },
  },

  // Odito-level, user-safe failure (never a provider message, prompt or key)
  failure: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
    // WHICH validation rules refused the AI's answer (paths + codes + generic rules only: never a value, a prompt or a provider text); kept for diagnosis, never sent to the client
    validation: { type: [new mongoose.Schema({ attempt: Number, path: String, code: String, rule: String }, { _id: false })], default: [] },
  },

  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_ai_strategies',
});

socialAIStrategySchema.index({ project_id: 1, version: 1 }, { unique: true, name: 'unique_strategy_version' });
// At most one generation in flight per project (partial unique index).
socialAIStrategySchema.index(
  { project_id: 1 },
  { unique: true, partialFilterExpression: { status: 'generating' }, name: 'unique_strategy_generating_in_flight' },
);
socialAIStrategySchema.index({ project_id: 1, status: 1, version: -1 }, { name: 'strategy_project_status_version' });

const SocialAIStrategy = mongoose.model('SocialAIStrategy', socialAIStrategySchema);
export default SocialAIStrategy;
