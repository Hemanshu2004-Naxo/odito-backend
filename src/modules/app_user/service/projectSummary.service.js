import { NotFoundError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

/**
 * Project Summary Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all project summary-related business logic
 * Maintains EXACT same behavior as original controller
 */
export class ProjectSummaryService {
  
  /**
   * Get project summary for dashboard
   * Extracted from getProjectSummary controller function (lines 137-593)
   * Maintains IDENTICAL response format and behavior
   */
  static async getProjectSummary(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Project summary API called', { projectId, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;

    // Get link counts directly from MongoDB collections (external links disabled)
    const internalLinksCount = await db.collection('seo_internal_links').countDocuments({
      projectId: new ObjectId(projectId)
    });

    const externalLinksCount = 0;  // External links disabled

    const socialLinksCount = await db.collection('seo_social_links').countDocuments({
      projectId: new ObjectId(projectId)
    });

    const summaryData = {
      internalLinks: internalLinksCount,
      externalLinks: externalLinksCount,
      socialLinks: socialLinksCount,
      totalUrlsFound: internalLinksCount + externalLinksCount + socialLinksCount,
      pagesScraped: 0 // Phase-1: No page scraping yet
    };

    LoggerUtil.info('Project summary calculated', summaryData);

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: summaryData
    };
  }

  /**
   * Get detailed project statistics
   * Additional utility method for future use
   */
  static async getProjectStatistics(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    // Auth is handled by middleware, project is already validated
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Get comprehensive statistics (external links disabled)
    const [
      internalLinksCount,
      socialLinksCount,
      pagesCount,
      issuesCount
    ] = await Promise.all([
      db.collection('seo_internal_links').countDocuments({ projectId: projectIdObj }),
      db.collection('seo_social_links').countDocuments({ projectId: projectIdObj }),
      db.collection('seo_page_data').countDocuments({ projectId: projectIdObj }),
      db.collection('seo_page_issues').countDocuments({ projectId: projectIdObj, status: { $ne: 'excluded' } })
    ]);
    const externalLinksCount = 0;  // External links disabled

    return {
      success: true,
      data: {
        links: {
          internal: internalLinksCount,
          external: externalLinksCount,
          social: socialLinksCount,
          total: internalLinksCount + externalLinksCount + socialLinksCount
        },
        pages: {
          total: pagesCount,
          withIssues: issuesCount,
          healthy: Math.max(0, pagesCount - issuesCount)
        },
        project: {
          name: project.project_name,
          mainUrl: project.main_url,
          status: project.status,
          createdAt: project.createdAt,
          lastScraped: project.last_scraped
        }
      }
    };
  }

  /**
   * Get project health score
   * Additional utility method for future use
   */
  static async getProjectHealthScore(project) {
    const stats = await this.getProjectStatistics(project);
    
    if (!stats.success) {
      throw new Error('Failed to get project statistics');
    }

    const { pages, links, issues } = stats.data;
    
    // Calculate health score (0-100)
    let healthScore = 100;
    
    // Deduct points for issues
    if (pages.total > 0) {
      const issueRatio = pages.withIssues / pages.total;
      healthScore -= Math.round(issueRatio * 50); // Max 50 points deduction for issues
    }
    
    // Deduct points for no links (indicates poor SEO)
    if (links.total === 0) {
      healthScore -= 20;
    }
    
    // Ensure score doesn't go below 0
    healthScore = Math.max(0, healthScore);

    return {
      success: true,
      data: {
        healthScore,
        grade: healthScore >= 90 ? 'A' : 
               healthScore >= 80 ? 'B' : 
               healthScore >= 70 ? 'C' : 
               healthScore >= 60 ? 'D' : 'F',
        factors: {
          pagesWithIssues: pages.withIssues,
          totalLinks: links.total,
          totalPages: pages.total
        }
      }
    };
  }
}
