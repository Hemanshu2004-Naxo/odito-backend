import { NotFoundError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

/**
 * Project Links Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all project links-related business logic
 * Maintains EXACT same behavior as original controller
 */
export class ProjectLinksService {
  
  /**
   * Get project links data
   * Extracted from getProjectLinks controller function (lines 37-1405)
   * Maintains IDENTICAL response format and behavior
   */
  static async getProjectLinks(project, query = {}) {
    const { page = 1, limit = 50, link_type, search } = query;
    const skip = (page - 1) * limit;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    LoggerUtil.info('Links API called', { projectId, page, limit, link_type, search });
    LoggerUtil.debug('Project found', { projectName: project.project_name });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Get links from all three collections (EXACT same logic)
    let allLinks = [];

    // Get internal links
    if (!link_type || link_type === 'internal') {
      const internalQuery = { projectId: projectIdObj };
      
      if (search) {
        internalQuery.$or = [
          { sourceUrl: { $regex: search, $options: 'i' } },
          { url: { $regex: search, $options: 'i' } }
        ];
      }

      const internalLinks = await db.collection('seo_internal_links')
        .find(internalQuery)
        .sort({ discoveredAt: -1 })
        .toArray();

      allLinks.push(...internalLinks.map(link => ({ ...link, linkType: 'internal' })));
    }

    // External links disabled - skip query
    if (!link_type || link_type === 'external') {
      // Return empty results for external links
      // External link analysis disabled to improve data quality and reduce processing time
    }

    // Get social links
    if (!link_type || link_type === 'social') {
      const socialQuery = { projectId: projectIdObj };
      
      if (search) {
        socialQuery.$or = [
          { sourceUrl: { $regex: search, $options: 'i' } },
          { platform: { $regex: search, $options: 'i' } }
        ];
      }

      const socialLinks = await db.collection('seo_social_links')
        .find(socialQuery)
        .sort({ discoveredAt: -1 })
        .toArray();

      allLinks.push(...socialLinks.map(link => ({ ...link, linkType: 'social' })));
    }

    LoggerUtil.debug('Found links for current page', { count: allLinks.length });

    // Get total counts for summary (external links disabled)
    const internalCount = await db.collection('seo_internal_links').countDocuments({ projectId: projectIdObj });
    const externalCount = 0;  // External links disabled
    const socialCount = await db.collection('seo_social_links').countDocuments({ projectId: projectIdObj });

    const summary = {
      internal_links: internalCount,
      external_links: externalCount,
      social_links: socialCount,
      total: internalCount + externalCount + socialCount
    };

    LoggerUtil.debug('Summary counts', summary);

    // Group by platform for social links (EXACT same logic)
    const platformSummary = await db.collection('seo_social_links').aggregate([
      { $match: { projectId: projectIdObj } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    LoggerUtil.debug('Platform summary', { platformSummary });

    // Sort all links by discoveredAt (EXACT same logic)
    allLinks.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt));

    // Apply pagination AFTER combining all links (EXACT same logic)
    const paginatedLinks = allLinks.slice(skip, skip + parseInt(limit));

    // Calculate pagination values (EXACT same logic)
    const totalLinks = allLinks.length;
    const totalPages = Math.ceil(totalLinks / limit);
    const currentPage = parseInt(page);
    const hasNext = currentPage < totalPages;
    const hasPrev = currentPage > 1;

    LoggerUtil.debug('Pagination info', {
      totalLinks,
      currentPage,
      totalPages,
      limit: parseInt(limit),
      skip,
      hasNext,
      hasPrev
    });

    // Format response data (EXACT same logic)
    const formattedLinks = paginatedLinks.map(link => ({
      _id: link._id,
      sourceUrl: link.sourceUrl,
      targetUrl: link.url || link.targetUrl,
      linkType: link.linkType,
      platform: link.platform,
      discoveredAt: link.discoveredAt,
      seo_jobId: link.seo_jobId
    }));

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        links: formattedLinks,
        pagination: {
          currentPage,
          totalPages,
          totalLinks,
          hasNext,
          hasPrev
        },
        summary,
        platformSummary
      }
    };
  }

  /**
   * Get link statistics for project
   * Additional utility method for future use
   */
  static async getLinkStatistics(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    const db = mongoose.connection.db;
    
    // Get link statistics
    const stats = await db.collection('seo_internal_links').aggregate([
      { $match: { project_id: new mongoose.Types.ObjectId(projectId) } },
      {
        $group: {
          _id: null,
          totalLinks: { $sum: 1 },
          internalLinks: {
            $sum: { $cond: [{ $eq: ['$link_type', 'internal'] }, 1, 0] }
          },
          externalLinks: {
            $sum: { $cond: [{ $eq: ['$link_type', 'external'] }, 1, 0] }
          },
          uniqueDomains: { $addToSet: '$target_domain' }
        }
      },
      {
        $project: {
          totalLinks: 1,
          internalLinks: 1,
          externalLinks: 1,
          uniqueDomains: { $size: '$uniqueDomains' }
        }
      }
    ]).toArray();

    return {
      success: true,
      data: stats[0] || {
        totalLinks: 0,
        internalLinks: 0,
        externalLinks: 0,
        uniqueDomains: 0
      }
    };
  }
}
