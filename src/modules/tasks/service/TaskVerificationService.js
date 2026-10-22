import mongoose from 'mongoose';
import Task from '../model/Task.js';
import { isAiVisibilityIssueKey } from './aiVisibilityIssueIdentity.js';
import { normalizeTextValue, canonicalValuesMatch, parseRobotsDirectives, robotsValuesMatch } from './valueNormalization.js';
import { extractAggregateRatings, flattenSchemaNodes, ratingsEqual } from './aggregateRatingSchema.js';
import { sameAsComparisonKey } from './socialProfileUrls.js';
import { extractFaqPairsFromStructuredData, faqPairsMatch, faqPairsAreSubset, findFaqPageSchemas, sanitizeFaqPairs } from './faqSchema.js';
import { appliesToVerification as schemaInspectionApplies, verifySchemaFix } from '../../schema-evidence/schemaVerification.js';
import { getUserBreadcrumbEvidence } from '../../schema-evidence/breadcrumbEvidenceStore.js';
import { loadIntendedOrganization } from '../../schema-evidence/organizationIntentStore.js';
import { matchRenderedImages } from '../../external_integration/mediaFix/imageIdentity.js';
import { collectSiteEntity } from '../../schema-evidence/siteEntity.js';

// Issue types for which the crawler can WITHDRAW a finding as not applicable (status 'excluded') — see
// python_workers/.../rules/issue_reclassification.py. A withdrawn finding is not a fix.
const RECLASSIFIABLE_ISSUE_CODES = ['images_missing_alt_text'];

/**
 * TaskVerificationService
 *
 * Runs exactly once per verification batch (chainingEngine gates the call
 * behind allTerminalsResolved — see P3-002/Part 3) — a full project recrawl
 * and a single-page URL Verification run both end in the same completion
 * hook, so both trigger task re-verification identically. Compares
 * implemented/reopened tasks against the latest OPEN issues (seo_page_issues
 * is now a reconciled current-issue snapshot, P3-002) to determine whether
 * the issue is actually fixed on the website.
 *
 * Presence/absence (is the issue_code still open?) remains the authoritative
 * signal for reopened/verified — it already reflects the Python-side
 * lifecycle reconciliation. Layered on top, for the 5 issue types that get a
 * real captured expected-fix-value (title, meta description, h1, image alt,
 * canonical — see TaskHistoryService/issueSnapshotTypes), verification also
 * re-resolves the actual current value from seo_page_data and records
 * whether it matched — a `method: 'value_diff'` result the UI can show with
 * real confidence, vs. `'presence_fallback'` everywhere else. See
 * issueSnapshotTypes.js for the full, current list of snapshot types.
 *
 * Lifecycle:
 *   IMPLEMENTED    → recheck → issue gone?  → VERIFIED_FIXED
 *                            → issue exists? → REOPENED
 *   REOPENED       → recheck → issue gone?  → VERIFIED_FIXED
 *                            → issue exists? → REOPENED (unchanged)
 *   VERIFIED_FIXED → recheck → issue gone?  → VERIFIED_FIXED (unchanged)
 *                            → issue exists? → REOPENED (Phase 3 — previously
 *                              terminal; a regression on an already-verified
 *                              issue is now detected instead of silently
 *                              never being re-examined again)
 */
class TaskVerificationService {

  /**
   * Main entry point — verify all implemented/reopened tasks for a project.
   * Called by ChainingEngine after final scoring completes.
   *
   * @param {string|ObjectId} projectId    - The project that was recrawled/re-verified
   * @param {string}          requestId    - Trace ID for logging
   * @param {string|ObjectId|null} triggerJobId - The job/run whose completion triggered this pass, recorded on the fixHistory entry for traceability
   */
  async verifyImplementedTasks(projectId, requestId = 'VERIFY', triggerJobId = null) {
    const pid = typeof projectId === 'string'
      ? new mongoose.Types.ObjectId(projectId)
      : projectId;

    console.log(`[VERIFY:${requestId}] Starting task verification | projectId=${pid} | triggerJobId=${triggerJobId || 'none'}`);

    // 1. Find every task that's been implemented at least once — IMPLEMENTED,
    // REOPENED, and (Phase 3 hardening) VERIFIED_FIXED too. Excluding
    // verified_fixed here would make it a dead end forever: nothing else in
    // the codebase ever re-examines it (Task.isValidTransition's
    // verified_fixed:[] only gates the user-initiated PATCH endpoint, which
    // this service bypasses entirely, same as it already does for every
    // other transition it performs), so a real regression on an
    // already-verified issue would never be detected. Accepted trade-off:
    // the query's working set now grows over a project's lifetime instead
    // of shrinking as issues get fixed — acceptable at realistic per-project
    // task counts, covered by the existing {projectId,status} index either way.
    const tasksToVerify = await Task.find({
      projectId: pid,
      status: { $in: ['implemented', 'reopened', 'verified_fixed'] },
    });

    if (tasksToVerify.length === 0) {
      console.log(`[VERIFY:${requestId}] No previously-implemented tasks to verify | projectId=${pid} | triggerJobId=${triggerJobId || 'none'}`);
      return { verified: 0, reopened: 0, skipped: 0 };
    }

    console.log(`[VERIFY:${requestId}] Found ${tasksToVerify.length} previously-implemented tasks to verify | projectId=${pid}`);

    // 2. Load the latest crawl results for comparison
    const db = mongoose.connection.db;
    const currentIssues = await this._loadCurrentIssues(db, pid, requestId);
    const withdrawnOnlyIssues = await this._loadWithdrawnOnlyIssues(db, pid, requestId);

    console.log(`[VERIFY:${requestId}] Loaded ${currentIssues.size} current issue+url pairs from crawl data | projectId=${pid}`);

    // 3. Batch-load raw seo_page_data for any URL whose latest attempt has a
    // real expected-after value — only these need value-diff resolution.
    const pageDataByUrl = await this._loadPageDataForValueDiff(db, pid, tasksToVerify, requestId);

    // 3a. Organization / Article / BreadcrumbList tasks are verified by inspecting the deployed
    // markup itself (see the schema gate below), so their pages are loaded here regardless of
    // whether an expected-after value was captured.
    const schemaPageDataByUrl = await this._loadSchemaPageData(db, pid, tasksToVerify, requestId);

    // 3b. Batch-load ai_scores/ai_issues for any AI-visibility-sourced task
    // (Phase 5) — see _loadAiVisibilityState's own docstring for why this is
    // scoped by {project_id, url}, deliberately NOT job_id.
    const aiVisibilityState = await this._loadAiVisibilityState(db, pid, tasksToVerify, requestId);

    // 4. Compare each task against current issues (+ value-diff where possible)
    let verified = 0;
    let reopened = 0;
    let skipped = 0;

    for (const task of tasksToVerify) {
      try {
        const now = new Date();
        const latestAttempt = task.fixHistory && task.fixHistory.length
          ? task.fixHistory[task.fixHistory.length - 1]
          : null;

        let result, method, matched, afterSnapshot;

        if (isAiVisibilityIssueKey(task.issueKey)) {
          // AI-visibility path — explicit, isolated from the on-page path
          // below (Phase 5 §28: must not change SEO/accessibility/technical
          // task verification behavior at all).
          const outcome = this._resolveAiVisibilityVerification(task, latestAttempt, aiVisibilityState);
          if (outcome === null) {
            // Not enough fresh data to trust a result either way — the
            // safest action is no action at all this round (§18/§19: never
            // fabricate verified_fixed from missing/stale data). Task's
            // status/history are left completely untouched.
            console.log(`[VERIFY:${requestId}] SKIPPED (AI-visibility data not fresh since last fix) | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);
            skipped++;
            continue;
          }
          ({ result, method, matched, afterSnapshot } = outcome);
        } else {
          // Typed WordPress fixes (image alt, Organization, Organization sameAs) carry a ledger record of exactly what was written. Their verdict must come from a
          // crawl that happened AFTER that write: an older crawl still shows the old finding (reopening on it would be wrong) or no finding
          // at all because the page was not part of it (verifying on it would be wrong). With no post-write crawl they stay pending.
          const typedWrite = latestAttempt?.fixApplied?.externalWrite;
          if (typedWrite?.system === 'wordpress' && ['image_alt', 'organization_schema', 'organization_same_as', 'breadcrumb_setting'].includes(typedWrite.field)) {
            const doc = pageDataByUrl.get(task.pageUrl) || schemaPageDataByUrl.get(task.pageUrl) || null;
            const crawledAt = doc?.scraped_at ? new Date(doc.scraped_at) : null;
            const writtenAt = new Date(typedWrite.writtenAt || latestAttempt?.implementedAt || task.implementedAt || 0);
            if (!crawledAt || Number.isNaN(crawledAt.getTime()) || crawledAt < writtenAt) {
              const reason = crawledAt ? 'The page has not been re-crawled since the WordPress change.' : 'The page was not found in the latest crawl.';
              console.log(`[VERIFY:${requestId}] PENDING (no crawl after the typed WordPress write) | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);
              this._emitEvent(pid.toString(), 'task:verification_pending', { taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: task.status, reasons: [reason] });
              skipped++;
              continue;
            }
          }

          // Existing on-page SEO path — unchanged, except for one honesty rule: a finding that was WITHDRAWN as not applicable is not a fix.
          const issueKey = this._buildIssueKey(task.issueKey, task.pageUrl);
          const issueStillExists = currentIssues.has(issueKey);
          if (!issueStillExists && !typedWrite?.system && withdrawnOnlyIssues.has(issueKey)) {
            console.log(`[VERIFY:${requestId}] PENDING (finding withdrawn as not applicable, nothing fixed) | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);
            this._emitEvent(pid.toString(), 'task:verification_pending', { taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: task.status, reasons: ['The audit no longer reports this finding because it was reclassified as not applicable (for example a tracking pixel, not a content image). Nothing was fixed, so it is not marked as verified.'] });
            skipped++;
            continue;
          }
          result = issueStillExists ? 'reopened' : 'verified_fixed';
          method = 'presence_fallback';
          matched = null;
          afterSnapshot = { source: 'unavailable', value: null };

          const expected = latestAttempt?.fixApplied?.expectedAfterValue;
          if (expected) {
            const pageDoc = pageDataByUrl.get(task.pageUrl);
            const resolvedAfter = pageDoc ? this._resolveAfterValue(pageDoc, expected.type) : null;
            if (resolvedAfter) {
              method = 'value_diff';
              matched = this._valuesMatch(expected, resolvedAfter);
              afterSnapshot = { source: 'structured_snapshot', value: resolvedAfter };

              // faq_schema is the one type where the issue merely DISAPPEARING
              // is not enough: the rule stops firing as soon as ANY FAQPage
              // schema exists, so a schema that does not match the visible FAQ
              // (wrong, partial, or edited afterwards) would otherwise be
              // reported as fixed. The value comparison is what decides it.
              //
              // aggregate_rating is the same: the rule only checks that SOME
              // aggregateRating key exists, so a missing count, a different value
              // or a rating on the wrong entity must not be reported as fixed.
              //
              // same_as is the same again: sameas_array stops firing as soon as
              // the Organization has ANY sameAs entry (a Facebook-derived one
              // counts), so the URLs the site owner added must actually be in
              // the rendered JSON-LD — "WordPress saved it" is not enough.
              // image_alt joins them ONLY for a typed per-image fix (it records the exact images it changed): the finding disappearing
              // is not enough — each changed image must show its approved alt on the recrawled page.
              const typedImageAlt = expected.type === 'image_alt' && Array.isArray(expected.images) && expected.images.length > 0;
              if ((expected.type === 'faq_schema' || expected.type === 'aggregate_rating' || expected.type === 'same_as' || expected.type === 'keyboard_accessibility' || typedImageAlt) && !issueStillExists && matched === false) {
                result = 'reopened';
              }
            }
          }
        }

        // Schema gate. "The audit finding is gone" is not proof a schema fix is live and correct:
        // the Organization rule stops firing as soon as ANY entity with a name and url exists,
        // so markup with a 404 logo, a duplicate entity or a broken breadcrumb trail used to be
        // reported verified_fixed. For schema issues a would-be success is only accepted after
        // the deployed JSON-LD itself passes inspection; a failure reopens the task with the
        // reasons recorded, and anything that cannot be judged right now (page not re-crawled
        // since the fix, an asset that could not be fetched) leaves the task pending - never
        // success, never a false failure.
        if (result === 'verified_fixed' && schemaInspectionApplies(task.issueKey)) {
          // For a breadcrumb task the owner may have confirmed the hierarchy (see recommendationController
          // .regenerateBreadcrumbHierarchy): the deployed trail is then verified against THAT, not just for being valid.
          let intendedBreadcrumb = null;
          if (task.issueKey === 'breadcrumblist_schema') {
            try { intendedBreadcrumb = (await getUserBreadcrumbEvidence(pid, task.pageUrl))?.items || null; } catch (err) {
              console.warn(`[VERIFY:${requestId}] saved breadcrumb hierarchy unavailable | taskId=${task._id}: ${err.message}`);
            }
          }
          // Organization tasks: the deployed entity is checked against the TYPE that was recommended (and a page that needs
          // no entity of its own against the site's entity), not only against "an Organization exists".
          let intendedOrganization = null; let site = null;
          if (task.issueKey === 'organization_schema' || task.issueKey === 'primary_organization_schema') {
            try { intendedOrganization = await loadIntendedOrganization(pid, task.issueKey, task.pageUrl); } catch { intendedOrganization = null; }
            try { site = await collectSiteEntity(pid); } catch { site = null; }
          }
          const inspection = await verifySchemaFix({
            issueKey: task.issueKey,
            pageDoc: schemaPageDataByUrl.get(task.pageUrl) || null,
            implementedAt: latestAttempt?.implementedAt || task.implementedAt,
            intendedBreadcrumb,
            intendedOrganization,
            site,
          });
          if (inspection.status === 'unverifiable') {
            console.log(`[VERIFY:${requestId}] PENDING (schema not verifiable yet) | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl} | reasons=${inspection.reasons.join(' / ')}`);
            this._emitEvent(pid.toString(), 'task:verification_pending', {
              taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: task.status, reasons: inspection.reasons,
            });
            skipped++;
            continue;
          }
          result = inspection.status === 'verified' ? 'verified_fixed' : 'reopened';
          method = 'value_diff';
          matched = inspection.status === 'verified';
          afterSnapshot = {
            source: 'structured_snapshot',
            value: { type: 'schema_inspection', kinds: inspection.kinds, passed: matched, reasons: inspection.reasons, checks: inspection.checks },
          };
        }

        // Presence always wins for "still reopened" — value-diff only
        // refines *how confidently* a verified_fixed result is reported.
        task.status = result;
        if (result === 'reopened') {
          task.reopenedAt = now;
        } else {
          task.verifiedAt = now;
        }

        this._recordVerification(task, latestAttempt, {
          now, method, result, matched, afterSnapshot, triggerJobId,
        });

        await task.save();

        if (result === 'reopened') {
          reopened++;
          console.log(`[VERIFY:${requestId}] REOPENED | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl} | method=${method} | triggerJobId=${triggerJobId || 'none'}`);
          this._emitEvent(pid.toString(), 'task:reopened', {
            taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: 'reopened',
            // Lets the UI word the outcome truthfully ("WordPress saved it, but the
            // rendered output could not be verified" only applies to an automated fix).
            origin: latestAttempt?.origin || null,
          });
        } else {
          verified++;
          console.log(`[VERIFY:${requestId}] VERIFIED_FIXED | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl} | method=${method} | matched=${matched} | triggerJobId=${triggerJobId || 'none'}`);
          this._emitEvent(pid.toString(), 'task:verified', {
            taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: 'verified_fixed',
            origin: latestAttempt?.origin || null,
          });
        }
      } catch (err) {
        // VersionError is the expected/handled outcome of a concurrent
        // verification race (see Task.js's optimisticConcurrency) — losing
        // that race is not a real failure, so it's logged distinctly from a
        // genuine error to keep this line actionable during on-call triage.
        const isRace = err.name === 'VersionError';
        const logFn = isRace ? console.log : console.error;
        logFn(`[VERIFY:${requestId}] ${isRace ? 'SKIPPED (concurrent write lost the race)' : 'ERROR'} | projectId=${pid} | taskId=${task._id} | triggerJobId=${triggerJobId || 'none'} | reason="${err.message}"`);
        skipped++;
      }
    }

    console.log(`[VERIFY:${requestId}] Verification complete | projectId=${pid} | triggerJobId=${triggerJobId || 'none'} | verified=${verified} | reopened=${reopened} | skipped=${skipped}`);

    return { verified, reopened, skipped };
  }

  /**
   * Write the verification result into fixHistory without ever overwriting
   * an attempt that was already verified once:
   *  - no fixHistory at all (legacy pre-migration task) → nothing to record
   *    structurally; the scalar status/verifiedAt/reopenedAt fields (already
   *    updated by the caller) are the only signal, which is the intended
   *    graceful degradation.
   *  - latest attempt never verified yet → fill in place.
   *  - latest attempt already verified, and this pass re-confirms the SAME
   *    result (nothing changed) → refresh the existing record in place
   *    rather than growing fixHistory. Phase 3: now that verified_fixed
   *    tasks stay in the re-verification scope forever (see
   *    verifyImplementedTasks), this branch fires on every routine recrawl
   *    for every already-resolved task — appending a new entry here would
   *    make fixHistory grow unboundedly from mere confirmations, not just
   *    real events.
   *  - latest attempt's result actually CHANGES (verified_fixed↔reopened
   *    with no re-implement in between) → append a new 'reverify_only'
   *    entry instead of clobbering the prior verification's recorded
   *    result — this is the one case that's a real, history-worthy event.
   */
  _recordVerification(task, latestAttempt, { now, method, result, matched, afterSnapshot, triggerJobId }) {
    if (!latestAttempt) return;

    if (latestAttempt.verification?.result == null) {
      latestAttempt.status = result;
      latestAttempt.verification.verifiedAt = now;
      latestAttempt.verification.method = method;
      latestAttempt.verification.result = result;
      latestAttempt.verification.matched = matched;
      latestAttempt.verification.after = afterSnapshot;
      latestAttempt.verification.triggerJobId = triggerJobId;
      return;
    }

    if (latestAttempt.verification.result === result) {
      latestAttempt.verification.verifiedAt = now;
      latestAttempt.verification.method = method;
      latestAttempt.verification.matched = matched;
      latestAttempt.verification.after = afterSnapshot;
      latestAttempt.verification.triggerJobId = triggerJobId;
      return;
    }

    task.fixHistory.push({
      attemptNumber: task.fixHistory.length + 1,
      attemptKind: 'reverify_only',
      origin: task.origin,
      status: result,
      before: {
        capturedAt: latestAttempt.verification.verifiedAt || now,
        source: latestAttempt.verification.after?.source || 'unavailable',
        dataPath: latestAttempt.before?.dataPath || null,
        value: latestAttempt.verification.after?.value ?? null,
      },
      fixApplied: {
        capturedAt: null,
        recommendationId: null,
        recommendationVersion: null,
        snapshot: null,
        expectedAfterValue: latestAttempt.fixApplied?.expectedAfterValue || null,
      },
      implementedAt: null,
      verification: {
        verifiedAt: now,
        method,
        result,
        matched,
        after: afterSnapshot,
        triggerJobId,
      },
    });
  }

  /**
   * Resolve a single AI-visibility-sourced task's verification outcome from
   * pre-batched V2 state. Returns null when there isn't enough FRESH data to
   * trust a result — the caller must treat that as "skip this task this
   * round," never as a result to record.
   *
   * Freshness guard (Phase 5 investigation, both gotchas addressed by one
   * check): the two pre-existing Node precedents for querying ai_issues
   * (V2IssueExtractor.js, contextExtractor.js) scope by "the project's
   * latest job_id" — proven unsafe here, because a partial/single-URL
   * AI_VISIBILITY rerun never updates job_id on pages outside its `urls`
   * filter, so "latest job_id" silently misses real, current issues on
   * untouched pages. ai_issues also has a 90-day TTL on created_at, so an
   * issue that hasn't been reprocessed in 90+ days vanishes from the
   * collection by itself — indistinguishable from "fixed" under a pure
   * absence check. Instead of trying to reason about job_id recency or the
   * TTL window, this asks the one question that actually matters: has THIS
   * URL's AI score been recomputed since THIS fix was implemented? If yes,
   * the current ai_issues state (queried with no job_id filter at all — see
   * _loadAiVisibilityState) is trustworthy, however old or new its job_id
   * happens to be. If no (never scored, or last scored before the fix),
   * nothing has re-examined this page since the fix — reporting anything
   * here would be a guess, not a verification.
   */
  _resolveAiVisibilityVerification(task, latestAttempt, aiVisibilityState) {
    const { scoredAtByUrl, issuePresenceSet } = aiVisibilityState;

    const implementedBaseline = latestAttempt?.implementedAt || task.implementedAt;
    const scoredAt = scoredAtByUrl.get(task.pageUrl);

    if (!implementedBaseline || !scoredAt || !(scoredAt > implementedBaseline)) {
      return null;
    }

    const issuePresent = issuePresenceSet.has(`${task.pageUrl}::${task.issueKey}`);
    const result = issuePresent ? 'reopened' : 'verified_fixed';

    return {
      result,
      method: 'ai_visibility_issue_lifecycle',
      // No "expected value" concept exists for a binary presence/absence
      // signal — matched:null is the established convention for exactly
      // this ("no value comparison happened"), same as presence_fallback.
      matched: null,
      afterSnapshot: {
        source: 'structured_snapshot',
        value: { type: 'ai_visibility_issue', ruleId: task.issueKey, url: task.pageUrl, issuePresent },
      },
    };
  }

  /**
   * Batch-load the minimum V2 state needed to verify every AI-visibility
   * task in this pass: per-URL AI score freshness (ai_scores.scored_at) and
   * per-(url,rule_id) issue presence (ai_issues) — 2 queries total for the
   * whole batch, not per task, mirroring _loadPageDataForValueDiff's own
   * batching pattern. Both queries are covered by existing indexes
   * (ai_scores' unique {project_id,url}; ai_issues' {project_id,url}
   * v2_issues_by_url) — confirmed against python_workers/db.py, no new
   * index needed.
   *
   * Deliberately queries by {project_id, url} ONLY — no job_id — since a
   * partial AI-visibility rerun leaves untouched pages on an older job_id
   * (see _resolveAiVisibilityVerification's docstring); filtering by "the
   * project's latest job_id" would silently miss real current state for
   * exactly the pages this verification most needs to check honestly.
   */
  async _loadAiVisibilityState(db, projectId, tasks, requestId = 'VERIFY') {
    const urls = new Set();
    for (const task of tasks) {
      if (isAiVisibilityIssueKey(task.issueKey)) urls.add(task.pageUrl);
    }

    const scoredAtByUrl = new Map();
    const issuePresenceSet = new Set();
    if (urls.size === 0) return { scoredAtByUrl, issuePresenceSet };

    const urlList = Array.from(urls);

    try {
      const scores = await db.collection('ai_scores').find(
        { project_id: projectId, url: { $in: urlList } },
        { projection: { url: 1, scored_at: 1 } }
      ).toArray();
      for (const score of scores) {
        if (score.url && score.scored_at) scoredAtByUrl.set(score.url, score.scored_at);
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading ai_scores | projectId=${projectId}: ${err.message}`);
    }

    try {
      const issues = await db.collection('ai_issues').find(
        { project_id: projectId, url: { $in: urlList } },
        { projection: { url: 1, rule_id: 1 } }
      ).toArray();
      for (const issue of issues) {
        if (issue.url && issue.rule_id) issuePresenceSet.add(`${issue.url}::${issue.rule_id}`);
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading ai_issues | projectId=${projectId}: ${err.message}`);
    }

    return { scoredAtByUrl, issuePresenceSet };
  }

  /**
   * Load raw seo_page_data docs for every URL whose latest fixHistory
   * attempt has a real expected-after value — the only ones that need
   * value-diff resolution. Skips the query entirely if none do.
   */
  async _loadPageDataForValueDiff(db, projectId, tasks, requestId = 'VERIFY') {
    const urls = new Set();
    const keyboardUrls = new Set();
    for (const task of tasks) {
      const latest = task.fixHistory && task.fixHistory.length
        ? task.fixHistory[task.fixHistory.length - 1]
        : null;
      if (latest?.fixApplied?.expectedAfterValue) {
        urls.add(task.pageUrl);
        if (latest.fixApplied.expectedAfterValue.type === 'keyboard_accessibility') keyboardUrls.add(task.pageUrl);
      }
    }

    const pageDataByUrl = new Map();
    if (urls.size === 0) return pageDataByUrl;

    try {
      const pages = await db.collection('seo_page_data').find(
        { projectId, url: { $in: Array.from(urls) } },
        { projection: { url: 1, scraped_at: 1, title: 1, meta_tags: 1, headings: 1, canonical: 1, images: 1, structured_data: 1, 'faq_howto_signals.faq_pairs': 1 } }
      ).toArray();
      for (const page of pages) {
        pageDataByUrl.set(page.url, page);
      }

      // The keyboard/focus audit lives in seo_headless_data (not seo_page_data). It is merged
      // onto the page document so _resolveAfterValue reads it like any other crawled field.
      if (keyboardUrls.size) {
        const audits = await db.collection('seo_headless_data').find(
          { projectId, url: { $in: Array.from(keyboardUrls) } },
          { projection: { url: 1, keyboard_analysis: 1 } }
        ).toArray();
        for (const audit of audits) {
          const page = pageDataByUrl.get(audit.url) || { url: audit.url };
          page.keyboard_analysis = audit.keyboard_analysis;
          pageDataByUrl.set(audit.url, page);
        }
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading seo_page_data for value-diff | projectId=${projectId}: ${err.message}`);
    }
    return pageDataByUrl;
  }

  /**
   * Batch-load the post-crawl seo_page_data of every page that has a schema task, for
   * verifySchemaFix. One query for the whole pass; skipped entirely when there are none.
   */
  async _loadSchemaPageData(db, projectId, tasks, requestId = 'VERIFY') {
    const urls = new Set();
    for (const task of tasks) if (schemaInspectionApplies(task.issueKey)) urls.add(task.pageUrl);
    const byUrl = new Map();
    if (urls.size === 0) return byUrl;
    try {
      const pages = await db.collection('seo_page_data').find(
        { projectId, url: { $in: Array.from(urls) } },
        { projection: { url: 1, canonical: 1, meta_tags: 1, structured_data: 1, word_count: 1, page_type: 1, title: 1, 'content.headings': 1, scraped_at: 1 } }
      ).toArray();
      for (const page of pages) byUrl.set(page.url, page);
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading seo_page_data for schema inspection | projectId=${projectId}: ${err.message}`);
    }
    return byUrl;
  }

  /**
   * Resolve the actual current value for one of the 5 known snapshot types
   * from a raw seo_page_data document, shaped identically to before.value /
   * expectedAfterValue so they can be compared directly. Returns null if the
   * type is unrecognized or the field is absent — callers fall back to
   * presence-only verification in that case.
   */
  _resolveAfterValue(pageDoc, type) {
    switch (type) {
      case 'title':
        return { type, title: (pageDoc.title || '').trim() || null };
      case 'meta_description': {
        const descriptions = pageDoc.meta_tags?.description || [];
        return { type, metaDescription: (descriptions[0] || '').trim() || null };
      }
      case 'h1': {
        const h1s = (pageDoc.headings || []).filter(h => h.tag === 'h1' && (h.text || '').trim());
        return { type, h1Text: h1s.map(h => h.text.trim()) };
      }
      case 'canonical':
        return { type, canonical: (pageDoc.canonical || '').trim() || null };
      case 'robots': {
        // meta_tags.robots is the crawler's array-of-raw-content-attribute
        // strings for every <meta name="robots"> tag found on the page
        // (same shape convention as meta_tags.description, read as [0]
        // above) — parsed leniently since real themes render this content
        // attribute in varying styles (see parseRobotsDirectives's own
        // docblock). Absence of the tag entirely is treated as the
        // permissive default (index, follow), same as WordPress's own
        // behavior when no robots meta is rendered at all.
        const raw = pageDoc.meta_tags?.robots?.[0];
        const parsed = parseRobotsDirectives(typeof raw === 'string' ? raw : '');
        return { type, index: parsed.index, follow: parsed.follow };
      }
      case 'image_alt': {
        // Alt-text fixes don't change src, so the target image is matched by
        // its (unchanged) src rather than by array position.
        // The identity facts (lazy URL, srcset, wp-image id) let a typed per-image fix be matched to the SAME rendered image
        // later (see _valuesMatch); the legacy src/alt pair is unchanged.
        return {
          type,
          images: (pageDoc.images || []).map(img => ({
            src: img.src, alt: img.alt || null,
            lazy_src: img.lazy_src ?? null, srcset_urls: img.srcset_urls || [], wp_attachment_id: img.wp_attachment_id ?? null,
          })),
        };
      }
      case 'same_as': {
        // pageDoc.structured_data is the crawler's array of parsed JSON-LD
        // objects for this page (same field SchemaResolver.js reads) — find
        // the Organization/LocalBusiness entity and read its CURRENT sameAs
        // list as actually rendered, not assumed from the write.
        //
        // Rank Math (and most SEO plugins) emit the Organization inside an
        // "@graph" rather than as a top-level entry, so the graph is flattened
        // first. The sameAs of EVERY Organization/LocalBusiness node is unioned:
        // a page can carry more than one such node, and what matters here is
        // whether the URL the site owner added is in the rendered output at all.
        const orgTypes = ['Organization', 'LocalBusiness'];
        const sameAs = flattenSchemaNodes(pageDoc.structured_data)
          .filter((node) => (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).some((t) => orgTypes.includes(t)))
          .flatMap((node) => (node.sameAs ? (Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs]) : []));
        return { type, sameAs };
      }
      case 'breadcrumb': {
        const hasBreadcrumb = !!this._findSchemaByType(pageDoc.structured_data, ['BreadcrumbList']);
        return { type, enabled: hasBreadcrumb };
      }
      case 'faq_schema': {
        // Pairs as the crawler now sees them in the rendered page's FAQPage
        // JSON-LD (any FAQPage block, @graph-aware), plus the FAQ pairs that
        // are visible in the page itself — both are needed to decide that the
        // schema matches what visitors can read (see _valuesMatch).
        return {
          type,
          pairs: extractFaqPairsFromStructuredData(pageDoc.structured_data),
          // How many FAQPage ENTITIES the page renders. Two (a theme or plugin plus the Bridge) is duplicate FAQPage
          // markup: the pairs still "match", but the page is wrong, so it is never reported as fixed.
          faqEntityCount: findFaqPageSchemas(pageDoc.structured_data).length,
          visiblePairs: sanitizeFaqPairs(pageDoc.faq_howto_signals?.faq_pairs),
        };
      }
      case 'keyboard_accessibility': {
        // The latest keyboard/focus audit for this page. Only a v2 audit knows per-element
        // results; a v1 (counts only) audit cannot confirm anything about specific elements.
        const k = pageDoc.keyboard_analysis;
        if (!k || !k.keyboard_navigation_checked || (k.audit_version || 1) < 2) return { type, auditable: false };
        return {
          type,
          auditable: true,
          auditVersion: k.audit_version,
          testedAt: k.tested_at ? new Date(k.tested_at).toISOString() : null,
          completed: !!k.traversal?.completed,
          missingCount: k.affected_elements?.missing_focus_indicator_total ?? k.missing_focus_outline ?? 0,
          trapDetected: !!k.focus_trap_detected,
          unreachableCount: k.unreachable_elements ?? 0,
          results: (Array.isArray(k.element_results) ? k.element_results : []).map((r) => ({ selector: r.selector, status: r.status })),
        };
      }
      case 'aggregate_rating': {
        // Every AggregateRating the rendered page now exposes (any node, @graph
        // aware), already sanitized — small enough to store as the after-snapshot.
        return { type, ratings: extractAggregateRatings(pageDoc.structured_data) };
      }
      default:
        return null;
    }
  }

  /**
   * Find the first structured-data entry whose @type matches one of
   * `types` — @type may be a single string or an array of strings (a
   * schema entity can legitimately declare multiple types), so both shapes
   * are checked. Returns null (never throws) if structuredData is missing,
   * not an array, or nothing matches.
   */
  _findSchemaByType(structuredData, types) {
    if (!Array.isArray(structuredData)) return null;
    return structuredData.find((entry) => {
      const entryTypes = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
      return entryTypes.some((t) => types.includes(t));
    }) || null;
  }

  /**
   * Compare an expected value (from the AI fix / recommendation) against the
   * actual current value resolved from the latest scan. Case/whitespace
   * insensitive — the fix is "matched" if the meaningful content lines up,
   * not byte-identical.
   *
   * Bug fix (Phase 3 verification audit): `norm` now goes through
   * valueNormalization.js's normalizeTextValue() instead of a bare
   * trim+lowercase — WordPress's wptexturize (applied when rendering
   * the_title()/content) converts plain ASCII quotes/dashes to their
   * typographic equivalents, and the crawler decodes HTML entities back to
   * natural Unicode when parsing the rendered page, so a value that
   * round-tripped through a real WordPress write+recrawl could previously
   * register as a false "reopened" even though nothing meaningful changed.
   * This is strictly ADDITIVE (folds more values together, never fewer) —
   * every comparison that matched under the old bare trim+lowercase still
   * matches now. Canonical additionally tolerates a trailing-slash
   * difference via canonicalValuesMatch(), since WordPress frequently
   * normalizes permalinks that way regardless of what was written.
   */
  _valuesMatch(expected, actual) {
    if (!expected || !actual) return false;
    const norm = normalizeTextValue;

    switch (expected.type) {
      case 'title':
        return !!actual.title && norm(expected.title) === norm(actual.title);
      case 'meta_description':
        return !!actual.metaDescription && norm(expected.metaDescription) === norm(actual.metaDescription);
      case 'canonical':
        return canonicalValuesMatch(expected.canonical, actual.canonical);
      case 'robots':
        return robotsValuesMatch(expected, actual);
      case 'h1': {
        const expectedText = norm(expected.h1Text);
        const actualTexts = (actual.h1Text || []).map(norm);
        if (!expectedText || !actualTexts.includes(expectedText)) return false;
        // h1_missing records h1Count: 1 — the page must end up with exactly one H1, not the
        // right text alongside a second heading.
        return expected.h1Count == null || actualTexts.length === expected.h1Count;
      }
      case 'image_alt': {
        // A typed per-image fix (the WordPress media-library alt fix) records EVERY image it changed. Each must be found on the
        // rendered page by stable evidence (the wp-image id or an exact upload path of its attachment — never file-name similarity)
        // and show the approved alt; an image that cannot be matched, or shows another alt, means not fixed.
        if (Array.isArray(expected.images) && expected.images.length) {
          return expected.images.every((target) => {
            const want = norm(target.alt);
            const { matched } = matchRenderedImages(actual.images, { attachmentId: target.attachmentId, exactPaths: target.exactPaths });
            if (!want || matched.length === 0) return false;
            // A Divi page-module fix changes ONE use of the attachment; its other uses legitimately keep their own alt (a footer logo, say).
            // The approved text must be shown by at least one use, and every use must show it or one of the alts the others had when the fix was made —
            // an empty use is never accepted.
            if (target.occurrence?.mode === 'one_use') {
              const others = new Set((target.occurrence.otherAlts || []).map(norm).filter(Boolean));
              return matched.some((img) => norm(img.alt) === want) && matched.every((img) => norm(img.alt) === want || others.has(norm(img.alt)));
            }
            return matched.every((img) => norm(img.alt) === want);
          });
        }
        const expectedAlt = norm(expected.alt);
        const match = (actual.images || []).find(img => (img.alt || null) != null && norm(img.alt) === expectedAlt);
        return !!expectedAlt && !!match;
      }
      case 'same_as': {
        // "Matched" means EVERY URL the site owner asked Odito to add now
        // appears in the RENDERED Organization schema's sameAs list — not that
        // the whole list equals some expected array (which would falsely
        // reopen the moment an unrelated profile is added/removed by the site
        // owner directly in Rank Math). `urls` is the current shape; a single
        // legacy `url` (older fix attempts) is still honoured. URLs are compared
        // by sameAsComparisonKey so a trailing slash or http/https difference
        // introduced by the theme/plugin doesn't cause a false reopen.
        const wanted = Array.isArray(expected.urls) ? expected.urls : (expected.url ? [expected.url] : []);
        if (!wanted.length) return false;
        const rendered = new Set((actual.sameAs || []).map(sameAsComparisonKey).filter(Boolean));
        return wanted.every((url) => {
          const key = sameAsComparisonKey(url);
          return !!key && rendered.has(key);
        });
      }
      case 'keyboard_accessibility': {
        // Re-tests the EXACT elements the fix targeted against a fresh audit — never by
        // looking for "outline" in CSS. Each selector must have been tabbed to and show a
        // visible, distinguishable indicator ('weak' low-contrast does not count).
        if (!actual.auditable) return false;
        // Only an audit run after the fix was recorded can confirm it.
        if (expected.notBefore && (!actual.testedAt || new Date(actual.testedAt) < new Date(expected.notBefore))) return false;
        const status = new Map((actual.results || []).map((r) => [r.selector, r.status]));
        const selectors = expected.selectors || [];
        for (const selector of selectors) {
          const s = status.get(selector);
          if (s === 'present') continue;
          // A selector the new audit no longer contains (renamed/removed element) is only
          // accepted when the audit completed and found no missing indicator anywhere.
          if (s === undefined && actual.completed && actual.missingCount === 0) continue;
          return false;
        }
        if (expected.requireNoUnintendedTrap && actual.trapDetected) return false;
        if (expected.requireReachable && actual.unreachableCount > 0) return false;
        return selectors.length > 0 || !!expected.requireNoUnintendedTrap || !!expected.requireReachable;
      }
      case 'breadcrumb':
        return expected.enabled === actual.enabled;
      case 'faq_schema': {
        // Fixed only if (1) the rendered FAQPage carries exactly the pairs the
        // fix generated — every question and answer, nothing extra — AND (2)
        // those pairs are still what the page visibly shows, so a schema that
        // matches the recommendation but no longer matches the page (content
        // edited since) is not reported as fixed either.
        return (actual.faqEntityCount ?? 1) <= 1 && faqPairsMatch(expected.pairs, actual.pairs) && faqPairsAreSubset(actual.pairs, actual.visiblePairs);
      }
      case 'aggregate_rating': {
        // Fixed only if a VALID AggregateRating (real ratingValue inside its scale
        // + a real count) sits on the SAME entity (@id) the fix targeted and
        // carries exactly the generated figures.
        return !!expected.target?.id && (actual.ratings || []).some(
          (item) => item.valid && item.nodeId === expected.target.id && ratingsEqual(item.rating, expected.rating)
        );
      }
      default:
        return false;
    }
  }

  /**
   * Load all currently OPEN issues from the latest crawl/verification data.
   * Returns a Set of "issueKey::pageUrl" strings for fast lookup.
   *
   * P3-002: filtered to status:'open' — seo_page_issues is now a reconciled
   * current-issue snapshot (PAGE_ANALYSIS transitions resolved issues away
   * from 'open' after every re-analysis), so an issue that's actually been
   * fixed no longer appears here regardless of how long ago it was first
   * detected.
   *
   * Phase 4: this used to also query `seo_ai_visibility_issues` for
   * AI-visibility-sourced issues. That collection is confirmed dead —
   * exhaustive repo-wide audit found zero writers anywhere, no Mongoose
   * model, and no reachable frontend/API dependency (see
   * project_ai_visibility_cleanup memory / Phase 4 report). Removing the
   * read changed nothing observable: the query always returned an empty
   * result set.
   *
   * This function only ever handles on-page (seo_page_issues) tasks now —
   * AI-visibility-sourced tasks (isAiVisibilityIssueKey) are routed to a
   * completely separate path in verifyImplementedTasks
   * (_resolveAiVisibilityVerification / _loadAiVisibilityState, Phase 5),
   * which queries the active `ai_issues`/`ai_scores` (V2) collections
   * instead — different document shape, different identity model, so it
   * isn't folded into this Set-based lookup.
   */
  async _loadCurrentIssues(db, projectId, requestId = 'VERIFY') {
    const issueSet = new Set();

    // On-page issues (stored per page with issue_code field)
    try {
      const onPageIssues = await db.collection('seo_page_issues').find(
        { projectId, status: 'open' },
        { projection: { issue_code: 1, page_url: 1, url: 1 } }
      ).toArray();

      for (const issue of onPageIssues) {
        const url = issue.page_url || issue.url;
        if (issue.issue_code && url) {
          issueSet.add(this._buildIssueKey(issue.issue_code, url));
        }
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading on-page issues | projectId=${projectId}: ${err.message}`);
    }

    return issueSet;
  }

  /**
   * Issue+page pairs whose ONLY remaining findings were WITHDRAWN as not applicable (status 'excluded': e.g. a tracking pixel the crawler
   * once reported as an image missing alt text). Nothing was fixed there, so absence from the open issues proves nothing — such a task
   * must not be told "verified fixed". A pair that also has a genuinely RESOLVED finding (a real image that was fixed) is not in this
   * set: that disappearance is a real fix.
   */
  async _loadWithdrawnOnlyIssues(db, projectId, requestId = 'VERIFY') {
    const withdrawn = new Set();
    try {
      const rows = await db.collection('seo_page_issues').aggregate([
        { $match: { projectId, issue_code: { $in: RECLASSIFIABLE_ISSUE_CODES }, status: { $in: ['excluded', 'resolved', 'open'] } } },
        { $group: { _id: { code: '$issue_code', url: { $ifNull: ['$page_url', '$url'] } }, statuses: { $addToSet: '$status' } } },
      ]).toArray();
      for (const r of rows) {
        if (r.statuses.includes('excluded') && !r.statuses.includes('resolved') && !r.statuses.includes('open') && r._id.url) {
          withdrawn.add(this._buildIssueKey(r._id.code, r._id.url));
        }
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading withdrawn issues | projectId=${projectId}: ${err.message}`);
    }
    return withdrawn;
  }

  /**
   * Build a composite key for issue lookup.
   * Normalizes URL to handle trailing slashes and case.
   */
  _buildIssueKey(issueKey, pageUrl) {
    const normalizedUrl = (pageUrl || '')
      .toLowerCase()
      .replace(/\/+$/, '');   // Strip trailing slashes
    return `${issueKey}::${normalizedUrl}`;
  }

  /**
   * Emit WebSocket event to the project room.
   */
  _emitEvent(projectId, eventName, payload) {
    if (global.io) {
      global.io.to(`project-${projectId}`).emit(eventName, payload);
    }
  }
}

export default new TaskVerificationService();
