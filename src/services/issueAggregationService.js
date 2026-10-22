import mongoose from 'mongoose';

/**
 * Issue Aggregation Service — the ONE canonical source of truth for
 * "how many issues does this project have."
 *
 * Root cause this replaces: three (really four, counting
 * accessibilityIssuesService.js) independent Node-side re-derivations of
 * "distinct issue" over the same `seo_page_issues` collection, each using a
 * different ad-hoc $group key (some including data_path, some not; some
 * filtering status, some not), which produced genuinely different totals
 * for the same project (e.g. 1259 vs 1393 vs 1548 on a real audited
 * project) even though nothing about the underlying data was wrong.
 *
 * Canonical issue identity: `dedup_key`. This field is written once per
 * finding by the crawl/rule pipeline and is already unique per
 * (project, page, issue_code, data_path) — verified empirically against
 * production data (5762/5762 documents carry it, zero duplicate
 * (projectId, dedup_key) pairs exist across the whole collection). Node
 * services must count DISTINCT `dedup_key` values, never re-derive their
 * own grouping — that re-derivation is exactly how the four implementations
 * drifted apart.
 *
 * Canonical status semantics: only `'open'` counts as an outstanding issue.
 * Production data uses `'open'` / `'resolved'` — NOT `'fixed'`, which one of
 * the four legacy implementations checked for (a silent no-op bug: that
 * condition never matched anything in production, so its "passed" count was
 * always 0).
 *
 * Category scope is a real, product-intentional axis (Accessibility has its
 * own dedicated audit surface and is deliberately excluded from "On-Page SEO
 * Issues"), so it's a parameter here — not something this service decides on
 * its callers' behalf. Callers must label their result according to the
 * scope they pass in (see each consumer's own comments).
 */

const OPEN_STATUS = 'open';
const RESOLVED_STATUS = 'resolved';

export class IssueAggregationService {
  /**
   * Canonical distinct-issue aggregation, grouped first by dedup_key
   * (defensive — collapses any future pipeline regression that might
   * accidentally emit a duplicate document under the same dedup_key)
   * and carrying forward the fields every consumer below needs.
   *
   * @param {string} projectId
   * @param {object} [opts]
   * @param {string[]} [opts.excludeCategories] - categories to exclude entirely (e.g. ['Accessibility'])
   * @param {string|null} [opts.onlyCategory] - if set, restrict to this single category
   * @param {string[]} [opts.statuses] - statuses to include; defaults to open-only
   */
  static async _canonicalRows(projectId, { excludeCategories = [], onlyCategory = null, statuses = [OPEN_STATUS] } = {}) {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    const match = { projectId: projectIdObj };
    if (statuses.length > 0) match.status = { $in: statuses };
    if (onlyCategory) match.category = onlyCategory;
    else if (excludeCategories.length > 0) match.category = { $nin: excludeCategories };

    return db.collection('seo_page_issues').aggregate([
      { $match: match },
      {
        // Defensive dedup on the canonical identity — see module docblock.
        $group: {
          _id: '$dedup_key',
          issue_code: { $first: '$issue_code' },
          page_url: { $first: '$page_url' },
          data_path: { $first: '$data_path' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          status: { $first: '$status' },
        },
      },
    ]).toArray();
  }

  /**
   * Canonical project-wide issue summary: total / severity buckets / resolved count.
   * This is the number "Overview" and "Issues-by-Page" must both read — pass the
   * same `excludeCategories`/`onlyCategory` scope to both call sites so they stay
   * mathematically identical rather than independently re-approximating each other.
   *
   * @returns {{ totalIssues:number, critical:number, warnings:number, informational:number, resolved:number, scope:object }}
   */
  static async getIssueSummary(projectId, { excludeCategories = [], onlyCategory = null } = {}) {
    const openRows = await this._canonicalRows(projectId, { excludeCategories, onlyCategory, statuses: [OPEN_STATUS] });

    let critical = 0, warnings = 0, informational = 0;
    for (const row of openRows) {
      const sev = (row.severity || '').toLowerCase();
      if (sev === 'high' || sev === 'critical') critical += 1;
      else if (sev === 'medium' || sev === 'warning') warnings += 1;
      else if (sev === 'low' || sev === 'info') informational += 1;
    }

    const resolvedRows = await this._canonicalRows(projectId, { excludeCategories, onlyCategory, statuses: [RESOLVED_STATUS] });

    return {
      totalIssues: openRows.length,
      critical,
      warnings,
      informational,
      resolved: resolvedRows.length,
      scope: {
        excludeCategories,
        onlyCategory,
        status: 'open (resolved issues are not counted in totalIssues)',
      },
    };
  }

  /**
   * Canonical severity counts alone (subset of getIssueSummary, exposed
   * separately for callers that only need this).
   */
  static async getSeverityCounts(projectId, opts = {}) {
    const summary = await this.getIssueSummary(projectId, opts);
    return { critical: summary.critical, warnings: summary.warnings, informational: summary.informational };
  }

  /**
   * Canonical per-category counts (open issues only), across every category
   * present for the project — useful for a "issues by category" breakdown
   * without hardcoding the category list.
   */
  static async getCategoryCounts(projectId) {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    const rows = await db.collection('seo_page_issues').aggregate([
      { $match: { projectId: projectIdObj, status: OPEN_STATUS } },
      { $group: { _id: '$dedup_key', category: { $first: '$category' } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $project: { _id: 0, category: '$_id', count: 1 } },
      { $sort: { count: -1 } },
    ]).toArray();

    return rows;
  }

  /**
   * Canonical open issues grouped by page — the shared implementation
   * behind "Issues by Page". Same identity/status/category rules as
   * getIssueSummary, so its total (sum of per-page issueCount) is
   * guaranteed to equal getIssueSummary's totalIssues for the same scope.
   */
  static async getIssuesByPage(projectId, { excludeCategories = [], onlyCategory = null } = {}) {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    const match = { projectId: projectIdObj, status: OPEN_STATUS };
    if (onlyCategory) match.category = onlyCategory;
    else if (excludeCategories.length > 0) match.category = { $nin: excludeCategories };

    const pages = await db.collection('seo_page_issues').aggregate([
      { $match: match },
      // Defensive dedup on canonical identity before grouping by page.
      {
        $group: {
          _id: '$dedup_key',
          page_url: { $first: '$page_url' },
          issue_message: { $first: '$issue_message' },
          rule_id: { $first: '$rule_id' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          issue_code: { $first: '$issue_code' },
          detected_value: { $first: '$detected_value' },
          expected_value: { $first: '$expected_value' },
          created_at: { $first: '$created_at' },
        },
      },
      {
        $group: {
          _id: '$page_url',
          issueCount: { $sum: 1 },
          issues: {
            $push: {
              id: '$_id',
              issue_message: '$issue_message',
              rule_id: '$rule_id',
              severity: '$severity',
              category: '$category',
              issue_code: '$issue_code',
              detected_value: '$detected_value',
              expected_value: '$expected_value',
              created_at: '$created_at',
            },
          },
        },
      },
      { $project: { page_url: '$_id', issueCount: 1, issues: 1, _id: 0 } },
      { $sort: { issueCount: -1, page_url: 1 } },
    ]).toArray();

    const totalIssues = pages.reduce((sum, page) => sum + page.issueCount, 0);

    return {
      pages,
      summary: {
        totalPages: pages.length,
        totalIssues,
      },
    };
  }

  /**
   * Convenience: just the open-issue total for a scope, when a caller
   * needs nothing else (e.g. a lightweight stat tile).
   */
  static async getCanonicalIssueCount(projectId, opts = {}) {
    const summary = await this.getIssueSummary(projectId, opts);
    return summary.totalIssues;
  }

  /** Alias kept for readability at call sites that only care about "open issues". */
  static async getOpenIssues(projectId, opts = {}) {
    return this._canonicalRows(projectId, { ...opts, statuses: [OPEN_STATUS] });
  }
}

export default IssueAggregationService;
