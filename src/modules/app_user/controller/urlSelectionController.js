import mongoose from 'mongoose';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import Job from '../../jobs/model/Job.js';
import UrlSelection from '../../jobs/model/UrlSelection.js';
import SeoProject from '../model/SeoProject.js';
import chainingEngine from '../../jobs/chainingEngine.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import { deductPages, refundPages } from '../../../utils/creditService.js';
import { canConsumeQuota } from '../../subscription/service/subscriptionLifecycle.js';

// Two independent ceilings can apply to a selection, and both are checked
// below:
//  - SeoProject.url_selection_limit — an optional, per-project, admin-set
//    override (null = unlimited, the default for every project). This caps
//    how many URLs THIS ONE project may ever select in a single run,
//    regardless of the submitting user's account-wide quota.
//  - User.subscription.pages — the account-level, cross-project lifetime
//    page quota (see deductPages() below). This caps how many pages the
//    USER has left to spend, across every project they own.
// These are not redundant: a project could have plenty of qualified URLs
// and no per-project override, yet still be blocked by the user's account
// running low on pages, or vice versa. PAGE_SCRAPING/HEADLESS_ACCESSIBILITY
// chunk creation already scales chunk count from the actual selected-URL
// count (see chainingEngine.js's
// PAGE_SCRAPING_CHUNK_SIZE/HEADLESS_ACCESSIBILITY_CHUNK_SIZE usage), so
// there is nothing downstream that assumes a bounded selection size beyond
// these two explicit checks.

/**
 * GET /projects/:id/url-pool
 * Returns this run's qualified/rejected URL pool for user review, once the
 * project is parked in 'awaiting_url_selection'.
 */
export const getUrlPool = async (req, res) => {
  try {
    const project = req.project;
    const projectId = project._id;

    if (project.crawl_status !== 'awaiting_url_selection') {
      return res.status(409).json(ResponseUtil.error(
        'No URL selection is pending for this project (either too early or already approved)', 409
      ));
    }

    if (!project.current_run_id) {
      return res.status(409).json(ResponseUtil.error('Project has no active audit run', 409));
    }

    const urlQualJob = await Job.findOne({
      project_id: projectId,
      run_id: project.current_run_id,
      jobType: JOB_TYPES.URL_QUALIFICATION,
      status: 'completed'
    }).lean();

    if (!urlQualJob) {
      // Distinguish "no such job" from "job exists but is still pending/
      // running/failed" so the 409 is diagnosable from the log alone.
      const latestJob = await Job.findOne({
        project_id: projectId,
        run_id: project.current_run_id,
        jobType: JOB_TYPES.URL_QUALIFICATION
      }).sort({ created_at: -1 }).select('_id status').lean();
      LoggerUtil.warn('URL pool requested but no completed URL_QUALIFICATION job for this run', {
        projectId: projectId.toString(),
        runId: project.current_run_id.toString(),
        latestJobId: latestJob?._id?.toString() ?? null,
        latestJobStatus: latestJob?.status ?? 'none'
      });
      return res.status(409).json(ResponseUtil.error('URL qualification has not completed for this run yet', 409, {
        job_status: latestJob?.status ?? 'none'
      }));
    }

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId.toString());

    const poolDocs = await db.collection('seo_audit_url_pool')
      .find({ project_id: projectIdObj, job_id: urlQualJob._id })
      .sort({ probed_at: 1 })
      .toArray();

    // The pool is written by the Python worker straight into Mongo, while the
    // job's result_data arrives over HTTP — two independent paths. If the job
    // says it discovered URLs but this read finds none, the pool is not
    // visible to this process (e.g. the Python worker and this backend are
    // pointed at different Mongo databases). That must not be rendered as a
    // successful "0 of 0": fail loudly and log which lookup came back empty.
    const reported = urlQualJob.result_data?.discoveredUrls ?? urlQualJob.result_data?.candidateUrls ?? 0;
    if (poolDocs.length === 0 && reported > 0) {
      const pool = db.collection('seo_audit_url_pool');
      const [byProject, byJobIdAsString] = await Promise.all([
        pool.countDocuments({ project_id: projectIdObj }),
        pool.countDocuments({ job_id: urlQualJob._id.toString() })
      ]);
      LoggerUtil.error('URL pool is empty although URL_QUALIFICATION reported discovered URLs', new Error('URL_POOL_UNAVAILABLE'), {
        projectId: projectId.toString(),
        runId: project.current_run_id.toString(),
        jobId: urlQualJob._id.toString(),
        connectedDb: mongoose.connection.name,
        reported: {
          discoveredUrls: urlQualJob.result_data?.discoveredUrls ?? null,
          qualifiedUrls: urlQualJob.result_data?.qualifiedUrls ?? null,
          canonicalCount: urlQualJob.result_data?.canonicalCount ?? null
        },
        poolCounts: { byProjectAndJobId: 0, byProjectOnly: byProject, byJobIdAsString },
        hint: byProject === 0
          ? 'No pool docs for this project in the connected database; check that the Python worker (MONGODB_URI) and this backend (MONGO_URI) use the same database name'
          : 'Pool docs exist for this project under a different job_id'
      });
      return res.status(503).json(ResponseUtil.error(
        'The qualified URL list for this run is not available. Please try again shortly or contact support if it persists.', 503,
        { code: 'URL_POOL_UNAVAILABLE', reported_discovered: reported }
      ));
    }

    // De-dupe by url, keeping the LATEST probed_at (the starvation-recovery
    // retry pass can insert a second record for the same URL with
    // probe_phase:'retry', which should supersede the initial probe).
    const byUrl = new Map();
    for (const doc of poolDocs) {
      byUrl.set(doc.url, doc);
    }
    const dedupedPool = Array.from(byUrl.values());

    // Join page_type from seo_internal_links.
    const urls = dedupedPool.map(d => d.url);
    const linkDocs = await db.collection('seo_internal_links')
      .find({ projectId: projectIdObj, url: { $in: urls } }, { projection: { url: 1, type: 1, _id: 0 } })
      .toArray();
    const typeByUrl = new Map(linkDocs.map(d => [d.url, (d.type || 'other').toLowerCase()]));

    let results = dedupedPool.map(d => ({
      url: d.url,
      page_type: typeByUrl.get(d.url) || 'other',
      qualified: !!d.qualified,
      status_code: d.status_code ?? null,
      reject_reason: d.reject_reason ?? null,
      // Structured, explainable rejection metadata (reason_code, explanation,
      // discovery source, probe detail) — additive field, present whenever
      // the Python worker wrote it; existing consumers reading only the
      // fields above are unaffected.
      qualification_details: d.qualification_details ?? null
    }));

    // Optional filters
    const { search, page_type, qualified_only } = req.query;
    if (search) {
      const re = new RegExp(search, 'i');
      results = results.filter(r => re.test(r.url));
    }
    if (page_type) {
      results = results.filter(r => r.page_type === String(page_type).toLowerCase());
    }
    if (qualified_only === 'true') {
      results = results.filter(r => r.qualified);
    }

    // Pagination is opt-in only: a caller that wants real paging passes
    // ?page=&limit= explicitly. Without those params, return the entire
    // result set — however many URLs LINK_DISCOVERY actually found — rather
    // than truncating to a hardcoded page size. The URL Selection screen
    // itself always wants the full set in one round trip (it paginates
    // client-side via its own virtualized table).
    const hasExplicitPaging = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = hasExplicitPaging
      ? Math.max(1, parseInt(req.query.limit, 10) || results.length)
      : results.length;
    const start = (page - 1) * limit;
    const paged = hasExplicitPaging ? results.slice(start, start + limit) : results;

    return res.json(ResponseUtil.success({
      total_discovered: dedupedPool.length,
      total_qualified: dedupedPool.filter(d => d.qualified).length,
      urls: paged,
      pagination: { page, limit, total: results.length },
      // What the URL_QUALIFICATION job itself reported. canonical_count is
      // CANONICAL_CAP-limited (the default crawl set used when no selection
      // gate runs) — it is NOT the size of the selectable pool above.
      qualification_summary: {
        job_id: urlQualJob._id.toString(),
        discovered: urlQualJob.result_data?.discoveredUrls ?? null,
        qualified: urlQualJob.result_data?.qualifiedUrls ?? null,
        low_priority: urlQualJob.result_data?.lowPriorityUrls ?? null,
        rejected: urlQualJob.result_data?.rejectedUrls ?? null,
        canonical_count: urlQualJob.result_data?.canonicalCount ?? null
      },
      // null = no cap; only set when an admin has explicitly configured a
      // per-project override.
      selection_limit: project.url_selection_limit ?? null
    }, 'URL pool retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error getting URL pool', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get URL pool', 500));
  }
};

const PAGE_FAILURES_DEFAULT_LIMIT = 100;
const PAGE_FAILURES_MAX_LIMIT = 1000;

/**
 * GET /projects/:id/page-failures
 * Read-only forensic report over seo_page_failures (written by the Python
 * PAGE_SCRAPING worker — see page_scraping.py's _record_failure). Purely
 * additive observability: does not affect pages_crawled, progress, or any
 * other existing calculation, all of which continue to derive from
 * seo_page_data / job result_data exactly as before.
 *
 * Defaults to the project's current_run_id; pass ?run_id= to inspect a
 * previous run.
 *
 * Query params (all optional):
 *   page, limit        — pagination over the `failures` list (default
 *                         page=1, limit=100, capped at 1000). Does not
 *                         affect `attempted`/`successful`/`failure_breakdown`,
 *                         which always reflect the FULL set for this run.
 *   failure_type        — exact match, e.g. ?failure_type=TIMEOUT
 *   search               — case-insensitive substring match on url
 *   resolved             — 'true' | 'false' — filter by resolution state
 *                         (see page_scraping.py's resolved/resolved_at/
 *                         resolved_by_attempt fields); omit for both
 */
export const getPageFailures = async (req, res) => {
  try {
    const project = req.project;
    const projectId = project._id;

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId.toString());

    const runIdParam = req.query.run_id || project.current_run_id;
    if (!runIdParam) {
      return res.status(409).json(ResponseUtil.error('Project has no run to report on', 409));
    }
    const runIdObj = new ObjectId(runIdParam.toString());

    const baseQuery = { project_id: projectIdObj, run_id: runIdObj };

    const filterQuery = { ...baseQuery };
    if (req.query.failure_type) {
      filterQuery.failure_type = String(req.query.failure_type).toUpperCase();
    }
    if (req.query.search) {
      filterQuery.url = { $regex: String(req.query.search), $options: 'i' };
    }
    if (req.query.resolved === 'true') {
      filterQuery.resolved = true;
    } else if (req.query.resolved === 'false') {
      // $ne: true (not a strict === false) so failure records written before
      // this field existed — which have no `resolved` key at all — still
      // count as unresolved instead of being silently excluded.
      filterQuery.resolved = { $ne: true };
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      PAGE_FAILURES_MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || PAGE_FAILURES_DEFAULT_LIMIT)
    );
    const skip = (page - 1) * limit;

    const failuresCollection = db.collection('seo_page_failures');

    // Breakdown and total counts always reflect the FULL matching set for
    // this run (ignoring pagination) — computed via an index-backed
    // aggregation rather than fetching every document into Node, so this
    // stays cheap at 10,000+ failures. Uses baseQuery (project_id+run_id
    // only, matching the project_run_failure_type_lookup index prefix) so
    // the breakdown always reflects the whole run regardless of any
    // search/failure_type/resolved filter applied to the paginated list.
    const [breakdownAgg, totalMatching, page_docs] = await Promise.all([
      failuresCollection.aggregate([
        { $match: baseQuery },
        { $group: { _id: '$failure_type', count: { $sum: 1 } } }
      ]).toArray(),
      failuresCollection.countDocuments(filterQuery),
      failuresCollection.find(filterQuery)
        .sort({ failed_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    const breakdown = {};
    for (const b of breakdownAgg) {
      breakdown[b._id || 'UNKNOWN'] = b.count;
    }
    const totalFailed = breakdownAgg.reduce((sum, b) => sum + b.count, 0);

    // attempted/success come from the same source of truth pages_crawled
    // already uses (PAGE_SCRAPING chunk jobs' result_data) — this endpoint
    // never recomputes or overrides that value, only reports alongside it.
    const chunkJobs = await db.collection('jobs')
      .find({ project_id: projectIdObj, run_id: runIdObj, jobType: 'PAGE_SCRAPING' })
      .toArray();
    const attempted = chunkJobs.reduce((sum, j) => sum + (j.result_data?.attemptedUrls ?? 0), 0);
    const successful = chunkJobs.reduce((sum, j) => sum + (j.result_data?.successfulPages ?? 0), 0);

    return res.json(ResponseUtil.success({
      run_id: runIdParam,
      attempted,
      successful,
      failed: totalFailed,
      failure_breakdown: breakdown,
      pagination: { page, limit, total: totalMatching },
      failures: page_docs.map(f => ({
        url: f.url,
        canonical_url: f.canonical_url,
        failure_type: f.failure_type,
        error_message: f.error_message,
        http_status_code: f.http_status_code,
        attempt: f.attempt,
        duration_ms: f.duration_ms,
        failed_at: f.failed_at,
        resolved: f.resolved ?? false,
        resolved_at: f.resolved_at ?? null,
        resolved_by_attempt: f.resolved_by_attempt ?? null,
      })),
    }, 'Page failure report retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error getting page failures', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get page failures', 500));
  }
};

/**
 * POST /projects/:id/url-selection
 * Body: { selectedUrls: string[] }
 * Approves a subset of the qualified URL pool and resumes the pipeline by
 * creating the PAGE_SCRAPING/HEADLESS_ACCESSIBILITY JobGroups directly —
 * reusing chainingEngine's existing chunk-creation methods unmodified.
 */
export const submitUrlSelection = async (req, res) => {
  try {
    const project = req.project;
    const projectId = project._id;
    const { selectedUrls } = req.body;

    if (project.crawl_status !== 'awaiting_url_selection') {
      return res.status(409).json(ResponseUtil.error(
        'No URL selection is pending for this project (either too early or already approved)', 409
      ));
    }

    // Subscription lifecycle gate (Phase 15) — same policy as project
    // creation: approving URLs consumes page quota, so a
    // paused/canceled/past_due subscription cannot do it regardless of
    // remaining page balance.
    if (!canConsumeQuota(req.user.subscription.status)) {
      return res.status(403).json(ResponseUtil.error(
        `Your subscription is ${req.user.subscription.status}. Resolve this via Billing Portal to approve URLs.`, 403,
        { code: 'SUBSCRIPTION_NOT_ACTIVE' }
      ));
    }

    if (!Array.isArray(selectedUrls) || selectedUrls.length === 0) {
      return res.status(400).json(ResponseUtil.error('selectedUrls must be a non-empty array', 400));
    }

    // Only rejected if this specific project has an explicit admin-configured
    // override — there is no platform-wide ceiling.
    const effectiveLimit = project.url_selection_limit ?? null;
    if (effectiveLimit != null && selectedUrls.length > effectiveLimit) {
      return res.status(400).json(ResponseUtil.error(
        `Selected URLs exceed the maximum allowed (${effectiveLimit})`, 400
      ));
    }

    const runId = project.current_run_id;
    if (!runId) {
      return res.status(409).json(ResponseUtil.error('Project has no active audit run', 409));
    }

    const urlQualJob = await Job.findOne({
      project_id: projectId,
      run_id: runId,
      jobType: JOB_TYPES.URL_QUALIFICATION,
      status: 'completed'
    });

    if (!urlQualJob) {
      return res.status(409).json(ResponseUtil.error('URL qualification has not completed for this run yet', 409));
    }

    // Validate every selected URL exists in this run's qualified pool.
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId.toString());

    const qualifiedDocs = await db.collection('seo_audit_url_pool')
      .find({ project_id: projectIdObj, job_id: urlQualJob._id, qualified: true }, { projection: { url: 1, _id: 0 } })
      .toArray();
    const qualifiedSet = new Set(qualifiedDocs.map(d => d.url));

    const invalidUrls = selectedUrls.filter(u => !qualifiedSet.has(u));
    if (invalidUrls.length > 0) {
      return res.status(400).json(ResponseUtil.error(
        'One or more selected URLs are not in the qualified pool for this run', 400,
        { invalid_urls: invalidUrls.slice(0, 20) }
      ));
    }

    // Atomic, authoritative page-quota deduction — exactly the number of
    // approved URLs. Placed here — after every validation has passed and
    // selectedUrls.length is final, before the selection is persisted — so
    // an insufficient-quota rejection creates neither a UrlSelection record
    // nor any downstream job. Per the business rule, pages are consumed by
    // the act of selection, not by successful crawling, so once this
    // succeeds and UrlSelection.create() below durably persists, the charge
    // is final — see the comment above the chunk-group calls for why their
    // failure does NOT trigger a refund.
    try {
      await deductPages(req.user._id, selectedUrls.length);
    } catch (pagesError) {
      if (pagesError.code === 'INSUFFICIENT_PAGES') {
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_PAGES',
          message: `Not enough pages remaining to approve ${selectedUrls.length} URLs`
        });
      }
      throw pagesError;
    }

    // Idempotent creation — a duplicate/double-submitted approval for this
    // run fails atomically at the DB level (unique project_id+run_id index),
    // mirroring JobGroup's own idempotency pattern. If persisting the
    // selection fails for ANY reason — including this idempotent-duplicate
    // case — the deduction just above must be undone: the durable page
    // charge belongs solely to whichever single request's UrlSelection
    // document actually survives. This is what makes two truly concurrent
    // submissions (both passing validation, both deducting, only one
    // winning the unique index) net out to exactly one charge.
    let selectionDoc;
    try {
      selectionDoc = await UrlSelection.create({
        project_id: projectId,
        run_id: runId,
        source_job_id: urlQualJob._id,
        selected_urls: selectedUrls,
        total_available: qualifiedSet.size,
        total_selected: selectedUrls.length,
        approved_by: req.user._id
      });
    } catch (createError) {
      await refundPages(req.user._id, selectedUrls.length);

      if (createError.code === 11000) {
        LoggerUtil.info('URL selection already recorded for this run (idempotent no-op)', { projectId, runId });
        const existing = await UrlSelection.findOne({ project_id: projectId, run_id: runId }).lean();
        return res.status(202).json(ResponseUtil.success(existing, 'URL selection already approved for this run'));
      }
      throw createError;
    }

    // Status-guarded transition: only the request that wins this atomic
    // update proceeds to create JobGroups — a race between two approval
    // requests (which the unique index above already mostly prevents) can't
    // double-trigger chunk creation. Reverts to 'discovered' — the value
    // crawl_status already held between LINK_DISCOVERY and this gate — so
    // the rest of the pipeline (projectStatusService setting 'crawled' once
    // PAGE_SCRAPING resolves, etc.) behaves exactly as it would have without
    // the selection step ever existing.
    const transitioned = await SeoProject.findOneAndUpdate(
      { _id: projectId, crawl_status: 'awaiting_url_selection' },
      { $set: { crawl_status: 'discovered' } },
      { new: true }
    );

    if (transitioned) {
      const requestId = `url_selection_${Date.now()}`;
      const sourceJob = urlQualJob;
      sourceJob._canonicalUrls = selectedUrls;

      // Deliberately NOT refunding pages if either chunk-group creation call
      // below fails. The page charge above is tied to the act of selection
      // (UrlSelection.create() already succeeded, durably, at this point) —
      // not to whether the downstream scrape/crawl job creation succeeds.
      // This also matches the pre-existing behavior of these two calls:
      // failures are logged and swallowed, not thrown — the request still
      // returns 202 success to the caller (the selection WAS approved), so
      // silently refunding pages behind that success response would leave
      // the user's quota inconsistent with what they were told happened.
      try {
        await chainingEngine._createPageScrapingChunkGroup(sourceJob, requestId);
      } catch (chunkError) {
        LoggerUtil.error('PAGE_SCRAPING chunk group creation failed after URL selection approval', chunkError, { projectId });
      }
      try {
        await chainingEngine._createHeadlessAccessibilityChunkGroup(sourceJob, requestId);
      } catch (chunkError) {
        LoggerUtil.error('HEADLESS_ACCESSIBILITY chunk group creation failed after URL selection approval', chunkError, { projectId });
      }
    }

    return res.status(202).json(ResponseUtil.success(selectionDoc, 'URL selection approved — audit resuming'));

  } catch (error) {
    LoggerUtil.error('Error submitting URL selection', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to submit URL selection', 500));
  }
};
