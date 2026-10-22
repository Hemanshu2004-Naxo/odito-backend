import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * Aggregate accessibility issues for a project.
 *
 * Uses the same two-stage $group logic as On-Page issues (onPageIssuesService.js)
 * to avoid building huge $addToSet arrays when a site has thousands of pages.
 *
 * Stage 1: deduplicate by (issue_code, page_url, data_path)
 * Stage 2: count distinct (issue_code, data_path) groups' pages
 *
 * `data_path` was missing from both stages here until this fix — grouping
 * by (issue_code, page_url) alone silently collapsed a page's multiple
 * distinct accessibility findings under the same issue_code (e.g. two
 * separate missing-alt-text images, tracked at different data_paths) into
 * one counted issue. Verified against production data: this undercounted
 * a real audited project's Accessibility total by 21 issues (134 shown vs.
 * 155 actual distinct `dedup_key` values) — the exact same class of bug
 * fixed project-wide in IssueAggregationService, applied here too since
 * this service still owns its own rule-grouped breakdown for the
 * Accessibility tab (IssueAggregationService's canonical total does not
 * replace this — it only replaces the whole-project summary counts).
 */
export async function getAccessibilityIssues(projectId) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  // 1. Total pages analyzed from seo_page_summary (same as On-Page)
  const totalPages = await db
    .collection('seo_page_summary')
    .countDocuments({ projectId: projectIdObj });

  // 2. Two-stage aggregation for accessibility issues only
  const rawIssues = await db
    .collection('seo_page_issues')
    .aggregate([
      {
        $match: {
          projectId: projectIdObj,
          category: 'Accessibility',
          status: 'open',
        }
      },

      // Stage 1 — deduplicate by (issue_code, page_url, data_path)
      {
        $group: {
          _id: {
            issue_code: '$issue_code',
            page_url: '$page_url',
            data_path: '$data_path',
          },
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
        },
      },

      // Stage 2 — group by (issue_code, data_path), count distinct pages
      {
        $group: {
          _id: {
            issue_code: '$_id.issue_code',
            data_path: '$_id.data_path',
          },
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          pages_affected: { $sum: 1 },
          total_occurrences: { $sum: 1 },
          affected_urls: { $push: '$_id.page_url' },
        },
      },

      // Final projection
      {
        $project: {
          _id: 0,
          issue_code: '$_id.issue_code',
          data_path: '$_id.data_path',
          issue_message: 1,
          severity: 1,
          category: 1,
          pages_affected: 1,
          total_occurrences: 1,
          affected_urls: 1,
        },
      },

      { $sort: { pages_affected: -1 } },
    ])
    .toArray();

  // 3. Derive total from aggregation — sum of pages_affected equals
  // the count of distinct (issue_code, page_url, data_path) triples,
  // i.e. the canonical `dedup_key` count for this project's Accessibility
  // category. Raw countDocuments was higher because per-element rules
  // (alt text, contrast) generate multiple docs per page.
  const totalIssuesFound = rawIssues.reduce((sum, issue) => sum + (issue.pages_affected || 0), 0);

  // 4. Enrich each issue with difficulty and impact
  const issues = rawIssues.map((issue) => {
    // Map severity to difficulty (same logic as On-Page)
    let difficulty;
    switch (issue.severity?.toLowerCase()) {
      case 'high':
      case 'critical':
        difficulty = 'hard';
        break;
      case 'medium':
      case 'warning':
        difficulty = 'medium';
        break;
      case 'low':
      case 'info':
        difficulty = 'easy';
        break;
      default:
        difficulty = 'medium';
    }

    // Calculate impact percentage
    const impact_percentage =
      totalPages > 0
        ? Math.round(((issue.pages_affected / totalPages) * 100) * 10) / 10
        : 0;

    const enrichedIssue = {
      issue_code: issue.issue_code,
      issue_message: issue.issue_message,
      severity: issue.severity,
      category: issue.category,
      pages_affected: issue.pages_affected,
      total_occurrences: issue.total_occurrences,
      impact_percentage,
      difficulty,
    };

    return enrichedIssue;
  });

  return {
    issues,
    summary: {
      total_issue_types: issues.length,
      total_issues_found: totalIssuesFound,
      total_pages_analyzed: totalPages,
    },
  };
}
