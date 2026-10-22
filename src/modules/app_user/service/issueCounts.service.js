/**
 * Issue Counts Service
 * Thin wrapper around the canonical IssueAggregationService for the
 * Overview dashboard's "Total Issues" stat.
 *
 * Scope: ALL categories (including Accessibility) — this is the project's
 * whole-site issue total, deliberately broader than the On-Page Issues tab
 * (which excludes Accessibility, since that has its own dedicated audit
 * surface). Both this and On-Page now share the same canonical counting
 * logic (IssueAggregationService, keyed on `dedup_key`) — they will only
 * ever differ by that intentional category scope, never by accident.
 *
 * `passed` counts issues with status 'resolved'. It previously checked for
 * status 'fixed', a value that has never existed in production data
 * (real statuses are 'open'/'resolved'), so it silently always returned 0 —
 * fixed here rather than perpetuated.
 */

import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { IssueAggregationService } from '../../../services/issueAggregationService.js';
import { ServiceUnavailableError } from '../../../utils/ErrorUtil.js';

export class IssueCountsService {

  /**
   * Get issue counts for a project (Overview scope: all categories, open issues).
   *
   * @param {string} projectId - Project ID
   * @returns {Object} { success, data } on success. Throws ServiceUnavailableError
   *   on aggregation failure — callers MUST surface this as an error state, never
   *   substitute a fake zero-issue result (a DB failure must never render as "0
   *   issues" / "perfect audit").
   */
  static async getIssueCounts(projectId) {
    LoggerUtil.info('Issue Counts API called', { projectId });

    let summary;
    try {
      summary = await IssueAggregationService.getIssueSummary(projectId, {
        excludeCategories: [],
      });
    } catch (error) {
      LoggerUtil.error('Failed to get issue counts — surfacing as error, not a fake zero result', error, { projectId });
      throw new ServiceUnavailableError('Unable to load issue counts right now. Please retry.');
    }

    const counts = {
      totalIssues: summary.totalIssues,
      critical: summary.critical,
      warnings: summary.warnings,
      informational: summary.informational,
      passed: summary.resolved,
    };

    LoggerUtil.info('Issue counts retrieved', { projectId, counts });

    return {
      success: true,
      data: counts,
    };
  }
}
