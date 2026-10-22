import mongoose from 'mongoose';
import AuditRun from '../model/AuditRun.js';
import IssueAggregationService from '../../../services/issueAggregationService.js';
import { resolveSnapshotIssueTotal } from '../../jobs/utils/crawlMetrics.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import { PIPELINE_CONFIG } from '../../jobs/pipelineConfig.js';
import { ProjectPerformanceService } from '../../app_user/service/projectPerformance.service.js';
import { TechnicalChecksService } from '../../app_user/service/technicalChecks.service.js';

// The set of job types whose completion can legitimately signal "the whole
// audit may be done" is read directly from PIPELINE_CONFIG (every entry with
// hooks.onComplete === 'emitCompleted') instead of being hardcoded here, so
// adding a new terminal branch to the pipeline automatically extends this
// check without a second edit. Today this evaluates to
// [SEO_SCORING, AI_VISIBILITY].
const REQUIRED_TERMINAL_TYPES = Object.entries(PIPELINE_CONFIG)
  .filter(([, config]) => config?.hooks?.onComplete === 'emitCompleted')
  .map(([jobType]) => jobType);

// Most terminal types must reach 'completed' to count as resolved. AI_VISIBILITY
// is the one documented exception (pre-existing behavior, preserved as-is): it
// is best-effort AI analysis layered on top of the core SEO audit, so a
// failure there must not block the rest of the report from being considered
// done — 'failed' counts as resolved for this type only.
const GRACEFUL_FAILURE_TYPES = new Set([JOB_TYPES.AI_VISIBILITY]);

/**
 * AuditHistoryService
 *
 * Captures an immutable snapshot of each completed audit into the audit_runs
 * collection. Called from the chainingEngine after each terminal job
 * (SEO_SCORING or AI_VISIBILITY) fires its onComplete hook.
 *
 * The service is idempotent — it can be called from either terminal job without
 * creating duplicate records. A snapshot is written only when BOTH terminals
 * are resolved (completed or failed) for the same project.
 *
 * Failures are non-fatal: the caller wraps this in try/catch and the audit
 * pipeline continues regardless of whether the snapshot was saved.
 */
class AuditHistoryService {

  /**
   * Main entry point. Called after SEO_SCORING or AI_VISIBILITY completes.
   * Creates one audit run record when both terminals are resolved.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {string|mongoose.Types.ObjectId} [runId] - Current audit run_id (from the
   *   completed job). Scopes the terminal-resolution check to this run only, so a
   *   stale SEO_SCORING/AI_VISIBILITY job from a superseded run can't be mistaken
   *   for "both terminals resolved" and trigger a premature/incorrect snapshot.
   * @param {string} requestId  - Trace ID from the calling chainingEngine request
   * @returns {Object|null}     - The saved AuditRun document, or null if skipped
   */
  async captureIfComplete(projectId, runId, requestId = 'AH') {
    const pidStr = projectId.toString();

    console.log(`[AUDIT_HISTORY:${requestId}] Creating audit snapshot | projectId=${pidStr}`);

    // 1. Every required terminal job must be resolved before we write anything
    const allResolved = await this.allTerminalsResolved(pidStr, runId, requestId);
    if (!allResolved) {
      console.log(`[AUDIT_HISTORY:${requestId}] Terminals not yet fully resolved — deferring snapshot | projectId=${pidStr}`);
      return null;
    }

    // 2. Load the project to extract current audit metrics
    const project = await SeoProject.findById(pidStr).lean();
    if (!project) {
      console.error(`[AUDIT_HISTORY:${requestId}] Project not found — cannot create snapshot | projectId=${pidStr}`);
      return null;
    }

    // 3. Idempotency guard: one snapshot per audit session.
    //    audit_started_at is reset at the beginning of every crawl in
    //    scrapingController.resetProjectCrawlData(), making it the natural
    //    session key without requiring a separate audit-session ID.
    const auditStartedAt = project.audit_started_at;
    if (!auditStartedAt) {
      console.warn(`[AUDIT_HISTORY:${requestId}] audit_started_at missing on project — skipping snapshot | projectId=${pidStr}`);
      return null;
    }

    const existing = await AuditRun.findOne({ projectId: pidStr, startedAt: auditStartedAt }).lean();
    if (existing) {
      console.log(`[AUDIT_HISTORY:${requestId}] Snapshot already captured for this session | auditNumber=${existing.auditNumber} | projectId=${pidStr}`);
      return existing;
    }

    // 4. Generate next sequential audit number for this project
    const auditNumber = await this._nextAuditNumber(pidStr);

    // 5. Build the snapshot payload from live project state + score aggregation
    const snapshot = await this._buildSnapshot(project, pidStr, auditNumber);

    // 6. Persist — the unique index on (projectId, startedAt) acts as a final
    //    race guard if two concurrent calls reach this point simultaneously
    const auditRun = await AuditRun.create(snapshot);

    console.log(`[AUDIT_HISTORY:${requestId}] Audit snapshot saved | projectId=${pidStr} | auditNumber=${auditNumber} | websiteScore=${snapshot.websiteScore} | performanceScore=${snapshot.performanceScore} | technicalHealthScore=${snapshot.technicalHealthScore} | overall_ai_score=${snapshot.overall_ai_score} | aiso=${snapshot.aiso_score} | aeo=${snapshot.aeo_score} | geo=${snapshot.geo_score} | ai_issue_count=${snapshot.ai_issue_count} | aiVisibilityIssueCount=${snapshot.aiVisibilityIssueCount} | totalIssues=${snapshot.totalIssues}`);
    console.log(`[AUDIT_HISTORY:${requestId}] Audit #${auditNumber} stored successfully | projectId=${pidStr}`);

    return auditRun;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Single source of truth for "is the entire audit pipeline resolved".
   * Required terminal types are read from PIPELINE_CONFIG (see
   * REQUIRED_TERMINAL_TYPES above), not hardcoded — every type must reach
   * 'completed', except types listed in GRACEFUL_FAILURE_TYPES, which also
   * accept 'failed'. Scoped to a single run_id so a stale terminal job from a
   * superseded run can never be mistaken for the current run being resolved.
   *
   * Called both by captureIfComplete (audit-history snapshot) and by
   * chainingEngine (crawl_status finalization + the single audit:completed
   * websocket emission) — one check, two consumers, no duplicated logic.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {string|mongoose.Types.ObjectId} [runId]
   * @param {string} requestId
   * @returns {boolean}
   */
  async allTerminalsResolved(projectId, runId, requestId = 'AH') {
    const pidStr = projectId.toString();

    const results = await Promise.all(
      REQUIRED_TERMINAL_TYPES.map((jobType) => {
        const acceptedStatuses = GRACEFUL_FAILURE_TYPES.has(jobType)
          ? ['completed', 'failed']
          : ['completed'];
        return Job.findOne({
          project_id: pidStr,
          ...(runId ? { run_id: runId } : {}),
          jobType,
          status: { $in: acceptedStatuses }
        }).select('_id').lean();
      })
    );

    for (let i = 0; i < REQUIRED_TERMINAL_TYPES.length; i++) {
      if (!results[i]) {
        console.log(`[AUDIT_HISTORY:${requestId}] ${REQUIRED_TERMINAL_TYPES[i]} not yet resolved | projectId=${pidStr}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Returns the next audit number for a project.
   * Reads the current max and adds 1. The unique index on
   * (projectId, auditNumber) provides the final collision guard.
   *
   * @param {string} projectId
   * @returns {number}
   */
  async _nextAuditNumber(projectId) {
    const lastRun = await AuditRun
      .findOne({ projectId })
      .sort({ auditNumber: -1 })
      .select('auditNumber')
      .lean();

    return (lastRun?.auditNumber ?? 0) + 1;
  }

  /**
   * Builds the complete snapshot payload from the current project document
   * and a live aggregation of seo_page_scores.
   *
   * Severity mapping (from seo_scoring.py normalize_severity):
   *   high   → criticalIssues
   *   medium → warningIssues
   *   low    → infoIssues
   *
   * @param {Object} project     - Lean seoprojects document
   * @param {string} projectId
   * @param {number} auditNumber
   * @returns {Object}           - AuditRun schema-compatible object
   */
  async _buildSnapshot(project, projectId, auditNumber) {
    const db = mongoose.connection.db;
    const projectIdObj = new mongoose.Types.ObjectId(projectId);

    const severityAgg = await db.collection('seo_page_scores').aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $group: {
          _id: null,
          criticalIssues: { $sum: '$high_issues_count' },
          warningIssues:  { $sum: '$medium_issues_count' },
          infoIssues:     { $sum: '$low_issues_count' }
        }
      }
    ]).toArray().catch(err => {
      console.warn(`[AUDIT_HISTORY] Severity aggregation failed | projectId=${projectId} | reason="${err.message}"`);
      return [];
    });

    let criticalIssues = 0;
    let warningIssues  = 0;
    let infoIssues     = 0;
    if (severityAgg.length > 0) {
      criticalIssues = severityAgg[0].criticalIssues ?? 0;
      warningIssues  = severityAgg[0].warningIssues  ?? 0;
      infoIssues     = severityAgg[0].infoIssues     ?? 0;
    }

    // ── AI V2 Scores (from ai_projects) ─────────────────────────────────────
    let overall_ai_score = null;
    let aiso_score       = null;
    let aeo_score        = null;
    let geo_score        = null;
    try {
      const aiProjectDoc = await db.collection('ai_projects')
        .find({ project_id: projectIdObj })
        .sort({ computed_at: -1 })
        .limit(1)
        .next();
      if (aiProjectDoc) {
        overall_ai_score = aiProjectDoc.overall_score   ?? null;
        aiso_score       = aiProjectDoc.hubs?.aiso?.score ?? null;
        aeo_score        = aiProjectDoc.hubs?.aeo?.score  ?? null;
        geo_score        = aiProjectDoc.hubs?.geo?.score  ?? null;
      }
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] AI V2 score capture failed | projectId=${projectId} | reason="${err.message}"`);
    }

    const aiVisibilityScore = overall_ai_score;
    const aiScoringVersion  = 'v2';

    const websiteScore = project.website_score ?? null;

    // ── Performance Score ──────────────────────────────────────────────────
    // seo_domain_performance is overwritten on every recrawl — must snapshot now.
    let performanceScore = null;
    try {
      const perfResult = await ProjectPerformanceService.getProjectPerformance(project);
      // Service sets data.message only when no performance data exists
      performanceScore = perfResult?.data?.message ? null : (perfResult?.data?.summary?.performanceScore ?? null);
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] Performance score capture failed | projectId=${projectId} | reason="${err.message}"`);
    }

    // ── Technical Health Score ─────────────────────────────────────────────
    // domain_technical_reports is overwritten on every recrawl — must snapshot now.
    let technicalHealthScore = null;
    try {
      const techResult = await TechnicalChecksService.getTechnicalChecks(project);
      technicalHealthScore = techResult?.data?.summary?.healthScore ?? null;
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] Technical health score capture failed | projectId=${projectId} | reason="${err.message}"`);
    }

    // ── AI V2 Issue Counts (from ai_issues, keyed by ObjectId) ───────────────
    let aiVisibilityIssueCount = null;
    let aiVisibilityCriticalIssueCount = null;
    let ai_issue_count = null;
    try {
      [aiVisibilityIssueCount, aiVisibilityCriticalIssueCount] = await Promise.all([
        db.collection('ai_issues').countDocuments({ project_id: projectIdObj }),
        db.collection('ai_issues').countDocuments({ project_id: projectIdObj, severity: 'critical' })
      ]);
      ai_issue_count = aiVisibilityIssueCount;
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] AI V2 issue counts failed | projectId=${projectId} | reason="${err.message}"`);
    }

    // Canonical (dashboard/report) open-issue count; project.total_issues is the crawl-stage
    // distinct (issue_code, page_url) count and is lower when a page has per-element findings.
    let canonicalTotal = null;
    try {
      canonicalTotal = (await IssueAggregationService.getIssueSummary(projectId, { excludeCategories: [] })).totalIssues;
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] Canonical issue total failed | projectId=${projectId} | reason="${err.message}"`);
    }
    const issueTotal = resolveSnapshotIssueTotal({
      canonicalTotal,
      crawlStageTotal: project.total_issues,
      severitySum: criticalIssues + warningIssues + infoIssues,
    });
    if (issueTotal.source !== 'canonical_open_dedup_key' || issueTotal.total !== project.total_issues) {
      console.log(`[AUDIT_HISTORY] Issue total | projectId=${projectId} | snapshot=${issueTotal.total} (${issueTotal.source}) | project.total_issues=${project.total_issues}`);
    }

    return {
      projectId:    projectIdObj,
      auditNumber,

      startedAt:    project.audit_started_at,
      completedAt:  new Date(), // time both terminals resolved
      source:       project.current_run_source ?? null,

      websiteScore,
      websiteGrade: project.website_grade  ?? null,
      seoScore:     websiteScore,           // alias

      aiVisibilityScore,

      overall_ai_score,
      aiso_score,
      aeo_score,
      geo_score,
      ai_issue_count,

      performanceScore,
      technicalHealthScore,

      aiVisibilityIssueCount,
      aiVisibilityCriticalIssueCount,

      totalIssues:    issueTotal.total,
      criticalIssues,
      warningIssues,
      infoIssues,

      pagesDiscovered: project.pages_discovered ?? 0,
      pagesCrawled:    project.pages_crawled    ?? 0,
      pagesAnalyzed:   project.pages_analyzed   ?? 0,

      crawlDuration:   project.crawl_duration   ?? 0,
      auditDurationMs: project.audit_duration_ms ?? 0,

      scoringVersion:   project.scoring_version   ?? null, // written by seo_scoring.py
      aiScoringVersion,
    };
  }

}

export default new AuditHistoryService();
