import mongoose from 'mongoose';
import {
  CANONICAL_ISSUE_TITLES,
  AI_CONFIDENCE_FALLBACK,
  resolveIssueDifficulty,
} from '../config/issueMetadata.js';

const { ObjectId } = mongoose.Types;

/**
 * Aggregate on-page issues for a project.
 *
 * Uses a two-stage $group to avoid building huge $addToSet arrays
 * when a site has thousands of pages.
 *
 * Stage 1: deduplicate by (issue_code + page_url)
 * Stage 2: count distinct pages per issue_code
 */
export async function getOnPageIssues(projectId) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  // 1. Total pages analyzed
  const totalPages = await db
    .collection('seo_page_summary')
    .countDocuments({ projectId: projectIdObj });

  // 2. Two-stage aggregation
  const rawIssues = await db
    .collection('seo_page_issues')
    .aggregate([
      {
        $match: {
          projectId: projectIdObj,
          category: { $ne: 'Accessibility' },
          status: 'open'
        }
      },

      // Stage 1 — deduplicate by (issue_code, page_url, data_path).
      // data_path is included because a single rule can emit genuinely
      // different finding types on the same page under the same issue_code
      // (e.g. OrganizationSchemaRule can fire both a "missing required
      // field" AND a "missing recommended field" issue on one page, at
      // different severities) — grouping on data_path too keeps those
      // distinct instead of collapsing to one arbitrarily-picked document.
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
          ai_confidence: { $first: '$ai_confidence' },
        },
      },

      // Stage 2 — group by (issue_code, data_path), count distinct pages.
      // Grouping in data_path too means a rule with multiple finding
      // types/severities (see Stage 1 comment) surfaces as separate rows,
      // each with its own correct severity/title/pages_affected — instead
      // of one row whose severity is an arbitrary $first pick across
      // documents that may not even agree on severity.
      {
        $group: {
          _id: {
            issue_code: '$_id.issue_code',
            data_path: '$_id.data_path',
          },
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          ai_confidence: { $first: '$ai_confidence' },
          pages_affected: { $sum: 1 },
          total_occurrences: { $sum: 1 },
          affected_urls: { $push: '$_id.page_url' },
        },
      },

      // Final projection - return all URLs (no sampling)
      {
        $project: {
          _id: 0,
          issue_code: '$_id.issue_code',
          data_path: '$_id.data_path',
          issue_message: 1,
          severity: 1,
          category: 1,
          ai_confidence: 1,
          pages_affected: 1,
          total_occurrences: 1,
          affected_urls: 1,
        },
      },

      { $sort: { pages_affected: -1 } },
    ])
    .toArray();

  // 3. Derive total from aggregation — consistent with Accessibility service.
  // Raw countDocuments was higher because per-element rules create multiple docs per page.
  const totalIssuesFound = rawIssues.reduce((sum, issue) => sum + (issue.pages_affected || 0), 0);

  // 4. Enrich each issue
  const issues = rawIssues.map((issue) => {
    const difficulty = resolveIssueDifficulty({ issue_code: issue.issue_code, severity: issue.severity });

    const impact_percentage =
      totalPages > 0
        ? Math.round(((issue.pages_affected / totalPages) * 100) * 10) / 10
        : 0;

    const ai_confidence =
      issue.ai_confidence != null
        ? issue.ai_confidence
        : AI_CONFIDENCE_FALLBACK[issue.severity] || AI_CONFIDENCE_FALLBACK.medium;

    const enrichedIssue = {
      issue_code: issue.issue_code,
      data_path: issue.data_path,
      title: resolveIssueTitle(issue.issue_code, issue.data_path, issue.issue_message),
      issue_message: issue.issue_message,
      severity: issue.severity,
      category: issue.category,
      pages_affected: issue.pages_affected,
      total_occurrences: issue.total_occurrences,
      impact_percentage,
      difficulty,
      ai_confidence,
      sample_pages: issue.sample_pages,
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

/**
 * Derive a clean display title from a raw issue_message.
 * Strips the evidence suffix written by per-element rules:
 *   "Image missing alt text: https://..."  →  "Image missing alt text"
 * Capitalises the first letter for consistent casing.
 */
function _deriveTitle(msg) {
  if (!msg || typeof msg !== 'string') return 'Unknown Issue';
  const colonIdx = msg.indexOf(': ');
  const base = colonIdx > 0 ? msg.slice(0, colonIdx) : msg;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Resolve the display title for an issue, honouring CANONICAL_ISSUE_TITLES'
 * two supported shapes (see the JSDoc on that export in issueMetadata.js):
 *   - a plain string             → used as-is for every finding under that
 *                                   issue_code (the common case).
 *   - { default, byDataPath }    → `byDataPath[data_path]` wins when the
 *                                   issue's data_path matches one of that
 *                                   rule's known finding types, otherwise
 *                                   falls back to `default`.
 * Backward compatible with documents that predate a rule's severity/subtype
 * split (missing or unrecognised data_path): they fall through to `default`,
 * i.e. exactly the single title the rule showed before the split existed.
 * Issue codes with no CANONICAL_ISSUE_TITLES entry keep deriving from
 * issue_message as before.
 */
function resolveIssueTitle(issue_code, data_path, issue_message) {
  const entry = CANONICAL_ISSUE_TITLES[issue_code];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return (data_path && entry.byDataPath?.[data_path]) || entry.default || _deriveTitle(issue_message);
  }
  return _deriveTitle(issue_message);
}

/**
 * Get ALL affected URLs for a specific issue code, each carrying its own
 * finding detail rather than a single shared message repeated for every
 * row. Generic across every issue_code (not special-cased for any one
 * rule) — any rule whose finding varies per page benefits automatically.
 *
 * If a page somehow has more than one open document under the same
 * issue_code (a rule emitting two distinct findings on one page, e.g.
 * both a required-field and a recommended-field gap), the most severe one
 * is kept so the URL list never under-represents a page's worst finding.
 */
export async function getIssueUrls(projectId, issueCode) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  const urls = await db
    .collection('seo_page_issues')
    .aggregate([
      { $match: { projectId: projectIdObj, issue_code: issueCode, status: 'open' } },
      {
        // Deterministic severity ranking so $first (below) reliably keeps
        // the most severe finding when a page has more than one document
        // under this issue_code, instead of picking whichever document
        // happened to come first in natural/index order.
        $addFields: {
          _severityRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$severity', 'high'] }, then: 3 },
                { case: { $eq: ['$severity', 'medium'] }, then: 2 },
                { case: { $eq: ['$severity', 'low'] }, then: 1 },
              ],
              default: 0,
            },
          },
        },
      },
      { $sort: { page_url: 1, _severityRank: -1 } },
      {
        $group: {
          _id: '$page_url',
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          detected_value: { $first: '$detected_value' },
          data_path: { $first: '$data_path' },
          created_at: { $first: '$created_at' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          url: '$_id',
          issue_message: 1,
          severity: 1,
          detected_value: 1,
          data_path: 1,
        },
      },
    ])
    .toArray();

  return urls;
}
