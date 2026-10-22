import { NotFoundError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

/**
 * Project Pages Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all project pages-related business logic
 * Maintains EXACT same behavior as original controller
 */
export class ProjectPagesService {
  
  /**
   * Get project pages data
   * Extracted from getProjectPages controller function (lines 58-1738)
   * Maintains IDENTICAL response format and behavior
   */
  static async getProjectPages(project, query = {}) {
    const { page = 1, limit = 50, status, search, sortBy, sortOrder, filter } = query;
    const skip = (page - 1) * limit;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    LoggerUtil.info('Project Pages API called', { projectId, page, limit, status, search, sortBy, sortOrder, filter });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Build query for seo_page_data collection (EXACT same logic)
    const queryObj = { projectId: projectIdObj };

    // Add search filter
    if (search) {
      queryObj.$or = [
        { url: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } }
      ];
    }

    // Add status filter
    if (status) {
      queryObj.scrape_status = status;
    }

    // Add indexability filter
    if (filter === 'indexable') {
      queryObj['meta_tags.robots'] = { $not: /noindex/ };
    } else if (filter === 'not-indexable') {
      queryObj['meta_tags.robots'] = /noindex/;
    }

    LoggerUtil.debug('Pages query', queryObj);
    LoggerUtil.debug('Project ID', { projectId: projectIdObj });

    // Get pages from seo_page_data collection
    const pagesCollection = db.collection('seo_page_data');

    // Test: Get all pages for this project without filters first
    const allPages = await pagesCollection.find({ projectId: projectIdObj }).toArray();
    LoggerUtil.debug('All pages count (no filters)', { count: allPages.length });

    // Get total count
    const totalPagesCount = await pagesCollection.countDocuments(queryObj);
    LoggerUtil.debug('Filtered pages count', { count: totalPagesCount });

    // Build sort query (EXACT same logic)
    const sortQuery = {};
    if (sortBy) {
      const sortField = sortBy === 'page_score' ? 'http_status_code' : sortBy;
      sortQuery[sortField] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sortQuery.scraped_at = -1; // Default sort by most recent
    }

    // Get paginated pages
    const pages = await pagesCollection
      .find(queryObj)
      .sort(sortQuery)
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    LoggerUtil.debug('Found pages', { total: totalPagesCount, page: pages.length });

    // Get issues count for each page (EXACT same logic)
    const pageUrls = pages.map(p => p.url);
    const issuesByPage = await db.collection('seo_page_issues').aggregate([
      { $match: { projectId: projectIdObj, page_url: { $in: pageUrls }, status: { $ne: 'excluded' } } },
      {
        $group: {
          _id: '$page_url',
          issueCount: { $sum: 1 }
        }
      }
    ]).toArray();

    // Create issues count lookup
    const issuesLookup = {};
    issuesByPage.forEach(item => {
      issuesLookup[item._id] = item.issueCount;
    });

    // Get real scores from seo_page_scores collection
    const pageScores = await db.collection('seo_page_scores')
      .find({ projectId: projectIdObj })
      .toArray();

    // Create lookup for O(1) access
    const scoreLookup = Object.fromEntries(
      pageScores.map(s => [s.page_url, s.page_score])
    );

    LoggerUtil.debug('Real scores loaded', { count: pageScores.length, sample: Object.entries(scoreLookup).slice(0, 3) });

    // Format pages for frontend (EXACT same logic)
    const formattedPages = pages.map(page => {
      // Use real score from seo_page_scores, fallback to 0
      const realPageScore = scoreLookup[page.url] ?? 0;
      
      // Get issue count (kept for display)
      const issueCount = issuesLookup[page.url] || 0;
      
      // Check if page is indexable
      const robotsTag = page.meta_tags?.robots?.[0] || '';
      const isIndexable = !robotsTag.includes('noindex');

      return {
        id: page._id.toString(),
        url: page.url,
        page_score: realPageScore,
        issues_count: issueCount,
        crawl_depth: 1, // Default depth - could be calculated from internal links
        incoming_links: 0, // Could be calculated from internal_links collection
        outgoing_links: 0, // Could be calculated from page analysis
        external_links: 0, // Could be calculated from page analysis
        backlinks: 0, // Not available in current schema
        rankings: 0, // Not available in current schema
        page_title: page.title || 'No title',
        is_indexable: isIndexable,
        is_premium: false, // Could be based on user subscription
        http_status_code: page.http_status_code,
        response_time_ms: page.response_time_ms ? Math.round(page.response_time_ms / 1000000) : 0, // Convert ns to ms
        scraped_at: page.scraped_at,
        scrape_status: page.scrape_status,
        extraction_status: page.extraction_status
      };
    });

    // Calculate pagination
    const totalPages = Math.ceil(totalPagesCount / limit);
    const currentPage = parseInt(page);
    const hasNext = currentPage < totalPages;
    const hasPrev = currentPage > 1;

    // Get summary statistics - match overview dashboard counts
    const projectData = await SeoProject.findById(projectId);

    // Count indexable pages (pages without noindex tag)
    const indexablePages = await pagesCollection.countDocuments({
      projectId: projectIdObj,
      'meta_tags.robots': { $not: /noindex/ }
    });

    LoggerUtil.debug('Page counts', {
      total: totalPagesCount,
      indexable: indexablePages,
      crawled: projectData?.pages_crawled,
      analyzed: projectData?.pages_analyzed
    });

    const summary = {
      totalPages: totalPagesCount,
      scrapedPages: await pagesCollection.countDocuments({
        projectId: projectIdObj,
        scrape_status: 'completed'
      }),
      failedPages: await pagesCollection.countDocuments({
        projectId: projectIdObj,
        scrape_status: 'failed'
      }),
      totalWords: await pagesCollection.aggregate([
        { $match: { projectId: projectIdObj } },
        { $group: { _id: null, totalWords: { $sum: '$content.word_count' } } }
      ]).toArray().then(result => result[0]?.totalWords || 0),
      avgWordCount: 0 // Will be calculated below
    };

    summary.avgWordCount = summary.totalPages > 0 ? Math.round(summary.totalWords / summary.totalPages) : 0;

    LoggerUtil.debug('Pagination info', {
      totalPagesCount,
      currentPage,
      totalPages,
      limit: parseInt(limit),
      skip,
      hasNext,
      hasPrev
    });

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        subpages: formattedPages,
        crawled_pages: projectData?.pages_crawled || summary.scrapedPages,
        found_pages: projectData?.pages_analyzed || summary.scrapedPages,
        analyzed_pages: projectData?.pages_analyzed || summary.scrapedPages,
        pagination: {
          currentPage,
          totalPages,
          totalItems: totalPagesCount,
          hasNext,
          hasPrev
        },
        summary,
        debug: {
          allPagesCount: allPages.length,
          filteredPagesCount: totalPagesCount,
          projectId: projectId.toString(),
          query: queryObj
        }
      }
    };
  }

  /**
   * Get page details by ID
   * Additional utility method for future use
   */
  static async getPageDetails(project, pageId) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    const db = mongoose.connection.db;
    
    const page = await db.collection('seo_page_data').findOne({
      _id: new mongoose.Types.ObjectId(pageId),
      projectId: new mongoose.Types.ObjectId(projectId)
    });

    if (!page) {
      throw new Error('Page not found');
    }

    return {
      success: true,
      data: page
    };
  }
}
