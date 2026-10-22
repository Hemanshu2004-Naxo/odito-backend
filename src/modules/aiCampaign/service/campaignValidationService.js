/**
 * campaignValidationService — Phase 5: the single authoritative pre-publish
 * readiness gate (spec §1-§3, §49 validation order).
 *
 *   1. draft existence          (campaignDraftService.getDraft — 404 if missing/deleted)
 *   2. authorization             (done by the controller, upstream — spec §38)
 *   3. draft is in an editable/validatable state (reuses Phase 4's EDITABLE_DRAFT_STATUSES)
 *   4. Phase 1 structural validation (strict — requireAdGroups/strictRsa/requireLocation/runPolicy)
 *   5. deterministic campaign rules (content completeness, budget, duplicates, business consistency)
 *   6. Google Ads account readiness (DB-only — no network call, spec §11/§12)
 *   7. aggregate -> persist (upsert by draftVersion)
 *
 * MODULAR BY DESIGN (spec §47): every rule above is an independently
 * importable, independently testable pure (or, for account readiness,
 * async-but-DB-only) function in service/validation/. This orchestrator's
 * only job is to run them in order and aggregate the result — it contains
 * no validation logic of its own.
 *
 * Deliberately does NOT touch `AiCampaignDraft.status` (Phase 1's
 * draft/generating/ready/validated/... lifecycle). A manually-created draft
 * never reaches `ready` under Phase 1's existing transition table, so
 * flipping status here would only work for AI-generated drafts and leave
 * manual ones permanently stuck — an inconsistency not worth adding a new
 * status transition to fix. The persisted `AiCampaignValidationResult`
 * (keyed by `draftVersion`, with `isCurrent`) is the complete, sufficient
 * readiness signal; callers must read it instead of `draft.status`.
 *
 * NEVER mutates Google Ads (spec §12) — nothing in this file or its
 * collaborators imports a Google Ads *mutation* function; the only Google
 * Ads-related read is a MongoDB read of the project's own
 * GoogleConnection document (see validation/accountReadinessRules.js).
 */

import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ValidationError } from '../../../utils/ErrorUtil.js';
import AiCampaignValidationResult from '../model/AiCampaignValidationResult.js';
import campaignDraftService from './campaignDraftService.js';
import { EDITABLE_DRAFT_STATUSES } from '../constants/editableStatuses.js';
import { VALIDATION_VERSION, CATEGORY_DISPLAY_ORDER } from '../constants/validationEnums.js';

import { runStructureRule } from './validation/structureRules.js';
import { runContentRule } from './validation/contentRules.js';
import { runBudgetRule } from './validation/budgetRules.js';
import { runDuplicateRule } from './validation/duplicateRules.js';
import { runBusinessConsistencyRule } from './validation/businessConsistencyRules.js';
import { runAccountReadinessRule } from './validation/accountReadinessRules.js';

/** Roll every issue up into a { errorCount, warningCount, infoCount, passedCount } summary. */
function summarize(issues) {
  const summary = { errorCount: 0, warningCount: 0, infoCount: 0, passedCount: 0 };
  for (const issue of issues) {
    if (issue.severity === 'error') summary.errorCount += 1;
    else if (issue.severity === 'warning') summary.warningCount += 1;
    else summary.infoCount += 1;
  }
  // "Passed checks" = categories with zero errors AND zero warnings — pure
  // green checkmarks, computed below alongside `checks[]` and folded in.
  return summary;
}

/** One row per known category, in display order — always present, even with zero findings. */
function buildChecks(issues) {
  const byCategory = new Map(CATEGORY_DISPLAY_ORDER.map((c) => [c, { category: c, passed: true, errorCount: 0, warningCount: 0 }]));
  for (const issue of issues) {
    const row = byCategory.get(issue.category);
    if (!row) continue; // defensive — every issue's category is validated by makeIssue()
    if (issue.severity === 'error') { row.errorCount += 1; row.passed = false; }
    else if (issue.severity === 'warning') row.warningCount += 1;
  }
  return Array.from(byCategory.values());
}

/**
 * Run pre-publish validation for a draft and persist the result.
 *
 * @param {object} args
 * @param {string} args.draftId
 * @param {string} args.userId
 * @param {string} args.projectId
 * @param {object} [args.project] - the authorized SeoProject, for the (optional, minimal) business-consistency check
 * @returns {Promise<object>} the persisted validation result (plain object) + `isCurrent: true`
 */
export async function validateCampaignForPublishing({ draftId, userId, projectId, project = null }) {
  const startedAt = Date.now();
  const draft = await campaignDraftService.getDraft(draftId);

  if (!EDITABLE_DRAFT_STATUSES.includes(draft.status)) {
    throw new ValidationError(`A campaign in status "${draft.status}" cannot be validated right now.`);
  }

  const draftPlain = draft.toObject();

  const structureResult = runStructureRule(draftPlain);
  const issues = [
    ...structureResult.issues,
    ...runContentRule(draftPlain),
    ...runBudgetRule(draftPlain),
    ...runDuplicateRule(draftPlain),
    ...runBusinessConsistencyRule(draftPlain, project),
    ...(await runAccountReadinessRule(draftPlain, { userId, projectId })),
  ];

  const summary = summarize(issues);
  const checks = buildChecks(issues);
  summary.passedCount = checks.filter((c) => c.passed && c.errorCount === 0 && c.warningCount === 0).length;
  const status = summary.errorCount === 0 ? 'ready' : 'blocked';
  const durationMs = Date.now() - startedAt;

  const persisted = await AiCampaignValidationResult.findOneAndUpdate(
    { projectId, draftId, draftVersion: draft.version },
    {
      $set: {
        createdBy: userId,
        status,
        summary,
        issues,
        checks,
        validationVersion: VALIDATION_VERSION,
        validatedAt: new Date(),
        durationMs,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );

  LoggerUtil.info('AI campaign validation completed', {
    draftId: draft._id.toString(),
    projectId: String(projectId),
    draftVersion: draft.version,
    status,
    errorCount: summary.errorCount,
    warningCount: summary.warningCount,
    durationMs,
  });

  const result = persisted.toObject ? persisted.toObject() : persisted;
  return { ...result, isCurrent: true };
}

/**
 * Fetch the most recently computed validation result for a draft, WITHOUT
 * re-running validation. `isCurrent` tells the caller whether it still
 * reflects the draft's live version (spec §24/§25 — never presented as
 * current after the draft changed).
 *
 * @returns {Promise<object|null>} null when this draft has never been validated
 */
export async function getLatestValidationResult({ draftId, projectId }) {
  const draft = await campaignDraftService.getDraft(draftId);
  const latest = await AiCampaignValidationResult
    .findOne({ projectId, draftId })
    .sort({ draftVersion: -1 })
    .lean();

  if (!latest) return null;
  return { ...latest, isCurrent: latest.draftVersion === draft.version };
}

export default { validateCampaignForPublishing, getLatestValidationResult };
