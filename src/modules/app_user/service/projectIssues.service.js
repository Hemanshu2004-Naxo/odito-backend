import { NotFoundError, AccessDeniedError, ValidationError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';
import { IssueAggregationService } from '../../../services/issueAggregationService.js';

/**
 * Project Issues Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 *
 * Handles all project issues-related business logic
 */
export class ProjectIssuesService {

  /**
   * Get project issues grouped by page URL.
   *
   * Scope: ALL categories, OPEN issues only — same canonical scope as
   * IssueCountsService's Overview total, via the shared
   * IssueAggregationService. Previously this queried every document with
   * no status filter and no dedup at all, so it silently included
   * already-`resolved` issues and could disagree with every other issue
   * total in the app. Its `summary.totalIssues` is now guaranteed to equal
   * IssueCountsService's `totalIssues` for the same project, since both
   * derive from the same canonical aggregation.
   */
  static async getProjectIssuesByPage(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    LoggerUtil.info('Issues by Page API called', { projectId, userId });

    const result = await IssueAggregationService.getIssuesByPage(projectId, {
      excludeCategories: [],
    });

    LoggerUtil.debug('Found pages with issues', { count: result.pages.length });

    return {
      success: true,
      data: result,
    };
  }

  /**
   * Get issues for a specific page URL
   * Extracted from getPageIssues controller function
   */
  static async getPageIssues(project, pageUrl) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Page Issues API called', { projectId, page_url: pageUrl, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);
    const decodedPageUrl = decodeURIComponent(pageUrl);

    if (!pageUrl) {
      throw new ValidationError('page_url parameter is required');
    }

    // Run all three queries in parallel — eliminates sequential round-trip latency
    const [pageScore, pageData, pageIssues] = await Promise.all([
      db.collection('seo_page_scores').findOne(
        { projectId: projectIdObj, page_url: decodedPageUrl }
      ),
      // Projection excludes raw_html — only fields used in the response below
      db.collection('seo_page_data').findOne(
        { projectId: projectIdObj, url: decodedPageUrl },
        { projection: { title: 1, meta_tags: 1, http_status_code: 1, content: 1, _id: 0 } }
      ),
      db.collection('seo_page_issues')
        .find({ projectId: projectIdObj, page_url: decodedPageUrl, status: { $ne: 'excluded' } })
        .sort({ severity: -1, created_at: -1 })
        .toArray()
    ]);

    const pageScreenshot = null; // Screenshots disabled for performance

    const pageScoreValue = pageScore ? pageScore.page_score : 0;
    LoggerUtil.debug('Page score found', { page_url: decodedPageUrl, score: pageScoreValue });

    LoggerUtil.debug('Found page issues', { 
      page_url: decodedPageUrl, 
      issues_count: pageIssues.length,
      page_data_found: !!pageData,
      screenshot_found: !!pageScreenshot 
    });

    // Format issues for response
    const formattedIssues = pageIssues.map(issue => ({
      id: issue._id.toString(),
      issue_message: issue.issue_message,
      rule_id: issue.rule_id,
      severity: issue.severity,
      category: issue.category,
      issue_code: issue.issue_code,
      detected_value: issue.detected_value,
      expected_value: issue.expected_value,
      created_at: issue.created_at
    }));

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        page_url: decodedPageUrl,
        page_score: pageScoreValue,
        screenshot: pageScreenshot ? {
          url: pageScreenshot.screenshotUrl,
          timestamp: pageScreenshot.timestamp
        } : null,
        page_data: pageData ? {
          title: pageData.title,
          meta_description: pageData.meta_tags?.description?.[0] || null,
          http_status_code: pageData.http_status_code,
          word_count: pageData.content?.word_count,
          headings: pageData.content?.headings,
          meta_tags: pageData.meta_tags
        } : null,
        issues: formattedIssues,
        summary: {
          totalIssues: formattedIssues.length,
          criticalCount: formattedIssues.filter(i => i.severity === 'critical').length,
          warningCount: formattedIssues.filter(i => i.severity === 'warning').length,
          infoCount: formattedIssues.filter(i => i.severity === 'info').length
        }
      }
    };
  }

  /**
   * Get all project issues
   * Extracted from getProjectIssues controller function
   */
  static async getProjectIssues(project, options = {}) {
    const { category, severity, page_url, limit = 100, skip = 0 } = options;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Project Issues API called', { projectId, userId, category, severity });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Build query
    const query = { projectId: projectIdObj, status: { $ne: 'excluded' } };
    if (category) query.category = category;
    if (severity) query.severity = severity;
    if (page_url) query.page_url = decodeURIComponent(page_url);

    // Get total count of unique issue codes
    const totalUniqueIssues = await db.collection('seo_page_issues').aggregate([
      { $match: query },
      { $group: { _id: '$issue_code' } },
      { $count: 'total' }
    ]).toArray();

    const totalCount = totalUniqueIssues.length > 0 ? totalUniqueIssues[0].total : 0;

    // Aggregate issues by issue_code and count unique pages affected
    const aggregatedIssues = await db.collection('seo_page_issues').aggregate([
      { $match: query },
      {
        $group: {
          _id: '$issue_code',
          issue_message: { $first: '$issue_message' },
          rule_id: { $first: '$rule_id' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          detected_value: { $first: '$detected_value' },
          expected_value: { $first: '$expected_value' },
          pages_affected: { $addToSet: '$page_url' },
          created_at: { $first: '$created_at' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          issue_code: '$_id',
          issue_message: '$issue_message',
          rule_id: '$rule_id',
          severity: '$severity',
          category: '$category',
          detected_value: '$detected_value',
          expected_value: '$expected_value',
          pages_affected: { $size: '$pages_affected' },
          impact_percentage: { $multiply: [{ $divide: [{ $size: '$pages_affected' }, totalCount] }, 100] },
          difficulty: { $ifNull: ['$difficulty', 'medium'] },
          created_at: '$created_at'
        }
      },
      { $sort: { severity: -1, pages_affected: -1 } },
      { $skip: parseInt(skip) },
      { $limit: parseInt(limit) }
    ]).toArray();

    // Format issues for frontend
    const formattedIssues = aggregatedIssues.map(issue => ({
      ...issue,
      impact_percentage: Math.round(issue.impact_percentage * 10) / 10 // Round to 1 decimal place
    }));

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        issues: formattedIssues,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: totalCount > (parseInt(skip) + parseInt(limit))
        },
        summary: {
          totalIssues: totalCount,
          criticalCount: formattedIssues.filter(i => i.severity === 'critical').length,
          warningCount: formattedIssues.filter(i => i.severity === 'warning').length,
          infoCount: formattedIssues.filter(i => i.severity === 'info').length
        }
      }
    };
  }

  /**
   * Get issue summary by category
   * Additional utility method for future use
   */
  static async getIssuesByCategory(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Aggregate issues by category
    const categoryStats = await db.collection('seo_page_issues').aggregate([
      { $match: { projectId: projectIdObj, status: { $ne: 'excluded' } } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
          warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
          info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    return {
      success: true,
      data: categoryStats.map(stat => ({
        category: stat._id || 'uncategorized',
        count: stat.count,
        severityBreakdown: {
          critical: stat.critical,
          warning: stat.warning,
          info: stat.info
        }
      }))
    };
  }
}
