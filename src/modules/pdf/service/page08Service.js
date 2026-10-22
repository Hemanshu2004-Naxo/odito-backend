/**
 * Page 08 Service - On-Page SEO Audit
 * Handles aggregated issue data from seo_page_issues collection
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class Page08Service {
  
  /**
   * Get aggregated on-page SEO issues data for Page 08
   * @param {string} projectId - Project ID
   * @returns {Object} Aggregated page data structure
   */
  static async getPage08Data(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Page 08 data generation started', { projectId });
      
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      // Task 1: Total Issues and Pages
      const [totalIssues, totalPages] = await Promise.all([
        // Total Issues: count all documents for projectId
        db.collection('seo_page_issues').countDocuments({ projectId: projectIdObj, status: { $ne: 'excluded' } }),
        
        // Total Pages: distinct page_url count
        db.collection('seo_page_issues').distinct('page_url', { projectId: projectIdObj, status: { $ne: 'excluded' } })
          .then(urls => urls.length)
      ]);
      
      // Task 2: Severity Breakdown
      const severityBreakdown = await this.getSeverityBreakdown(db, projectIdObj);
      
      // Task 3-5: Group Issues by Type and Select Top Issues
      const topIssues = await this.getTopIssues(db, projectIdObj);
      
      // Task 6: Final Output Structure
      const page08Data = {
        totalIssues,
        totalPages,
        severityBreakdown,
        topIssues
      };
      
      const totalTime = Date.now() - startTime;
      
      LoggerUtil.info('Page 08 data generation completed', {
        projectId,
        totalTime,
        totalIssues,
        totalPages,
        topIssuesCount: topIssues.length
      });
      
      return {
        success: true,
        data: page08Data,
        metadata: {
          generatedAt: new Date(),
          generationTime: totalTime,
          projectId
        }
      };
      
    } catch (error) {
      LoggerUtil.error('Page 08 data generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PAGE08_GENERATION_FAILED',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }
  
  /**
   * Task 2: Get severity breakdown using aggregation
   */
  static async getSeverityBreakdown(db, projectIdObj) {
    try {
      const pipeline = [
        { $match: { projectId: projectIdObj, status: { $ne: 'excluded' } } },
        {
          $group: {
            _id: null,
            critical: {
              $sum: {
                $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0]
              }
            },
            high: {
              $sum: {
                $cond: [{ $eq: ['$severity', 'high'] }, 1, 0]
              }
            },
            medium: {
              $sum: {
                $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0]
              }
            },
            low: {
              $sum: {
                $cond: [{ $eq: ['$severity', 'low'] }, 1, 0]
              }
            },
            info: {
              $sum: {
                $cond: [{ $eq: ['$severity', 'info'] }, 1, 0]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            critical: 1,
            high: 1,
            medium: 1,
            low: 1,
            info: 1
          }
        }
      ];
      
      const result = await db.collection('seo_page_issues').aggregate(pipeline).toArray();
      
      const breakdown = result[0] || {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0
      };
      
      // Combine low + info for frontend display
      breakdown.lowInfo = breakdown.low + breakdown.info;
      
      // Add total issues for "All Issues" display
      breakdown.totalAll = breakdown.critical + breakdown.high + breakdown.medium + breakdown.low + breakdown.info;
      
      LoggerUtil.debug('Severity breakdown calculated', breakdown);
      return breakdown;
      
    } catch (error) {
      LoggerUtil.error('Failed to get severity breakdown', error);
      // Propagate: unavailable data must not be reported as zero/empty.
      throw error;
    }
  }
  
  /**
   * Task 3-5: Group issues by type and select top issues using aggregation
   */
  static async getTopIssues(db, projectIdObj) {
    try {
      console.log("PAGE08: Fetching top issues for projectId:", projectIdObj);
      
      const pipeline = [
        // Step 1: Match by projectId
        { $match: { projectId: projectIdObj, status: { $ne: 'excluded' } } },
        
        // Step 2: Group by issue_code/rule_id
        {
          $group: {
            _id: '$issue_code',
            issue_message: { $first: '$issue_message' },
            severity: { $first: '$severity' },
            category: { $first: '$category' },
            recommendation: { $first: '$recommendation' },
            count: { $sum: 1 },
            affectedPages: { $addToSet: '$page_url' }
          }
        },
        
        // Step 3: Add pages count and severity priority
        {
          $addFields: {
            pages: { $size: '$affectedPages' },
            severityPriority: {
              $switch: {
                branches: [
                  { case: { $eq: ['$severity', 'critical'] }, then: 1 },
                  { case: { $eq: ['$severity', 'high'] }, then: 2 },
                  { case: { $eq: ['$severity', 'medium'] }, then: 3 },
                  { case: { $eq: ['$severity', 'low'] }, then: 4 },
                  { case: { $eq: ['$severity', 'info'] }, then: 5 }
                ],
                default: 6
              }
            }
          }
        },
        
        // Step 4: Sort by severity priority, then by count (descending)
        { $sort: { severityPriority: 1, count: -1 } },
        
        // Step 5: Facet to split by severity and limit
        {
          $facet: {
            criticalHigh: [
              { $match: { severity: { $in: ['critical', 'high'] } } },
              { $limit: 5 }
            ],
            medium: [
              { $match: { severity: 'medium' } },
              { $limit: 3 }
            ],
            lowInfo: [
              { $match: { severity: { $in: ['low', 'info'] } } },
              { $limit: 2 }
            ]
          }
        },
        
        // Step 6: Concatenate all arrays
        {
          $addFields: {
            allIssues: {
              $concatArrays: [
                '$criticalHigh',
                '$medium',
                '$lowInfo'
              ]
            }
          }
        },
        
        // Step 7: Project final structure
        {
          $project: {
            _id: 0,
            topIssues: '$allIssues'
          }
        }
      ];
      
      const result = await db.collection('seo_page_issues').aggregate(pipeline).toArray();
      const rawIssues = result[0]?.topIssues || [];
      
      console.log("PAGE08: Found raw issues:", rawIssues.length);
      
      // Step 8: Transform to final output structure
      const topIssues = rawIssues.map((issue, index) => ({
        issue: issue.issue_message || this.formatIssueName(issue._id),
        severity: issue.severity,
        pages: issue.pages,
        count: issue.count,
        recommendation: issue.recommendation || this.generateRecommendation(issue._id, issue.severity)
      }));
      
      console.log("PAGE08: Final top issues:", topIssues.length);
      LoggerUtil.debug('Top issues selected', { count: topIssues.length });
      
      return topIssues;
      
    } catch (error) {
      LoggerUtil.error('Failed to get top issues', error);
      // Propagate: unavailable data must not be reported as zero/empty.
      throw error;
    }
  }
  
  /**
   * Format issue name from issue_code
   */
  static formatIssueName(issueCode) {
    if (!issueCode) return 'Unknown Issue';
    return issueCode
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }
  
  /**
   * Generate recommendation based on issue code and severity
   */
  static generateRecommendation(issueCode, severity) {
    const recommendations = {
      'meta_description_missing': 'Write unique meta descriptions (150-160 characters) for each page',
      'h1_missing': 'Add one H1 tag per page with your primary target keyword',
      'title_missing': 'Create unique, descriptive title tags (50-60 characters)',
      'schema_markup_missing': 'Add JSON-LD structured data schema for each page type',
      'img_alt_missing': 'Add descriptive ALT text to all images for accessibility',
      'broken_internal_links': 'Fix broken internal links or implement 301 redirects',
      'duplicate_title_tags': 'Ensure each page has a unique title tag',
      'title_too_long': 'Shorten title tags to 50-60 characters for optimal display',
      'meta_description_too_long': 'Trim meta descriptions to 150-160 characters',
      'thin_content': 'Expand thin content pages to 600+ words with valuable information',
      'missing_h1': 'Add a single H1 heading to each page',
      'multiple_h1': 'Use only one H1 tag per page, use H2-H6 for subheadings',
      'missing_meta_description': 'Add compelling meta descriptions to improve CTR',
      'og_tags_missing': 'Add Open Graph tags for better social media sharing',
      'canonical_missing': 'Add canonical tags to prevent duplicate content issues',
      'noindex_set': 'Review noindex directives - ensure only pages meant to be hidden are marked',
      'robots_txt_missing': 'Create or optimize robots.txt file for proper crawling',
      'sitemap_missing': 'Generate and submit XML sitemap to search engines'
    };
    
    // Fallback recommendation based on severity
    const fallbackRecommendations = {
      critical: 'Fix immediately - this issue significantly impacts SEO performance',
      high: 'Address within 7 days - high priority for SEO improvement',
      medium: 'Plan to fix within 30 days - moderate SEO impact',
      low: 'Consider fixing when time permits - minor SEO improvement opportunity'
    };
    
    return recommendations[issueCode] || fallbackRecommendations[severity] || 'Review and optimize this SEO element';
  }
}
