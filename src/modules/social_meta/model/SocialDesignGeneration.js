import mongoose from 'mongoose';
import { DESIGN_RECORD_TTL_DAYS } from '../service/aiDesign/designConfig.js';

/**
 * SocialDesignGeneration - bookkeeping for ONE AI design (image) generation for ONE publication.
 *
 * It exists because a generation can fail before any media exists (nothing else could hold that failure), and
 * because the lock that stops a double click / two tabs from creating two designs must live in the database.
 * It is METADATA ONLY: no prompt, no provider output, no image bytes, no business-profile copy, no key. The
 * product of a successful generation is the media on the SocialPublication itself (a stored file + its URL);
 * `result.mediaUrl` is just a pointer for the status view.
 *
 * States: generating -> attaching -> ready | failed. `active` is true while generating/attaching; a partial
 * unique index on {publication_id} WHERE active allows at most ONE generation in flight per publication,
 * across processes and instances. Every transition is a conditional update keyed on `generation.lockedBy`, so a
 * run that was recovered as stale (or superseded) can never attach media or overwrite a newer outcome.
 *
 * The versions pin what the design was made for: `contentVersion` (the approved caption) and
 * `baseDesignVersion` (the design version the claim saw). The media is attached only if both are still current.
 */
export const DESIGN_GENERATION_STATUSES = ['generating', 'attaching', 'ready', 'failed'];

/**
 * Creative Studio candidates. A STUDIO generation produces several (three) distinct creative directions for ONE post. They are
 * stored files in the project's media storage but are NOT the post's design: nothing is attached to the SocialPublication until a
 * person selects one (attachGeneratedDesign, pinned to the post's versions). Regenerating or refining one candidate re-runs only that
 * slot of the same record. Metadata only: no prompt, no provider output, no image bytes (the file is referenced by URL + storage key).
 */
const candidateSchema = new mongoose.Schema({
  slot: { type: Number, required: true, min: 0, max: 5 },
  creativeType: { type: String, default: null, maxlength: 40 },
  label: { type: String, default: null, maxlength: 80 },
  status: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending' },
  revision: { type: Number, default: 1, min: 1 }, // +1 every time this slot is regenerated / refined
  media: {
    url: { type: String, default: null, maxlength: 600 },
    storageKey: { type: String, default: null, maxlength: 200 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, default: null },
  },
  layoutId: { type: String, default: null, maxlength: 40 },
  // the AI photograph this design was composed over, kept (project-scoped, deleted with the candidate) so a refinement can re-compose without a new picture
  visual: { url: { type: String, default: null, maxlength: 600 }, storageKey: { type: String, default: null, maxlength: 200 } },
  logoApplied: { type: Boolean, default: false },
  referencePhotos: { type: Number, default: 0 },
  notes: { type: [String], default: [] },
  instruction: { type: String, default: null, maxlength: 400 }, // the person's change request that produced this revision (their own words)
  failure: { code: { type: String, default: null }, message: { type: String, default: null } },
  attached: { type: Boolean, default: false }, // this candidate's media was attached as the post's design
  attachedDesignVersion: { type: Number, default: null },
  generatedAt: { type: Date, default: null },
});

const socialDesignGenerationSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  publication_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialPublication', required: true },
  status: { type: String, enum: DESIGN_GENERATION_STATUSES, required: true, default: 'generating' },
  active: { type: Boolean, default: true },

  platform: { type: String, enum: ['facebook', 'instagram'], required: true },
  contentVersion: { type: Number, required: true, min: 1 },
  baseDesignVersion: { type: Number, required: true, min: 1 },
  // the approval state the claim saw; decides whether the design is submitted for review after it is attached
  baseApprovalState: { type: String, enum: ['content_approved', 'design_review', 'design_approved'], required: true },
  replaceApproved: { type: Boolean, default: false },

  // 'single' = the original one-image flow (attached and submitted for review by the run itself); 'studio' = Creative Studio candidates.
  mode: { type: String, enum: ['single', 'studio'], default: 'single' },
  studio: {
    action: { type: String, enum: ['generate_all', 'regenerate', null], default: null },
    candidateId: { type: mongoose.Schema.Types.ObjectId, default: null },
    instruction: { type: String, default: null, maxlength: 400 },
    productMediaIds: { type: [mongoose.Schema.Types.ObjectId], default: [] }, // the product photos the person chose for the design
  },
  candidates: { type: [candidateSchema], default: [] },

  provider: { type: String, default: null },
  model: { type: String, default: null },
  size: { type: String, default: null },

  result: {
    designVersion: { type: Number, default: null },
    mediaUrl: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, default: null },
  },

  // Which creative direction the design brief chose and which REAL assets it used. Codes and counts only - never the prompt
  // and never any text of the post.
  creative: {
    type: { type: String, default: null, maxlength: 40 },
    label: { type: String, default: null, maxlength: 80 },
    layoutId: { type: String, default: null, maxlength: 40 },
    briefVersion: { type: String, default: null, maxlength: 60 },
    logoApplied: { type: Boolean, default: false },
    referencePhotos: { type: Number, default: 0 },
    notes: { type: [String], default: [] },
  },

  generation: {
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    promptVersion: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    providerMs: { type: Number, default: null },
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
  },

  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_design_generations',
});

// At most ONE design generation in flight per publication (database-enforced, across processes).
socialDesignGenerationSchema.index(
  { publication_id: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'unique_design_generation_in_flight' },
);
socialDesignGenerationSchema.index({ project_id: 1, publication_id: 1, createdAt: -1 }, { name: 'design_generation_publication_recent' });
socialDesignGenerationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: Math.round(DESIGN_RECORD_TTL_DAYS * 24 * 60 * 60), partialFilterExpression: { active: false }, name: 'design_generation_ttl' },
);

const SocialDesignGeneration = mongoose.model('SocialDesignGeneration', socialDesignGenerationSchema);
export default SocialDesignGeneration;
