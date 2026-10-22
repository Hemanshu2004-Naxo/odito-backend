import IssueContextEngine from '../../issue-context/service/IssueContextEngine.js';
import { buildAccessibilitySections } from '../../recommendations/service/accessibilityRecommendation.js';
import { inferSnapshotType } from './issueSnapshotTypes.js';

/**
 * Element-level context frozen onto a Task when it is created.
 *
 * A task used to keep only its identity (project, issue, page) and a recommendationId. The
 * recommendation carries the affected elements, but recommendations expire (30-day TTL) and
 * can be regenerated, so a task could outlive the only record of WHICH elements it was
 * created for. For keyboard_accessibility the task now keeps its own compact copy:
 *
 *   issueContext = { type, capturedAt, testedAt, technology,
 *                    beforeState: { findings: [{ type, count, elements: [{ selector, tag, accessibleName }] }] },
 *                    afterState:  { expect: { focusIndicatorVisibleOn: [selectors], ... } } }
 *
 * Built from the server's own audit of the page (never from the request body), by the same
 * deterministic code that writes the recommendation, so the two can never disagree.
 * Best-effort: any failure yields null and never blocks creating the task.
 */
export async function captureIssueContext(projectId, issueKey, pageUrl) {
  if (inferSnapshotType(issueKey) !== 'keyboard_accessibility') return null;
  try {
    const context = await IssueContextEngine.resolve(String(projectId), issueKey, pageUrl);
    const audit = context?.accessibilityAudit;
    if (!audit?.available || !audit.findings.some((f) => !f.informational)) return null;
    const { beforeState, afterState } = buildAccessibilitySections(audit);
    return {
      type: 'keyboard_accessibility',
      capturedAt: new Date().toISOString(),
      testedAt: audit.testedAt,
      technology: audit.technology?.label || null,
      beforeState,
      afterState,
    };
  } catch (err) {
    console.warn(`[TASK] Could not capture issue context | issueKey=${issueKey} | pageUrl=${pageUrl}: ${err.message}`);
    return null;
  }
}

export default { captureIssueContext };
