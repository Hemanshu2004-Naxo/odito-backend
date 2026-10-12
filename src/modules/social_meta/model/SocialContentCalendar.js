import mongoose from 'mongoose';

/**
 * SocialContentCalendar — one document per calendar VERSION per project: the run record (config, strategy pin, plan
 * summary, generation bookkeeping). The calendar's content is NOT stored here: it is one SocialContentCalendarItem
 * per planned post, so a calendar is queryable, referenceable (a post can point at its item) and never one giant JSON.
 *
 * Every generation creates its own document and is ALSO its own durable job record. Lifecycle:
 *   generating  a worker owns it (`generation.lockedBy`) and renews `generation.lease.expiresAt` every few seconds; the batches
 *               it has finished are already saved as items, so nothing is lost if the process dies
 *   (lease expired)  the owner is gone: any instance may take it over and continue from the saved batches (recovery sweep)
 *   partial     it stopped after saving SOME batches (a provider outage, a refused answer, the retry budget used up): the saved
 *               posts are kept and the person can resume it - only the missing batches are generated and paid for
 *   ready       every post is saved; the previous ready version becomes `archived`
 *   failed      it stopped before any post was saved
 *   cancelled   the person (or a project deletion) stopped it; its unfinished posts are discarded
 * A generation that is not `ready` never replaces the last good calendar. "The current calendar" is the highest `ready` version.
 *
 * Concurrency is enforced by the database (same pattern as SocialAIStrategy):
 *  - unique {project_id, version}                       -> versions never collide
 *  - unique {project_id} WHERE status = 'generating'    -> at most ONE generation in flight per project
 *  - every status transition is a conditional update keyed on the lock owner.
 *
 * `strategy` pins the exact strategy version (and the profile snapshot hash it was built from) the calendar was
 * planned from, so it can later say "generated from Strategy v3" and "your strategy has changed since".
 */
export const CALENDAR_STATUSES = ['generating', 'partial', 'ready', 'failed', 'cancelled', 'archived'];
export const DISTRIBUTION_MODES = ['ai_optimized', 'balanced', 'platform_specific'];

const pillarDistributionSchema = new mongoose.Schema({
  pillar: { type: String, required: true, maxlength: 100 },
  targetPercent: { type: Number, required: true },
  plannedCount: { type: Number, required: true },
  plannedPercent: { type: Number, required: true },
}, { _id: false });

const socialContentCalendarSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  status: { type: String, enum: CALENDAR_STATUSES, required: true, default: 'generating' },

  // What the USER chose (validated by the server before this document exists)
  config: {
    startDate: { type: String, required: true }, // YYYY-MM-DD, no timezone: a calendar date
    endDate: { type: String, required: true }, // the LAST day of the period (inclusive)
    // how many calendar months the person chose (1-6); null for a calendar made from an explicit date range (older clients / data)
    months: { type: Number, min: 1, max: 6, default: null },
    postsPerWeek: { type: Number, required: true, min: 1, max: 7 },
    platforms: { type: [String], required: true },
    distributionMode: { type: String, enum: DISTRIBUTION_MODES, required: true },
  },

  strategy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAIStrategy', required: true },
    version: { type: Number, required: true },
    profileSnapshotHash: { type: String, default: null },
  },

  // What was planned (written when the run finishes)
  plan: {
    totalItems: { type: Number, default: 0 },
    pillarDistribution: { type: [pillarDistributionSchema], default: [] },
    platformCounts: { type: Map, of: Number, default: undefined },
    // Honest notes about what Odito adjusted (e.g. a repeated product reference it cleared)
    warnings: { type: [String], default: [] },
  },

  generation: {
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    // Liveness: renewed by the owning worker's heartbeat; when it passes, the owner is presumed dead and the run can be taken over.
    lease: { expiresAt: { type: Date, default: null } },
    heartbeatAt: { type: Date, default: null },
    // How many times this generation has been started (the first run counts; a take-over or a resume starts another)
    runAttempts: { type: Number, default: 0 },
    // Server-owned progress (what the status endpoint reports): posts saved so far out of the total, batches likewise
    progress: {
      totalPosts: { type: Number, default: 0 },
      plannedPosts: { type: Number, default: 0 },
      totalBatches: { type: Number, default: 0 },
      completedBatches: { type: Number, default: 0 },
    },
    // The last transient problem a run is waiting out ("the provider was busy; trying again at ..."): a code and a time, never a provider message
    retry: { code: { type: String, default: null }, at: { type: Date, default: null } },
    promptVersion: { type: String, default: null },
    model: { type: String, default: null },
    batches: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    usage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 } },
  },

  // Odito-level, user-safe failure (never a provider message, prompt or key)
  failure: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
    // WHICH validation rules refused the AI's plan (paths + codes + generic rules only: never a value, a prompt or a provider text); for diagnosis, never sent to the client
    validation: { type: [new mongoose.Schema({ attempt: Number, batch: Number, path: String, code: String, rule: String }, { _id: false })], default: [] },
  },

  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_content_calendars',
});

socialContentCalendarSchema.index({ project_id: 1, version: 1 }, { unique: true, name: 'unique_calendar_version' });
socialContentCalendarSchema.index(
  { project_id: 1 },
  { unique: true, partialFilterExpression: { status: 'generating' }, name: 'unique_calendar_generating_in_flight' },
);
socialContentCalendarSchema.index({ project_id: 1, status: 1, version: -1 }, { name: 'calendar_project_status_version' });

const SocialContentCalendar = mongoose.model('SocialContentCalendar', socialContentCalendarSchema);
export default SocialContentCalendar;
