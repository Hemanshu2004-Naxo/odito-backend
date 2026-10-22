import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  jobType: {
    type: String,
    required: true,
    enum: ['LINK_DISCOVERY', 'DOMAIN_PERFORMANCE', 'TECHNICAL_DOMAIN', 'URL_QUALIFICATION', 'PAGE_SCRAPING', 'CRAWL_GRAPH', 'PAGE_ANALYSIS', 'PERFORMANCE_MOBILE', 'PERFORMANCE_DESKTOP', 'HEADLESS_ACCESSIBILITY', 'SEO_SCORING', 'AI_VISIBILITY', 'VIDEO_GENERATION', 'HOMEPAGE_VIDEO_GENERATION', 'PROJECT_SEO_AGGREGATION', 'PROJECT_AI_AGGREGATION', 'PROJECT_TASK_VERIFICATION', 'GOOGLE_ADS_SYNC', 'GOOGLE_ADS_KEYWORD_SYNC', 'GOOGLE_ADS_RECOMMENDATION_SYNC']
  },
  // project_id / entityId are required for all project-scoped jobs.
  // They are optional ONLY for non-project jobs like HOMEPAGE_VIDEO_GENERATION,
  // which reference a HomepageAudit via input_data.auditId instead.
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    ref: 'SeoProject'
  },
  entityType: {
    type: String,
    required: true,
    enum: ['project', 'homepage_audit'],
    default: 'project'
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  // input_data conventions (Mixed — no sub-schema, validated by the
  // pre('validate') hook below where noted):
  //
  //   mode: undefined            → Full Audit (default; absence of the field)
  //   mode: 'verification'       → legacy project-wide Quick Recheck
  //   mode: 'url_verification'   → single-URL Verification Engine run (P1-001).
  //                                REQUIRES input_data.target_url: the one
  //                                http(s) URL this run verifies. target_url
  //                                is also the key of the per-URL locking
  //                                index (unique_url_verification_target).
  //
  // Independently of mode, project-wide seed jobs also carry
  // input_data.run_source (jobs/runSources.js: 'manual_recrawl',
  // 'initial_audit', 'admin_recrawl', 'manual_recheck', 'weekly_recheck') —
  // who/what started the run. Purely informational for tracking/logs/
  // analytics; nothing in the chaining engine branches on it.
  //
  // Any other mode value is rejected at validation time: chainingEngine's
  // dependency gate branches on this exact string, and an unrecognized value
  // silently falls into the full-audit branch — which for a verification-
  // style run waits forever on a PERFORMANCE_DESKTOP job that never comes.
  input_data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {}
  },
  result_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['pending', 'claimed', 'processing', 'completed', 'failed', 'retrying'],
    default: 'pending',
    required: true
  },
  priority: {
    type: Number,
    required: true,
    default: 1
  },
  attempts: {
    type: Number,
    default: 0
  },
  max_attempts: {
    type: Number,
    default: 3
  },
  last_attempted_at: {
    type: Date,
    default: null
  },
  dispatchedAt: {
    type: Date,
    default: null
  },
  error: {
    message: String,
    stack: String,
    timestamp: Date
  },
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  currentStep: {
    type: String,
    default: ''
  },
  claimed_at: Date,
  started_at: Date,
  completed_at: Date,

  // ── JobGroup / run isolation (additive; unused by non-chunked job types) ──
  // run_id: minted once per audit execution (startProjectAudit/startVerification)
  // and propagated onto every job created during that run. Lets queries scope
  // by "this run" instead of "this project" (which can span many historical
  // runs), and lets a stale job from a superseded run be distinguished from
  // the current one even if cleanup didn't fully complete.
  run_id: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  // group_id: set only on chunk jobs created under a JobGroup (PAGE_SCRAPING/
  // HEADLESS_ACCESSIBILITY chunking, not yet implemented as of this phase).
  // null for every other job type.
  group_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobGroup',
    default: null
  },
  // chunk_index: 0-based position within its group. Informational/ordering
  // only — not used by any completion-detection logic.
  chunk_index: {
    type: Number,
    default: null
  },
  // chunk_recorded: idempotency guard for JobGroup counter accounting.
  // Flipped false→true exactly once, atomically, by
  // chainingEngine.recordChunkOutcome the first time this job's terminal
  // outcome (completed/failed) is processed. Prevents duplicate
  // completeJob/failJob delivery (worker retries, redelivered callbacks,
  // concurrent requests) from incrementing a JobGroup's
  // chunks_completed/chunks_failed more than once for the same physical
  // chunk. Unused/always false for non-chunked job types.
  chunk_recorded: {
    type: Boolean,
    default: false
  }
}, {
  collection: 'jobs',
  strict: false,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes for performance
jobSchema.index({ status: 1, priority: -1, created_at: 1 });
jobSchema.index({ project_id: 1, status: 1 });
jobSchema.index({ user_id: 1, created_at: -1 });
jobSchema.index({ jobType: 1, status: 1 });
jobSchema.index({ entityType: 1, entityId: 1, status: 1 });
jobSchema.index({ project_id: 1, run_id: 1, jobType: 1 });
jobSchema.index({ group_id: 1, status: 1 });

// Pre-save validation to prevent incorrect state transitions
jobSchema.pre('save', function(next) {
  const usePullModel = process.env.USE_PULL_MODEL === 'true';
  
  // In PULL mode, jobs should never be created with processing status
  if (usePullModel && this.isNew && this.status === 'processing') {
    console.error(`[JOB_VALIDATION] ❌ CRITICAL: Job created with status='processing' in PULL mode | jobId=${this._id} | jobType=${this.jobType}`);
    console.error(`[JOB_VALIDATION] Jobs must be created with status='pending' in PULL mode. Correcting to 'pending'.`);
    this.status = 'pending';
  }
  
  // In PULL mode, jobs should never have dispatchedAt set on creation
  if (usePullModel && this.isNew && this.dispatchedAt) {
    console.error(`[JOB_VALIDATION] ❌ CRITICAL: Job created with dispatchedAt set in PULL mode | jobId=${this._id} | jobType=${this.jobType}`);
    console.error(`[JOB_VALIDATION] dispatchedAt should only be set by worker claim. Removing dispatchedAt.`);
    this.dispatchedAt = null;
  }
  
  // Validate status transitions
  const validTransitions = {
    'pending': ['processing', 'failed', 'retrying'],
    'processing': ['completed', 'failed', 'retrying'],
    'retrying': ['processing', 'failed'],
    'completed': [],
    'failed': ['pending', 'retrying']
  };
  
  if (!this.isNew && this.isModified('status')) {
    const previousStatus = this._doc.status;
    const allowedTransitions = validTransitions[previousStatus] || [];
    
    if (!allowedTransitions.includes(this.status)) {
      console.error(`[JOB_VALIDATION] ❌ Invalid status transition | jobId=${this._id} | jobType=${this.jobType} | from=${previousStatus} | to=${this.status}`);
      console.error(`[JOB_VALIDATION] Allowed transitions from ${previousStatus}:`, allowedTransitions);
    }
  }
  
  next();
});

// P1-001: input_data.mode / target_url validation.
//
// Additive and scoped: only runs when input_data.mode is actually present.
// Job types that never set it (Full Audit's PAGE_SCRAPING/HEADLESS_ACCESSIBILITY,
// HOMEPAGE_VIDEO_GENERATION, every other job type) are completely unaffected —
// `mode` stays undefined for them and this hook is a no-op.
//
// A separate hook (not merged into the status-transition one above) so each
// concern is independently reviewable/revertible.
const VALID_INPUT_DATA_MODES = ['verification', 'url_verification'];

jobSchema.pre('validate', function(next) {
  const mode = this.input_data?.mode;

  if (mode === undefined || mode === null) {
    return next();
  }

  if (!VALID_INPUT_DATA_MODES.includes(mode)) {
    return next(new Error(
      `Invalid input_data.mode: '${mode}'. Must be one of: ${VALID_INPUT_DATA_MODES.join(', ')}`
    ));
  }

  if (mode === 'url_verification') {
    const targetUrl = this.input_data?.target_url;

    if (typeof targetUrl !== 'string' || targetUrl.trim() === '') {
      return next(new Error(
        `input_data.target_url is required and must be a non-empty string when input_data.mode is 'url_verification'`
      ));
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (urlError) {
      return next(new Error(`input_data.target_url is not a valid URL: '${targetUrl}'`));
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return next(new Error(
        `input_data.target_url must be an http(s) URL, got protocol '${parsed.protocol}' for '${targetUrl}'`
      ));
    }
  }

  next();
});

// AI Visibility duplicate prevention index
jobSchema.index(
  {
    project_id: 1,
    jobType: 1,
    status: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'AI_VISIBILITY',
      status: { $in: ['pending', 'processing'] }
    }
  }
);

// P1-001: prevents duplicate PAGE_SCRAPING URL-verification jobs for the
// same {project, target_url} while pending/processing.
//
// Everything else is excluded by the partial filter expression, not by the
// index keys — so it never applies to:
//   - Full Audit jobs                 (input_data.mode !== 'url_verification')
//   - completed verification jobs     (status not in [pending, processing])
//   - failed verification jobs        (status not in [pending, processing])
//   - other job types                 (jobType !== 'PAGE_SCRAPING')
//   - a different target_url          (different index key value)
//   - a different project             (different index key value)
//
// name is explicit so repeated createIndex calls (deploy re-runs, worker
// restarts) resolve to the same index rather than risking a duplicate
// auto-named one.
jobSchema.index(
  {
    project_id: 1,
    jobType: 1,
    'input_data.target_url': 1
  },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'PAGE_SCRAPING',
      'input_data.mode': 'url_verification',
      status: { $in: ['pending', 'processing'] }
    },
    name: 'unique_url_verification_target'
  }
);

// Google Ads sync duplicate prevention index (Phase 6.3) — same shape as the
// AI Visibility index above: at most one GOOGLE_ADS_SYNC job per project may
// be pending/processing at a time, so a user mashing "Refresh" (or the
// scheduler-free retry path) can't stack up overlapping syncs against the
// same GoogleConnection/customer.
jobSchema.index(
  {
    project_id: 1,
    jobType: 1,
    status: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'GOOGLE_ADS_SYNC',
      status: { $in: ['pending', 'processing'] }
    },
    name: 'unique_google_ads_sync_in_flight'
  }
);

// Phase 6.4 — same "at most one in flight per project" guard, applied to the
// two new independently-triggerable Google Ads sync job types.
jobSchema.index(
  { project_id: 1, jobType: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'GOOGLE_ADS_KEYWORD_SYNC',
      status: { $in: ['pending', 'processing'] }
    },
    name: 'unique_google_ads_keyword_sync_in_flight'
  }
);

jobSchema.index(
  { project_id: 1, jobType: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'GOOGLE_ADS_RECOMMENDATION_SYNC',
      status: { $in: ['pending', 'processing'] }
    },
    name: 'unique_google_ads_recommendation_sync_in_flight'
  }
);

const Job = mongoose.model('Job', jobSchema);

export default Job;
