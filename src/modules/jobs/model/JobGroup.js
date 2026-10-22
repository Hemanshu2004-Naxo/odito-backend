import mongoose from 'mongoose';

/**
 * JobGroup — coordinates a set of chunk Jobs that together represent one
 * chunked pipeline stage (PAGE_SCRAPING as of Phase C; HEADLESS_ACCESSIBILITY
 * not yet chunked) for one audit run.
 */
const jobGroupSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'SeoProject'
  },
  run_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  stage: {
    type: String,
    required: true,
    enum: ['PAGE_SCRAPING', 'HEADLESS_ACCESSIBILITY']
  },
  total_urls: {
    type: Number,
    required: true,
    min: 0
  },
  chunk_size: {
    type: Number,
    required: true,
    min: 1
  },
  total_chunks: {
    type: Number,
    required: true,
    min: 0
  },
  chunks_completed: {
    type: Number,
    default: 0,
    min: 0
  },
  chunks_failed: {
    type: Number,
    default: 0,
    min: 0
  },
  // retry_rounds_used: how many URL-level retry rounds (PAGE_SCRAPING only —
  // see chainingEngine._maybeCreatePageScrapingRetryChunks) have already
  // been created for this group. Each round adds more chunk jobs (scoped to
  // whatever seo_page_failures still shows unresolved for this run) and
  // increases total_chunks accordingly. Capped at
  // PAGE_SCRAPING_MAX_RETRY_ROUNDS. Irrelevant to HEADLESS_ACCESSIBILITY
  // groups, always 0 there.
  retry_rounds_used: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'partial', 'failed'],
    default: 'pending'
  }
}, {
  collection: 'job_groups',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Primary lookup pattern: "the JobGroup for this project's current run, for this
// stage". Unique so chunk-group creation is idempotent at the database level —
// a duplicate create() (e.g. a race between near-simultaneous completion
// events for the same URL_QUALIFICATION job) fails with a duplicate-key error
// instead of silently creating a second group and a second set of chunk jobs.
jobGroupSchema.index({ project_id: 1, run_id: 1, stage: 1 }, { unique: true });

const JobGroup = mongoose.model('JobGroup', jobGroupSchema);

export default JobGroup;
