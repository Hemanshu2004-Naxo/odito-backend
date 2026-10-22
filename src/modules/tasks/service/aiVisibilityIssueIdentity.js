/**
 * Shared AI-visibility (V2 hub) issue-identity helpers — used by both
 * TaskHistoryService (before-capture) and TaskVerificationService
 * (after-resolution) so they can't drift apart, matching the existing
 * issueSnapshotTypes.js pattern for the 5 on-page SEO types.
 *
 * Identity contract (Phase 5 investigation, verified against real code —
 * not inferred from field names):
 *   - Task.issueKey === ai_issues.rule_id, byte-identical (e.g. "AISO-001").
 *     Confirmed via aiHubController.js's hub issue-detail endpoints, which
 *     return `rule_id` straight from the Mongo doc with no transformation,
 *     and IssueDetailView.jsx's createTaskMutation, which sends that same
 *     value as issueKey with no reformatting.
 *   - Task.pageUrl === ai_issues.url, byte-identical. Both are normalized
 *     once, at extraction time, by extractor.py's _normalize_url() — the
 *     Node side never re-derives or reformats it.
 *   - (project_id, url, rule_id) is a stable identity across analysis runs
 *     for a page-scoped issue (the only kind that can create a Task today —
 *     domain-scoped issues have no per-URL context to attach a Task to, and
 *     the UI doesn't wire task creation for them). job_id/score_id are
 *     provenance, not identity — score_id is stable per (project_id,url)
 *     via ai_scores' own unique index, and ai_issues is deleted+reinserted
 *     keyed to that stable score_id on every re-analysis of that URL.
 *
 * Field casing note: ai_issues/ai_scores are Python-written and read here
 * as-is — snake_case `project_id`/`url`/`rule_id`, NOT the camelCase
 * `projectId`/`page_url` convention used by the Node-native on-page
 * collections (seo_page_data/seo_page_issues).
 */

const V2_HUB_ISSUE_PREFIX = /^(AISO|AEO|GEO)-/i;

/**
 * True if this issueKey identifies a V2 AI-visibility hub issue (AISO-*,
 * AEO-*, GEO-*) rather than an on-page SEO / accessibility / technical
 * issue. Matches the exact convention already used by
 * IssueContextEngine.js / contextExtractor.js / recommendationService.js's
 * `_isV2HubIssue` — same regex, same real rule_id values.
 */
export function isAiVisibilityIssueKey(issueKey) {
  return typeof issueKey === 'string' && V2_HUB_ISSUE_PREFIX.test(issueKey);
}

export default { isAiVisibilityIssueKey };
