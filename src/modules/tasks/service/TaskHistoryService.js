import mongoose from 'mongoose';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { inferSnapshotType } from './issueSnapshotTypes.js';
import { extractH1TextValue } from './h1Value.js';
import { expectedAfterFromAfterState } from './keyboardAccessibilityState.js';
import { isAiVisibilityIssueKey } from './aiVisibilityIssueIdentity.js';
import { parseFaqPageJsonLd } from './faqSchema.js';
import { parseAggregateRatingJsonLd } from './aggregateRatingSchema.js';
import {
  extractCanonicalUrlValue,
  normalizeRobotsValue,
  normalizeSchemaUrlValue,
  normalizeBreadcrumbEnableValue,
} from './valueNormalization.js';

/**
 * TaskHistoryService
 *
 * Builds one immutable fixHistory entry each time a Task transitions into
 * 'implemented' — real before-state (from seo_page_issues) + a frozen copy
 * of the AI recommendation used (if any), never a live reference (
 * Recommendation docs are upserted/overwritten by fingerprint and
 * TTL-expired, so a later attempt's regeneration must not silently change
 * what an earlier attempt is shown to have applied).
 */
class TaskHistoryService {
  /**
   * @param {Object} params
   * @param {ObjectId|string} params.projectId
   * @param {string} params.issueKey
   * @param {string} params.pageUrl
   * @param {string} params.origin
   * @param {ObjectId|string|null} params.recommendationId
   * @param {number} params.attemptNumber - 1-based position in fixHistory
   * @param {Object|null} [params.expectedAfterValueOverride] - replaces the value
   *   derived from the recommendation. Only for fixes whose value is supplied by
   *   the site owner rather than generated (sameAs social profiles): the frozen
   *   expected-after state must be what was actually written, since that is what
   *   TaskVerificationService later looks for in the rendered page.
   * @param {Object|null} [params.issueContext] - the task's frozen element-level context (see
   *   taskIssueContext.js); the fallback when the recommendation it was created with is gone.
   * @returns {Promise<Object>} a fixAttemptSchema-shaped plain object
   */
  async buildFixAttempt({ projectId, issueKey, pageUrl, origin, recommendationId, attemptNumber, expectedAfterValueOverride = null, issueContext = null }) {
    const now = new Date();
    const db = mongoose.connection.db;

    const [before, fixApplied] = await Promise.all([
      this._captureBefore(db, projectId, issueKey, pageUrl),
      this._captureFixApplied(recommendationId, issueKey, now),
    ]);
    if (expectedAfterValueOverride) {
      fixApplied.expectedAfterValue = expectedAfterValueOverride;
    }

    // keyboard_accessibility: one page can have several findings under this one issue
    // code (focus indicators, a trap, unreachable elements) but the issue lookup above
    // returns just one of them. The recommendation's beforeState is built from the whole
    // audit, so the task's before-state uses it — the affected elements are never lost
    // when a task is created.
    if (inferSnapshotType(issueKey) === 'keyboard_accessibility') {
      // The recommendation's states win; the task's own frozen issueContext covers a
      // recommendation that expired or was regenerated since the task was created.
      const frozenBefore = fixApplied.snapshot?.beforeState ?? issueContext?.beforeState;
      if (frozenBefore) {
        before.value = frozenBefore;
        before.source = 'structured_snapshot';
      }
      if (!fixApplied.expectedAfterValue && issueContext?.afterState) {
        fixApplied.expectedAfterValue = expectedAfterFromAfterState(issueContext.afterState);
      }
      // Only an audit run AFTER this fix was recorded can confirm it.
      if (fixApplied.expectedAfterValue) {
        fixApplied.expectedAfterValue = { ...fixApplied.expectedAfterValue, notBefore: now.toISOString() };
      }
    }

    return {
      attemptNumber,
      attemptKind: 'fix_attempt',
      origin: origin || null,
      status: 'pending_verification',
      before,
      fixApplied,
      implementedAt: now,
      verification: {
        verifiedAt: null,
        method: null,
        result: null,
        matched: null,
        after: { source: 'unavailable', value: null },
        triggerJobId: null,
      },
    };
  }

  /**
   * Real before-value from seo_page_issues if the rule captured a structured
   * snapshot (P0-005-adjacent change: title/meta description/h1/image
   * alt/canonical only); diagnostic string otherwise; 'unavailable' if the
   * issue can't be found at all. AI-visibility (V2 hub) issues branch to
   * _captureBeforeAiVisibility — a different collection/identity model
   * (ai_issues, snake_case fields, no seo_page_issues doc exists for them).
   */
  async _captureBefore(db, projectId, issueKey, pageUrl) {
    if (isAiVisibilityIssueKey(issueKey)) {
      return this._captureBeforeAiVisibility(db, projectId, issueKey, pageUrl);
    }

    const fallback = { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null };
    try {
      const pid = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;
      const issueDoc = await db.collection('seo_page_issues').findOne(
        { projectId: pid, issue_code: issueKey, page_url: pageUrl },
        { projection: { before_snapshot: 1, detected_value: 1, data_path: 1 } }
      );
      if (!issueDoc) return fallback;

      if (issueDoc.before_snapshot != null) {
        return {
          capturedAt: new Date(),
          source: 'structured_snapshot',
          dataPath: issueDoc.data_path || null,
          value: issueDoc.before_snapshot,
        };
      }
      if (issueDoc.detected_value != null && issueDoc.detected_value !== '') {
        return {
          capturedAt: new Date(),
          source: 'diagnostic_string',
          dataPath: issueDoc.data_path || null,
          value: issueDoc.detected_value,
        };
      }
      return { ...fallback, dataPath: issueDoc.data_path || null };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing before-state | projectId=${projectId} | issueKey=${issueKey} | pageUrl=${pageUrl}: ${err.message}`);
      return fallback;
    }
  }

  /**
   * Real before-value for a V2 AI-visibility (AISO/AEO/GEO) issue: the live
   * ai_issues doc for this exact (project_id, url, rule_id) at fix-time.
   * Deliberately no job_id filter — same safety principle as
   * TaskVerificationService._loadAiVisibilityState, this must find the issue
   * regardless of which analysis run last touched this URL. If no matching
   * doc exists (issue already resolved before the task was created, or
   * genuinely missing data), returns 'unavailable' rather than fabricating a
   * before-state.
   */
  async _captureBeforeAiVisibility(db, projectId, issueKey, pageUrl) {
    const fallback = { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null };
    try {
      const pid = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;
      const issueDoc = await db.collection('ai_issues').findOne(
        { project_id: pid, url: pageUrl, rule_id: issueKey },
        { projection: { issue_title: 1, issue_description: 1, severity: 1, hub: 1, card: 1 } }
      );
      if (!issueDoc) return fallback;

      return {
        capturedAt: new Date(),
        source: 'structured_snapshot',
        dataPath: null,
        value: {
          type: 'ai_visibility_issue',
          ruleId: issueKey,
          hub: issueDoc.hub ?? null,
          card: issueDoc.card ?? null,
          title: issueDoc.issue_title ?? null,
          description: issueDoc.issue_description ?? null,
          severity: issueDoc.severity ?? null,
          issuePresent: true,
        },
      };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing AI-visibility before-state | projectId=${projectId} | issueKey=${issueKey} | pageUrl=${pageUrl}: ${err.message}`);
      return fallback;
    }
  }

  /**
   * Frozen copy of the Recommendation used to implement this attempt, plus a
   * best-effort structured "expected after" value shaped identically to
   * before.value so TaskVerificationService can diff them directly.
   */
  async _captureFixApplied(recommendationId, issueKey, now) {
    const empty = {
      capturedAt: null,
      recommendationId: null,
      recommendationVersion: null,
      snapshot: null,
      expectedAfterValue: null,
    };
    if (!recommendationId) return empty;

    try {
      const rec = await Recommendation.findById(recommendationId).lean();
      if (!rec) return { ...empty, capturedAt: now, recommendationId };

      const snapshot = {
        whyThisMatters: rec.sections?.whyThisMatters ?? null,
        recommendedFix: rec.sections?.recommendedFix ?? null,
        recommendedVersion: rec.sections?.recommendedVersion ?? null,
        contentRewrite: rec.sections?.contentRewrite ?? null,
        changeSummary: rec.sections?.changeSummary ?? null,
        // Deterministic element-level states (keyboard_accessibility): which elements
        // were affected and what must be true afterwards. Frozen with the attempt.
        beforeState: rec.sections?.beforeState ?? null,
        afterState: rec.sections?.afterState ?? null,
        difficulty: rec.sections?.difficulty ?? null,
        generatedBy: rec.generatedBy ?? null,
      };

      return {
        capturedAt: now,
        recommendationId: rec._id,
        recommendationVersion: rec.recommendationVersion ?? null,
        snapshot,
        expectedAfterValue: this._deriveExpectedAfterValue(rec, issueKey),
      };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing fix-applied snapshot | recommendationId=${recommendationId} | issueKey=${issueKey}: ${err.message}`);
      return { ...empty, capturedAt: now, recommendationId };
    }
  }

  /**
   * Shared "transition a Task to implemented" logic — builds the fixHistory
   * entry via buildFixAttempt() above and applies it to the in-memory Task
   * document (status, implementedAt, recommendationId, fixHistory push).
   * The caller is responsible for `await task.save()` (so it can decide how
   * to handle a concurrent-write VersionError — see Task.js's
   * optimisticConcurrency — rather than this method swallowing it).
   *
   * Used by both taskController.js (human-initiated: "Create Task" with an
   * initial implemented status, and the "Mark as Implemented" PATCH) and
   * wordPressSeoFixService.js (Odito-initiated, origin: 'wordpress_auto') —
   * added specifically so neither path re-implements the
   * build-attempt/push/set-status glue independently.
   *
   * @param {import('../model/Task.js').default} task - a loaded (not .lean()) Task document
   * @param {Object} params
   * @param {string} params.origin
   * @param {string|ObjectId|null} [params.recommendationId]
   * @param {Object|null} [params.externalWrite] - see Task.js's fixApplied.externalWrite; only ever set for origin: 'wordpress_auto'
   * @param {Object|null} [params.expectedAfterValueOverride] - see buildFixAttempt()
   * @returns {Promise<Object>} the fixHistory entry that was appended
   */
  async applyImplementedTransition(task, { origin, recommendationId = null, externalWrite = null, expectedAfterValueOverride = null, issueContext = task.issueContext ?? null } = {}) {
    const attemptNumber = (task.fixHistory?.length || 0) + 1;
    const attempt = await this.buildFixAttempt({
      projectId: task.projectId,
      issueKey: task.issueKey,
      pageUrl: task.pageUrl,
      origin,
      recommendationId,
      attemptNumber,
      expectedAfterValueOverride,
      issueContext,
    });

    if (externalWrite) {
      attempt.fixApplied = attempt.fixApplied || {};
      attempt.fixApplied.externalWrite = externalWrite;
    }

    task.fixHistory = task.fixHistory || [];
    task.fixHistory.push(attempt);
    task.status = 'implemented';
    task.implementedAt = attempt.implementedAt;
    if (recommendationId) {
      task.recommendationId = recommendationId;
    }

    return attempt;
  }

  /**
   * Public wrapper around _captureFixApplied() for callers that need to
   * resolve a Recommendation's expected-after value WITHOUT building a full
   * fixHistory entry — used by wordPressSeoFixService.js to derive the
   * value it should write to WordPress from the same source
   * (Recommendation.sections.contentRewrite.optimized/recommendedVersion)
   * TaskVerificationService later compares against, so "what Odito writes"
   * and "what Odito verifies" can never drift apart.
   */
  async resolveExpectedValue(recommendationId, issueKey) {
    const fixApplied = await this._captureFixApplied(recommendationId, issueKey, new Date());
    return { snapshot: fixApplied.snapshot, expectedAfterValue: fixApplied.expectedAfterValue };
  }

  _deriveExpectedAfterValue(rec, issueKey) {
    const type = inferSnapshotType(issueKey);
    if (!type) return null;

    const optimized = rec.sections?.contentRewrite?.optimized ?? rec.sections?.recommendedVersion ?? null;
    if (optimized == null || optimized === '') return null;
    const value = String(optimized).trim();

    switch (type) {
      case 'title':            return { type, title: value };
      case 'meta_description': return { type, metaDescription: value };
      case 'h1': {
        // The recommendation often arrives as markup ("<h1>Title</h1>"); what is written to the
        // page and what is verified is the PLAIN TEXT. h1_missing additionally expects exactly
        // one H1 afterwards. A value that is not a valid plain-text H1 is kept as-is (manual /
        // DIY flow, verified by text) — the WordPress write path refuses it on its own.
        const h1Text = extractH1TextValue(value);
        if (h1Text && issueKey === 'h1_missing') return { type, h1Text, h1Count: 1 };
        return { type, h1Text: h1Text || value };
      }
      case 'canonical': {
        // Bug fix: a recommendation whose canonical content was generated
        // as an HTML `<link rel="canonical" href="...">` tag (a prompt
        // wording bug, since fixed in PromptBuilder.js) would otherwise
        // flow straight through as the literal string written to
        // WordPress — Rank Math accepts any string into its canonical
        // meta field without validation, then silently declines to render
        // an invalid `<link>` tag from it, so the write "succeeded" while
        // the public page had no canonical tag at all. Extracting/
        // validating here means BOTH wordPressSeoFixService.js's write
        // path and TaskVerificationService's later comparison (which
        // reads this SAME frozen expectedAfterValue from fixHistory) see
        // only ever a real URL or null — never silently a malformed one.
        const canonicalUrl = extractCanonicalUrlValue(value);
        return canonicalUrl ? { type, canonical: canonicalUrl } : null;
      }
      case 'robots': {
        // Same defense-in-depth shape as canonical above: recommendedVersion
        // for a robots-type issue (noindex_key_pages/noindex_tags) is
        // constrained by PromptBuilder.js/TechnicalValidator.js to be one of
        // exactly 4 allowed directive strings, but this is still the one
        // shared boundary both the WordPress write path
        // (wordPressSeoFixService.js) and TaskVerificationService's later
        // comparison read from — a stale/malformed value here must refuse
        // the write (via resolveDesiredValue's existing null-check) rather
        // than let anything but a well-formed {index, follow} pair through.
        const robots = normalizeRobotsValue(value);
        return robots ? { type, index: robots.index, follow: robots.follow } : null;
      }
      case 'image_alt':        return { type, alt: value };
      case 'same_as': {
        // sameas_array (legacy/recommendation-derived value — NOT what the
        // WordPress apply flow writes any more: profile URLs are entered by the
        // site owner and frozen via expectedAfterValueOverride instead; a
        // recommendation only ever carries a URL if one really existed in its
        // context, and is never asked to invent one).
        // recommendedVersion is ONE URL to ADD to the site's
        // Organization sameAs list — never a full replacement array (see
        // valueNormalization.normalizeSchemaUrlValue's rejection of markup
        // and non-http(s) schemes, and RankMathProvider.php's update_same_as,
        // which only ever appends/removes this one URL from the
        // social_additional_profiles bucket it manages, never touching the
        // Facebook/Twitter-derived entries).
        const url = normalizeSchemaUrlValue(value);
        return url ? { type, url } : null;
      }
      case 'breadcrumb': {
        // breadcrumblist_schema: every current finding means "enabled" is
        // missing — recommendedVersion is the closed-allowlist literal
        // "enabled" (see normalizeBreadcrumbEnableValue), never a boolean
        // string like "true"/"1" that would need its own guessing rules.
        const enabled = normalizeBreadcrumbEnableValue(value);
        return enabled ? { type, enabled: true } : null;
      }
      case 'faq_schema': {
        // faq_schema: recommendedVersion is the FAQPage JSON-LD the
        // recommendation service built from the crawler-detected Q/A pairs
        // (see faqSchemaRecommendation.js). Parsed strictly back into pairs —
        // anything that is not a well-formed FAQPage with a question AND an
        // answer for every entry yields null, which refuses the write via
        // resolveDesiredValue's existing null-check rather than sending a
        // partial or malformed schema to WordPress.
        const pairs = parseFaqPageJsonLd(value);
        return pairs?.length ? { type, pairs } : null;
      }
      case 'aggregate_rating': {
        // aggregate_rating_schema: recommendedVersion is the JSON-LD node the
        // recommendation service built from the page's displayed rating and an
        // existing entity. Parsed strictly back into {target, rating}; anything
        // that isn't a well-formed rating node on an entity with an absolute
        // @id and a name yields null, which refuses the write.
        const parsed = parseAggregateRatingJsonLd(value);
        return parsed ? { type, target: parsed.target, rating: parsed.rating } : null;
      }
      case 'keyboard_accessibility':
        // The recommendation's deterministic afterState lists the exact selectors that must
        // show a visible focus indicator (see keyboardAccessibilityState.js).
        return expectedAfterFromAfterState(rec.sections?.afterState);
      default:                  return null;
    }
  }
}

export default new TaskHistoryService();
