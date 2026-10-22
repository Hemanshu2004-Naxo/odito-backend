/**
 * Pipeline Configuration
 * Declarative graph of the SEO audit pipeline.
 *
 * Each key is a completed job type. Its value describes:
 *   next            – job type(s) to create on completion
 *   parallel        – create next jobs in parallel (Promise.allSettled)
 *   atomicGuard     – use duplicate-check guard before creation (default: true)
 *   stageFrom       – override the "from" field in stageChanged events
 *   afterDispatch   – additional jobs to create after a specific next job is dispatched
 *   fallback        – if creation of a next job fails, create these instead (with atomic guard)
 *   creationFallback – same as fallback but for non-atomic creation paths
 *   hooks.beforeChain – run a named hook before any chaining ('emitCompleted')
 *
 * IMPORTANT: Changing this config changes pipeline behavior.
 */

import { JOB_TYPES } from './constants/jobTypes.js';

export const PIPELINE_CONFIG = {

  // ──────────────────────────────────────────────────────────────────────────
  // LINK_DISCOVERY → URL_QUALIFICATION
  // URL_QUALIFICATION probes all discovered URLs and emits canonicalUrls.
  //
  // TECHNICAL_DOMAIN is no longer part of this chain. It only ever needed
  // projectId/userId/domain (available at audit start), not LINK_DISCOVERY's
  // output, so it is now created as an independent seed job alongside
  // LINK_DISCOVERY/DOMAIN_PERFORMANCE — see
  // projectAuditService.startProjectAudit(). It no longer gates or forwards
  // into this chain and has no PIPELINE_CONFIG entry of its own (same as
  // DOMAIN_PERFORMANCE).
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.LINK_DISCOVERY]: {
    next: [JOB_TYPES.URL_QUALIFICATION],
    parallel: false,
    atomicGuard: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // URL_QUALIFICATION → PARALLEL(PAGE_SCRAPING, HEADLESS_ACCESSIBILITY,
  //                              AI_VISIBILITY)
  //
  // forwardCanonicalUrls: chainingEngine extracts result_data.canonicalUrls
  // from this job and injects it into each downstream job's input_data,
  // guaranteeing all three workers process the identical URL set.
  //
  // NOTE: CRAWL_GRAPH is intentionally NOT in this fan-out. It reads from
  // seo_page_data (written by PAGE_SCRAPING) and must run after scraping
  // completes. See PAGE_SCRAPING → CRAWL_GRAPH below.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.URL_QUALIFICATION]: {
    next: [
      JOB_TYPES.PAGE_SCRAPING,
      JOB_TYPES.HEADLESS_ACCESSIBILITY
    ],
    parallel: true,
    atomicGuard: true,
    forwardCanonicalUrls: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE_SCRAPING → parallel(CRAWL_GRAPH, AI_VISIBILITY)
  // CRAWL_GRAPH must remain downstream of PAGE_SCRAPING because it reads
  // from seo_page_data (populated by page scraping). Running it in parallel
  // with PAGE_SCRAPING would yield an empty crawl graph.
  //
  // AI_VISIBILITY also reads directly from raw_html in seo_page_data, so it
  // must run after PAGE_SCRAPING completes.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_SCRAPING]: {
    next: [
      JOB_TYPES.CRAWL_GRAPH,
      JOB_TYPES.AI_VISIBILITY
    ],
    parallel: true,
    atomicGuard: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // CRAWL_GRAPH → [PERFORMANCE_MOBILE, PERFORMANCE_DESKTOP]  (sequential)
  //   PAGE_ANALYSIS is gated behind PERFORMANCE_DESKTOP + HEADLESS_ACCESSIBILITY completion.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.CRAWL_GRAPH]: {
    next: [JOB_TYPES.PERFORMANCE_MOBILE, JOB_TYPES.PERFORMANCE_DESKTOP],
    parallel: false,
    atomicGuard: false
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PERFORMANCE_MOBILE → (no-op)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PERFORMANCE_MOBILE]: {
    next: []
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PERFORMANCE_DESKTOP → (no-op, PAGE_ANALYSIS gated via dependency gate)
  //   stageFrom override: events show from=PAGE_SCRAPING (existing behavior)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PERFORMANCE_DESKTOP]: {
    next: [],
    stageFrom: JOB_TYPES.PAGE_SCRAPING
  },

  // ──────────────────────────────────────────────────────────────────────────
  // HEADLESS_ACCESSIBILITY → (no-op, PAGE_ANALYSIS gated via dependency gate)
  //   stageFrom override: events show from=PAGE_SCRAPING
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: {
    next: [],
    stageFrom: JOB_TYPES.PAGE_SCRAPING
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE_ANALYSIS → SEO_SCORING
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_ANALYSIS]: {
    next: [JOB_TYPES.SEO_SCORING],
    parallel: false,
    atomicGuard: true
  },

  
  // ──────────────────────────────────────────────────────────────────────────
  // AI_VISIBILITY → (terminal) — V2 pipeline is self-contained.
  //   Emits audit:completed so the frontend refreshes AI data.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.AI_VISIBILITY]: {
    next: [],
    hooks: {
      onComplete: 'emitCompleted'
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SEO_SCORING → (terminal) — emits audit:completed after scores are written
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.SEO_SCORING]: {
    next: [],
    hooks: {
      onComplete: 'emitCompleted'
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // F4-016: Verification Batch project-level aggregation chain.
  //
  // PROJECT_SEO_AGGREGATION → PROJECT_AI_AGGREGATION → PROJECT_TASK_VERIFICATION
  //
  // Created exactly once per batch by chainingEngine's barrier
  // (_checkVerificationBatchBarrier / _enqueueProjectAggregationChain), never
  // once per URL. Deliberately serial (parallel: false) — each stage reads
  // the aggregate output of the one before it (well, PROJECT_AI_AGGREGATION
  // doesn't strictly depend on PROJECT_SEO_AGGREGATION's output, but running
  // them serially avoids two independent project-wide recomputations racing
  // each other, matching F4-011's own original recommendation for this
  // chain). PROJECT_TASK_VERIFICATION's onComplete hook ('batchCompleted')
  // is handled by its own dedicated branch in process() — separate from
  // 'emitCompleted' above, since this is a batch-scoped completion, not a
  // Full Audit / single-URL verification one.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PROJECT_SEO_AGGREGATION]: {
    next: [JOB_TYPES.PROJECT_AI_AGGREGATION],
    parallel: false,
    atomicGuard: true
  },

  [JOB_TYPES.PROJECT_AI_AGGREGATION]: {
    next: [JOB_TYPES.PROJECT_TASK_VERIFICATION],
    parallel: false,
    atomicGuard: true
  },

  [JOB_TYPES.PROJECT_TASK_VERIFICATION]: {
    next: [],
    hooks: {
      onComplete: 'batchCompleted'
    }
  }
};
