/**
 * Page 11 Service - Crawlability Analysis
 * Handles crawlability data from seo_page_data and seo_page_issues collections
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class Page11Service {
  
  /**
   * Get crawlability analysis for Page 11
   * @param {string} projectId - Project ID
   * @returns {Object} Crawlability analysis
   */
  static async getPage11Data(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Page 11 data generation started', { projectId });
      
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      // Task 1: Get total pages (crawled)
      const totalPages = await this.getTotalPages(db, projectIdObj);
      
      // Task 2: Count indexed pages
      const indexedPages = await this.getIndexedPages(db, projectIdObj);
      
      // Task 3: Calculate blocked pages
      const blockedPages = totalPages - indexedPages;
      
      // Task 4: Calculate index rate
      const indexRate = totalPages > 0 ? Math.round((indexedPages / totalPages) * 100) : 0;
      
      // Task 5: Aggregate blocked reasons from issues
      const blockedReasons = await this.getBlockedReasons(db, projectIdObj);
      
      // Chart data for visual representation
      const chartData = [
        { label: 'Indexed', value: indexedPages, percentage: indexRate },
        { label: 'Blocked', value: blockedPages, percentage: totalPages > 0 ? Math.round((blockedPages / totalPages) * 100) : 0 }
      ];
      
      const page11Data = {
        metrics: {
          totalPages,
          indexedPages,
          blockedPages,
          indexRate
        },
        chartData,
        blockedReasons
      };
      
      const duration = Date.now() - startTime;
      LoggerUtil.info('Page 11 data generated successfully', { 
        projectId, 
        duration,
        totalPages,
        indexedPages,
        blockedPages,
        indexRate
      });
      
      return page11Data;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      LoggerUtil.error('Page 11 data generation failed', error, { projectId, duration });
      throw error;
    }
  }
  
  /**
   * Get total pages crawled for the project
   */
  static async getTotalPages(db, projectIdObj) {
    const result = await db.collection('seo_page_data').aggregate([
      { $match: { projectId: projectIdObj } },
      { $count: "totalPages" }
    ]).toArray();
    
    return result.length > 0 ? result[0].totalPages : 0;
  }
  
  /**
   * Count indexed pages (pages that are not blocked)
   */
  static async getIndexedPages(db, projectIdObj) {
    const result = await db.collection('seo_page_data').aggregate([
      { $match: { projectId: projectIdObj } },
      
      // Check if page is indexed (not noindex, not blocked by robots)
      {
        $addFields: {
          isIndexed: {
            $and: [
              { $ne: [{ $arrayElemAt: ["$meta_tags.robots", 0] }, "noindex"] },
              { $ne: [{ $arrayElemAt: ["$meta_tags.robots", 0] }, "noindex,follow"] },
              { $ne: [{ $arrayElemAt: ["$meta_tags.robots", 0] }, "noindex,nofollow"] }
            ]
          }
        }
      },
      
      { $match: { isIndexed: true } },
      { $count: "indexedPages" }
    ]).toArray();
    
    return result.length > 0 ? result[0].indexedPages : 0;
  }
  
  /**
   * Aggregate blocked reasons from seo_page_issues
   */
  static async getBlockedReasons(db, projectIdObj) {
    const blockedReasons = await db.collection('seo_page_issues').aggregate([
      // Open issues only (resolved issues are not outstanding), one row per distinct
      // dedup_key - the same identity IssueAggregationService uses for dashboard counts.
      { $match: { projectId: projectIdObj, status: 'open' } },
      { $group: {
          _id: '$dedup_key',
          category: { $first: '$category' },
          rule_id: { $first: '$rule_id' },
          message: { $first: '$message' },
          severity: { $first: '$severity' },
          recommendation: { $first: '$recommendation' }
      } },
      
      // Filter for crawlability-related issues
      {
        $match: {
          $or: [
            { category: { $regex: /indexation/i } },
            { category: { $regex: /crawlability/i } },
            { rule_id: { $in: ['noindex', 'robots', 'redirect', 'canonical'] } },
            { message: { $regex: /noindex|robots|redirect|canonical/i } }
          ]
        }
      },
      
      // Group by reason type
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $regexMatch: { input: "$message", regex: /noindex/i } }, then: "Noindex meta tag" },
                { case: { $regexMatch: { input: "$message", regex: /robots/i } }, then: "Robots.txt block" },
                { case: { $regexMatch: { input: "$message", regex: /redirect/i } }, then: "Redirect to blocked page" },
                { case: { $regexMatch: { input: "$message", regex: /canonical/i } }, then: "Canonical mismatch" }
              ],
              default: "Other"
            }
          },
          affected: { $sum: 1 },
          impact: { $first: { $ifNull: ["$severity", "medium"] } },
          fix: { $first: { $ifNull: ["$recommendation", "Review crawlability settings"] } }
        }
      },
      
      // Sort by affected count (descending)
      { $sort: { affected: -1 } },
      
      // Project final structure
      {
        $project: {
          _id: 0,
          reason: "$_id",
          affected: 1,
          impact: { $toLower: "$impact" },
          fix: 1
        }
      }
    ]).toArray();
    
    // If no blocked reasons found, return empty array
    if (blockedReasons.length === 0) {
      return [];
    }
    
    // Map impact levels to standard values
    return blockedReasons.map(reason => ({
      reason: reason.reason,
      affected: reason.affected,
      impact: this.normalizeImpact(reason.impact),
      fix: reason.fix || this.getDefaultFix(reason.reason)
    }));
  }
  
  /**
   * Normalize impact levels to standard values
   */
  static normalizeImpact(impact) {
    const impactMap = {
      'high': 'High',
      'critical': 'Critical', 
      'medium': 'Medium',
      'low': 'Low',
      'info': 'Low'
    };
    
    return impactMap[impact?.toLowerCase()] || 'Medium';
  }
  
  /**
   * Get default fix recommendation based on reason
   */
  static getDefaultFix(reason) {
    const fixes = {
      'Noindex meta tag': 'Remove noindex from revenue pages',
      'Robots.txt block': 'Review robots.txt disallow rules',
      'Redirect to blocked page': 'Fix destination page indexation',
      'Canonical mismatch': 'Correct canonical tag URLs',
      'Other': 'Review crawlability settings'
    };
    
    return fixes[reason] || 'Review crawlability settings';
  }
}
