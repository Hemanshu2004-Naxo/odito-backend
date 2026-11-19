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
  // the photograph could not be made, so this design uses a layout without one: the user-safe code and the sentence shown with it
  fallback: { code: { type: String, default: null }, message: { type: String, default: null } },
  instruction: { type: String, default: null, maxlength: 400 }, // the person's change request that produced this revision (their own words)
  failure: { code: { type: String, default: null }, message: { type: String, default: null } },
  attached: { type: Boolean, default: false }, // this candidate's media was attached as the post's design
  attachedDesignVersion: { type: Number, default: null },
  generatedAt: { type: Date, default: null },
  // Concept Studio (additive): the concept behind a Compare preview, the preview quality and its cost
  concept: { type: mongoose.Schema.Types.Mixed, default: null },
  quality: { type: String, default: null, maxlength: 10 },
  costUsd: { type: Number, default: null },
});

/**
 * One slide of a carousel design (Concept Studio). The post's media holds the slides in order; this keeps what each slide is, how it was
 * made, its quality check and whether it needs attention, so a single slide can be regenerated, moved or removed. Metadata + file pointers only.
 */
const slideSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 20 }, // 'hook' | 'p1'..'p10' | 'cta' - stable across reorders
  kind: { type: String, enum: ['hook', 'point', 'cta'], required: true },
  position: { type: Number, required: true, min: 0, max: 9 },
  status: { type: String, enum: ['pending', 'generating', 'ready', 'failed'], default: 'pending' },
  stage: { type: String, default: null, maxlength: 20 }, // image | text | quality while it is being made
  media: {
    url: { type: String, default: null, maxlength: 600 },
    storageKey: { type: String, default: null, maxlength: 200 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, default: null },
  },
  picture: { url: { type: String, default: null, maxlength: 600 }, storageKey: { type: String, default: null, maxlength: 200 } },
  concept: { type: mongoose.Schema.Types.Mixed, default: null },
  imagePrompt: { type: String, default: null, maxlength: 8000 },
  image: { model: String, modelReturned: String, fallbackUsed: Boolean, quality: String, size: String, references: Number },
  qc: {
    score: { type: Number, default: null },
    passed: { type: Boolean, default: false },
    issues: { type: [String], default: [] },
    retries: { type: [String], default: [] },
    needsAttention: { type: { _id: false, score: Number, failure: String, reasons: [String] }, default: null },
  },
  costUsd: { type: Number, default: null },
  revision: { type: Number, default: 1 },
  failure: { code: { type: String, default: null }, message: { type: String, default: null } },
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
    // Concept Studio (additive): 'concept' records use the concept pipeline; 'rules' (or null) the original studio
    pipeline: { type: String, enum: ['concept', 'rules', null], default: null },
    phase: { type: String, enum: ['compare', 'render', 'slide', null], default: null },
    format: { type: String, enum: ['single', 'carousel', null], default: null },
    pickedCandidateId: { type: mongoose.Schema.Types.ObjectId, default: null },
    slideKey: { type: String, default: null, maxlength: 20 }, // the slide a 'slide' job regenerates
    action: { type: String, enum: ['generate_all', 'regenerate', 'render', 'regenerate_slide', null], default: null },
    candidateId: { type: mongoose.Schema.Types.ObjectId, default: null },
    instruction: { type: String, default: null, maxlength: 400 },
    productMediaIds: { type: [mongoose.Schema.Types.ObjectId], default: [] }, // the product photos the person chose for the design
  },
  candidates: { type: [candidateSchema], default: [] },
  // Concept Studio carousel (additive): the ordered slides and the brief / reference picture they were made from
  slides: { type: [slideSchema], default: [] },
  // Approvals given although the design had slides (or a single image) below the quality bar: who, when, which version, which slides
  approvedWithAttention: {
    type: [{ _id: false, userId: { type: mongoose.Schema.Types.ObjectId, default: null }, at: Date, designVersion: Number, slides: [Number], count: Number }],
    default: [],
  },
  carousel: {
    brief: { type: mongoose.Schema.Types.Mixed, default: null },
    // The carousel's points ([{ number, text }]): the caption's own numbered/bulleted list, or Claude's outline of the caption
    // (pointsSource 'outline'). Stored so every later step (slides, a regenerated slide) uses the same points. Additive.
    points: { type: mongoose.Schema.Types.Mixed, default: null },
    pointsSource: { type: String, default: null },
    reference: { url: { type: String, default: null, maxlength: 600 }, storageKey: { type: String, default: null, maxlength: 200 } },
  },

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

  // Which creative direction the design brief chose and which REAL assets it used. For a CONCEPT design (pipeline 'concept') it
  // also keeps the brief as drawn, the exact image prompt, the image model ids and the quality check, so a version can be explained,
  // regenerated or tweaked later (approved: additive fields). Never a key or a provider response.
  creative: {
    pipeline: { type: String, default: null, maxlength: 20 }, // 'concept' | 'rules' (null = a record from before the concept pipeline)
    concept: {
      format: { type: String, default: null, maxlength: 20 },
      big_idea: { type: String, default: null, maxlength: 400 },
      hook_headline: { type: String, default: null, maxlength: 120 },
      subline: { type: String, default: null, maxlength: 160 },
      cta: { type: String, default: null, maxlength: 80 },
      kicker: { type: String, default: null, maxlength: 80 },
      visual_style: { type: String, default: null, maxlength: 40 },
      layout: { type: String, default: null, maxlength: 40 },
      image_prompt: { type: String, default: null, maxlength: 4000 },
      headline_candidates: { type: [String], default: [] },
      image_labels: { type: [{ _id: false, text: { type: String, maxlength: 40 }, position: { type: String, maxlength: 10 } }], default: [] },
    },
    imagePrompt: { type: String, default: null, maxlength: 8000 },
    image: {
      model: { type: String, default: null, maxlength: 80 },          // the model requested (alias or pinned snapshot)
      modelReturned: { type: String, default: null, maxlength: 80 },  // the exact model id the response reported
      fallbackUsed: { type: Boolean, default: false },
      quality: { type: String, default: null, maxlength: 10 },
      size: { type: String, default: null, maxlength: 20 },
      seed: { type: String, default: null, maxlength: 40 },           // the image API takes no seed today; kept for providers that do
      referenceImages: { type: Number, default: 0 },
    },
    qc: {
      score: { type: Number, default: null },
      passed: { type: Boolean, default: false },
      hardFail: { type: Boolean, default: false },
      wordCount: { type: Number, default: null },
      issues: { type: [String], default: [] },
      checks: { type: mongoose.Schema.Types.Mixed, default: null },
      attempts: { type: Number, default: 0 },
      retries: { type: [String], default: [] }, // 'concept' | 'picture' | 'headline', in order
      // below the bar after its retry: shown with a badge, the reasons and a regenerate button (never shipped silently)
      needsAttention: {
        type: { _id: false, score: Number, failure: String, reasons: [String] },
        default: null,
      },
    },
    type: { type: String, default: null, maxlength: 40 },
    label: { type: String, default: null, maxlength: 80 },
    layoutId: { type: String, default: null, maxlength: 40 },
    briefVersion: { type: String, default: null, maxlength: 60 },
    logoApplied: { type: Boolean, default: false },
    referencePhotos: { type: Number, default: 0 },
    notes: { type: [String], default: [] },
    // the photograph could not be made, so the design uses a layout without one: the user-safe code and the sentence shown with it
    fallback: { code: { type: String, default: null }, message: { type: String, default: null } },
  },

  // What this design version cost (USD, from token usage x the configured prices) and every call behind it.
  cost: {
    usd: { type: Number, default: null },
    calls: {
      type: [{
        _id: false, step: String, kind: String, model: String, modelReturned: String,
        inputTokens: Number, outputTokens: Number, durationMs: Number, usd: Number,
      }],
      default: [],
    },
  },

  generation: {
    // progress for the UI: concept -> image -> text -> quality (null for the rule-based designs)
    stage: { type: String, default: null, maxlength: 20 },
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
