export const JOB_TYPES = {
  // Keyword Jobs
  KEYWORD_RANKING: 'KEYWORD_RANKING',

  // Report Jobs
  REPORT_GENERATION: 'REPORT_GENERATION',

  // SEO Audit Jobs (migrated from AuditJob)
  SEO_AUDIT: 'SEO_AUDIT',

  // Comprehensive SEO Crawl Jobs
  SEO_CRAWL: 'SEO_CRAWL',

  // Individual SEO Page Crawl Jobs
  SEO_PAGE_CRAWL: 'SEO_PAGE_CRAWL',

  // 🆕 NEW SCRAPING PIPELINE
  LINK_DISCOVERY: 'LINK_DISCOVERY',
  DOMAIN_PERFORMANCE: 'DOMAIN_PERFORMANCE',
  TECHNICAL_DOMAIN: 'TECHNICAL_DOMAIN',
  PAGE_SCRAPING: 'PAGE_SCRAPING',
  PAGE_ANALYSIS: 'PAGE_ANALYSIS',
  SEO_SCORING: 'SEO_SCORING',

  // Performance Analysis Jobs
  PERFORMANCE_MOBILE: 'PERFORMANCE_MOBILE',
  PERFORMANCE_DESKTOP: 'PERFORMANCE_DESKTOP',

  // URL Qualification — probes discovered URLs and emits canonical URL list
  URL_QUALIFICATION: 'URL_QUALIFICATION',

  // Headless Accessibility Analysis
  HEADLESS_ACCESSIBILITY: 'HEADLESS_ACCESSIBILITY',

  // Crawl Graph Analysis (internal link graph)
  CRAWL_GRAPH: 'CRAWL_GRAPH',

  // AI Visibility Jobs (V2 pipeline — self-contained, no separate scoring stage)
  AI_VISIBILITY: 'AI_VISIBILITY',

  // F4-016: Verification Batch project-level aggregation chain. Each of
  // these runs exactly ONCE per Verification Batch (never once per URL),
  // triggered only after the F4-015 batch barrier detects every
  // PageVerificationRun in the batch has reached a terminal state. See
  // pipelineConfig.js for the SEO_AGG -> AI_AGG -> TASK_VERIFICATION chain.
  PROJECT_SEO_AGGREGATION: 'PROJECT_SEO_AGGREGATION',
  PROJECT_AI_AGGREGATION: 'PROJECT_AI_AGGREGATION',
  // Node-self-processed — see chainingEngine.js's _runProjectTaskVerificationJob.
  // No Python worker ever claims this job type.
  PROJECT_TASK_VERIFICATION: 'PROJECT_TASK_VERIFICATION',

  // Video Generation Jobs
  VIDEO_GENERATION: 'VIDEO_GENERATION',

  // Homepage Audit Video Generation Jobs
  HOMEPAGE_VIDEO_GENERATION: 'HOMEPAGE_VIDEO_GENERATION',

  // Google Ads campaign metrics sync (Phase 6.3) — Node-self-processed, same
  // as PROJECT_TASK_VERIFICATION: no Python worker ever claims this type
  // (there is no Python client for the Google Ads API in this codebase).
  // Always created directly from a controller (googleAdsController's
  // refresh endpoint), never chained from/to another job type — has no
  // PIPELINE_CONFIG entry. As of Phase 6.4 this job also syncs search terms
  // and optimization score (folded in as extra stages — see
  // googleAdsSyncService.js) rather than getting their own job types, since
  // neither was given its own dedicated refresh endpoint.
  GOOGLE_ADS_SYNC: 'GOOGLE_ADS_SYNC',

  // Google Ads keyword performance sync (Phase 6.4) — same Node-self-processed
  // shape as GOOGLE_ADS_SYNC, its own job type (not folded into GOOGLE_ADS_SYNC)
  // because keyword lists can be large and the frontend needs to refresh
  // keywords independently of a full campaign resync.
  GOOGLE_ADS_KEYWORD_SYNC: 'GOOGLE_ADS_KEYWORD_SYNC',

  // Google Ads recommendation sync (Phase 6.4) — same shape, its own job
  // type because recommendations change based on actions a user takes
  // directly in the Google Ads UI and warrant an independent, fast refresh.
  GOOGLE_ADS_RECOMMENDATION_SYNC: 'GOOGLE_ADS_RECOMMENDATION_SYNC',
};

export const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Job Type Metadata with configuration
export const JOB_TYPE_CONFIG = {
  [JOB_TYPES.KEYWORD_RANKING]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes
    priority: 6,
    workerType: 'ranking'
  },
  [JOB_TYPES.REPORT_GENERATION]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes
    priority: 3,
    workerType: 'report'
  },
  [JOB_TYPES.SEO_AUDIT]: {
    maxAttempts: 2,
    timeout: 300000,       // 5 minutes
    priority: 8,             // High priority
    workerType: 'seo'        // Handled by the SEO worker
  },
  [JOB_TYPES.SEO_CRAWL]: {
    maxAttempts: 1,
    timeout: 1800000,      // 30 minutes (longer for comprehensive crawl)
    priority: 9,            // Highest priority
    workerType: 'seo_crawl' // Handled by the SEO crawl worker
  },
  [JOB_TYPES.SEO_PAGE_CRAWL]: {
    maxAttempts: 2,
    timeout: 300000,       // 5 minutes per page
    priority: 7,            // High priority but lower than comprehensive crawl
    workerType: 'seo'        // Handled by the SEO worker
  },
  // 🆕 NEW SCRAPING PIPELINE CONFIGURATION
  [JOB_TYPES.LINK_DISCOVERY]: {
    maxAttempts: 3,
    timeout: 1800000,      // 30 minutes
    priority: 1,            // 🔥 HIGHEST PRIORITY
    workerType: 'crawl'
  },
  [JOB_TYPES.DOMAIN_PERFORMANCE]: {
    maxAttempts: 2,
    timeout: 240000,       // 4 minutes
    priority: 2,            // 🔥 SECOND PRIORITY
    workerType: 'domain_performance'
  },
  [JOB_TYPES.TECHNICAL_DOMAIN]: {
    maxAttempts: 1,
    timeout: 60000,        // 1 minute
    priority: 1,
    workerType: 'technical_domain'
  },
  [JOB_TYPES.URL_QUALIFICATION]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes (probe ~75 URLs at 8 s each, 20 concurrent)
    priority: 1,
    workerType: 'url_qualifier'
  },
  [JOB_TYPES.PAGE_SCRAPING]: {
    maxAttempts: 2,
    timeout: 60000,        // 1 minute per page
    priority: 2,            // 🔥 SECOND PRIORITY
    workerType: 'page_scraper'
  },
  [JOB_TYPES.PAGE_ANALYSIS]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for analysis
    priority: 3,            // 🔥 THIRD PRIORITY (lower than PAGE_SCRAPING)
    workerType: 'page_analyzer'
  },
  [JOB_TYPES.SEO_SCORING]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for scoring
    priority: 4,            // 🔥 FOURTH PRIORITY (lower than PAGE_ANALYSIS)
    workerType: 'seo_scorer'
  },
  // Performance Analysis Jobs Configuration
  [JOB_TYPES.PERFORMANCE_MOBILE]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes for mobile analysis
    priority: 3,            // 🔥 THIRD PRIORITY
    workerType: 'performance'
  },
  [JOB_TYPES.PERFORMANCE_DESKTOP]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for desktop analysis
    priority: 4,            // 🔥 FOURTH PRIORITY
    workerType: 'performance'
  },
  // Headless Accessibility Analysis Configuration
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes for accessibility analysis
    priority: 4,            // 🔥 FOURTH PRIORITY (same as PERFORMANCE_DESKTOP)
    workerType: 'headless'
  },
  // Crawl Graph Analysis Configuration
  [JOB_TYPES.CRAWL_GRAPH]: {
    maxAttempts: 1,
    timeout: 60000,        // 1 minute for graph computation
    priority: 2,            // Same priority as PAGE_SCRAPING (runs right after)
    workerType: 'crawl_graph'
  },
  // AI Visibility Job Configuration (V2 pipeline — includes scoring and aggregation)
  [JOB_TYPES.AI_VISIBILITY]: {
    maxAttempts: 2,
    timeout: 600000,       // 10 minutes for AI analysis
    priority: 5,
    workerType: 'ai_visibility'
  },

  // F4-016: Verification Batch project-level aggregation chain configuration.
  // Runs once per batch (not once per URL) — priority/timeout tiers mirror
  // SEO_SCORING/AI_VISIBILITY (the per-page equivalents this replaces for
  // batched runs), since the work performed is the same website-level
  // recomputation, just triggered once instead of N times.
  [JOB_TYPES.PROJECT_SEO_AGGREGATION]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes — same class of work as SEO_SCORING's Phase 7
    priority: 4,
    workerType: 'project_seo_aggregator'
  },
  [JOB_TYPES.PROJECT_AI_AGGREGATION]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes — reads ai_scores/ai_issues for the whole project
    priority: 5,
    workerType: 'project_ai_aggregator'
  },
  [JOB_TYPES.PROJECT_TASK_VERIFICATION]: {
    // Node-self-processed (see chainingEngine.js) — maxAttempts/timeout drive
    // the same getRetryBackoffMs-based retry scheduling as every other job
    // type, just executed via setTimeout in-process instead of Python
    // re-polling a 'retrying' job.
    maxAttempts: 2,
    timeout: 60000,
    priority: 5,
    workerType: 'project_task_verifier'
  },

  // Video Generation Configuration
  [JOB_TYPES.VIDEO_GENERATION]: {
    maxAttempts: 3,
    timeout: 600000,       // 10 minutes for video generation
    priority: 6,            // Medium priority
    workerType: 'video_generator'
  },

  // Homepage Audit Video Generation Configuration
  [JOB_TYPES.HOMEPAGE_VIDEO_GENERATION]: {
    maxAttempts: 2,
    timeout: 600000,       // 10 minutes for video generation
    priority: 6,            // Medium priority — same lane as VIDEO_GENERATION
    workerType: 'video_generator'  // SAME worker — one worker, multiple processors
  },

  // Google Ads campaign metrics sync (Phase 6.3). Node-self-processed (see
  // googleAdsSyncService.js), and — unlike PROJECT_TASK_VERIFICATION, whose
  // 'retrying' outcomes ARE reclaimed by verificationBatchRecoveryService's
  // scheduled sweep — nothing ever reclaims a GOOGLE_ADS_SYNC/KEYWORD_SYNC/
  // RECOMMENDATION_SYNC job left in 'retrying'. That sweep is hard-scoped to
  // PROJECT_TASK_VERIFICATION/PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION
  // (see PROJECT_JOB_TYPES in verificationBatchRecoveryService.js) and was
  // never extended to these three. A job that fails once therefore sat in
  // 'retrying' PERMANENTLY - and GET /sync-status's "is a sync in flight"
  // check treats 'retrying' as in-flight, so the Keywords/Google Ads page
  // was stuck on its loading screen forever even after a brand new sync
  // completed successfully, because that one stale row never went away.
  // maxAttempts: 1 makes jobService.failJob's existing retry-vs-terminal
  // branch go straight to terminal 'failed' on the first failure for these
  // three job types - matching what actually happens today (there was never
  // a real second attempt), instead of promising a retry that never comes.
  [JOB_TYPES.GOOGLE_ADS_SYNC]: {
    maxAttempts: 1,
    // Phase 6.5: this one job now covers campaigns, daily metrics, search
    // terms, optimization score, device/geo/audience/ad performance,
    // conversion actions, and budget alert generation - bumped from 5 to
    // 10 minutes (same ceiling as AI_VISIBILITY) to match the added work,
    // rather than splitting into more job types nothing asked for.
    timeout: 600000,
    priority: 5,
    workerType: 'google_ads_sync'
  },

  // Google Ads keyword performance sync (Phase 6.4). Node-self-processed,
  // same "no reclaim exists for 'retrying'" reasoning as GOOGLE_ADS_SYNC above.
  [JOB_TYPES.GOOGLE_ADS_KEYWORD_SYNC]: {
    maxAttempts: 1,
    timeout: 300000,       // 5 minutes — keyword_view can return thousands of rows
    priority: 5,
    workerType: 'google_ads_keyword_sync'
  },

  // Google Ads recommendation sync (Phase 6.4). Lighter/faster than the
  // others — the recommendation resource is a small, bounded list per
  // account. Same "no reclaim exists for 'retrying'" reasoning as above.
  [JOB_TYPES.GOOGLE_ADS_RECOMMENDATION_SYNC]: {
    maxAttempts: 1,
    timeout: 120000,        // 2 minutes
    priority: 5,
    workerType: 'google_ads_recommendation_sync'
  }
};

// Retry backoff strategy (exponential)
export const getRetryBackoffMs = (attemptNumber) => {
  // Exponential backoff: 1, 2, 4 minutes
  return Math.pow(2, attemptNumber) * 30 * 1000; // 30s, 1m, 2m
};
