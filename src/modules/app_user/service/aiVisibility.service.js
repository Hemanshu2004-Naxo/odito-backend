import { NotFoundError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

/**
 * AI Visibility Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all AI Visibility (AI Search Optimization) business logic
 * Maintains EXACT same behavior as original controller
 */
export class AIVisibilityService {
  
  /**
   * Get AI Visibility Entity Graph
   * Extracted from getAIVisibilityEntityGraph controller function
   */
  static async getAIVisibilityEntityGraph(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('AI Visibility Entity Graph API called', { projectId, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Get entity data from ai_visibility_entities collection
    const entities = await db.collection('ai_visibility_entities')
      .find({ projectId: projectIdObj })
      .toArray();

    // Get entity relationships
    const relationships = await db.collection('ai_visibility_relationships')
      .find({ projectId: projectIdObj })
      .toArray();

    // Format entity graph data
    const entityGraph = {
      nodes: entities.map(entity => ({
        id: entity._id.toString(),
        name: entity.name,
        type: entity.type,
        category: entity.category,
        frequency: entity.frequency,
        importance: entity.importance || 0,
        sentiment: entity.sentiment || 'neutral'
      })),
      edges: relationships.map(rel => ({
        source: rel.source_entity_id?.toString(),
        target: rel.target_entity_id?.toString(),
        type: rel.relationship_type,
        strength: rel.strength || 1
      }))
    };

    return {
      success: true,
      data: {
        entityGraph,
        summary: {
          totalEntities: entities.length,
          totalRelationships: relationships.length,
          topEntities: entityGraph.nodes
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 10)
        }
      }
    };
  }

  /**
   * Get AI Visibility Page data
   * Extracted from getAIVisibilityPage controller function
   */
  static async getAIVisibilityPage(project, pageUrl) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('AI Visibility Page API called', { projectId, userId, pageUrl });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);
    const decodedPageUrl = decodeURIComponent(pageUrl);

    // Get AI visibility data for specific page
    const pageData = await db.collection('ai_visibility_page_data')
      .findOne({
        projectId: projectIdObj,
        pageUrl: decodedPageUrl
      });

    if (!pageData) {
      return {
        success: true,
        data: {
          pageUrl: decodedPageUrl,
          hasData: false,
          message: 'No AI visibility data found for this page'
        }
      };
    }

    return {
      success: true,
      data: {
        pageUrl: decodedPageUrl,
        hasData: true,
        aiScore: pageData.ai_score || 0,
        entities: pageData.entities || [],
        topics: pageData.topics || [],
        sentiment: pageData.sentiment || 'neutral',
        readability: pageData.readability || {},
        contentQuality: pageData.content_quality || {},
        recommendations: pageData.recommendations || [],
        lastAnalyzed: pageData.last_analyzed
      }
    };
  }

  /**
   * Get AI Visibility Pages list
   * Extracted from getAIVisibilityPages controller function
   */
  static async getAIVisibilityPages(project, query = {}) {
    const { page = 1, limit = 50, sortBy = 'ai_score', sortOrder = 'desc' } = query;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('AI Visibility Pages API called', { projectId, userId, page, limit });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);
    const skip = (page - 1) * limit;

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Get AI visibility pages with pagination
    const pages = await db.collection('ai_visibility_page_data')
      .find({ projectId: projectIdObj })
      .sort(sortObj)
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    // Get total count
    const totalCount = await db.collection('ai_visibility_page_data')
      .countDocuments({ projectId: projectIdObj });

    // Format pages data
    const formattedPages = pages.map(page => ({
      id: page._id.toString(),
      pageUrl: page.pageUrl,
      pageTitle: page.page_title || 'No title',
      aiScore: page.ai_score || 0,
      entityCount: page.entities?.length || 0,
      topicCount: page.topics?.length || 0,
      sentiment: page.sentiment || 'neutral',
      lastAnalyzed: page.last_analyzed
    }));

    return {
      success: true,
      data: {
        pages: formattedPages,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalItems: totalCount,
          hasMore: totalCount > (skip + pages.length)
        },
        summary: {
          totalPagesAnalyzed: totalCount,
          averageScore: formattedPages.length > 0 
            ? Math.round(formattedPages.reduce((sum, p) => sum + p.aiScore, 0) / formattedPages.length)
            : 0
        }
      }
    };
  }

  /**
   * Get AI Visibility Worst Pages
   * Extracted from getAIVisibilityWorstPages controller function
   */
  static async getAIVisibilityWorstPages(project, limit = 10) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('AI Visibility Worst Pages API called', { projectId, userId, limit });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Get worst performing pages (lowest AI scores)
    const worstPages = await db.collection('ai_visibility_page_data')
      .find({ projectId: projectIdObj })
      .sort({ ai_score: 1 }) // Ascending for worst first
      .limit(parseInt(limit))
      .toArray();

    // Format worst pages data
    const formattedPages = worstPages.map(page => ({
      id: page._id.toString(),
      pageUrl: page.pageUrl,
      pageTitle: page.page_title || 'No title',
      aiScore: page.ai_score || 0,
      issues: page.issues || [],
      recommendations: (page.recommendations || []).slice(0, 3), // Top 3 recommendations
      lastAnalyzed: page.last_analyzed
    }));

    return {
      success: true,
      data: {
        worstPages: formattedPages,
        summary: {
          totalIssues: formattedPages.reduce((sum, p) => sum + (p.issues?.length || 0), 0),
          averageScore: formattedPages.length > 0
            ? Math.round(formattedPages.reduce((sum, p) => sum + p.aiScore, 0) / formattedPages.length)
            : 0
        }
      }
    };
  }

  /**
   * Get Standalone AI Visibility Pages
   * Extracted from getStandaloneAIVisibilityPages controller function
   */
  static async getStandaloneAIVisibilityPages(userId, query = {}) {
    const { page = 1, limit = 50, projectId } = query;
    
    LoggerUtil.info('Standalone AI Visibility Pages API called', { userId, projectId, page, limit });

    // If projectId provided, verify ownership
    if (projectId) {
      const project = await SeoProject.findById(projectId);
      if (!project) {
        const error = new Error('Project not found');
        error.statusCode = 404;
        error.response = { success: false, message: 'Project not found' };
        throw error;
      }

      if (project.user_id.toString() !== userId.toString()) {
        const error = new Error('Access denied');
        error.statusCode = 403;
        error.response = { success: false, message: 'Access denied' };
        throw error;
      }
    }

    const db = mongoose.connection.db;
    const skip = (page - 1) * limit;

    // Build query - can be across all user's projects or specific project
    let matchQuery = {};
    if (projectId) {
      matchQuery.projectId = new mongoose.Types.ObjectId(projectId);
    } else {
      // Get all projects for this user
      const userProjects = await SeoProject.find({ user_id: userId }).select('_id');
      const projectIds = userProjects.map(p => p._id.toString());
      matchQuery.projectId = { $in: projectIds.map(id => new mongoose.Types.ObjectId(id)) };
    }

    // Get standalone AI visibility pages
    const pages = await db.collection('ai_visibility_standalone_pages')
      .find(matchQuery)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    // Get total count
    const totalCount = await db.collection('ai_visibility_standalone_pages')
      .countDocuments(matchQuery);

    // Format pages
    const formattedPages = pages.map(page => ({
      id: page._id.toString(),
      projectId: page.projectId?.toString(),
      pageUrl: page.pageUrl,
      pageTitle: page.page_title || 'No title',
      aiScore: page.ai_score || 0,
      analysisType: page.analysis_type || 'full',
      status: page.status || 'completed',
      createdAt: page.created_at,
      completedAt: page.completed_at
    }));

    return {
      success: true,
      data: {
        pages: formattedPages,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalItems: totalCount,
          hasMore: totalCount > (skip + pages.length)
        }
      }
    };
  }

  /**
   * Get Page Score
   * Extracted from getPageScore controller function
   */
  static async getPageScore(project, pageUrl) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Page Score API called', { projectId, userId, pageUrl });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);
    const decodedPageUrl = decodeURIComponent(pageUrl);

    // Get page score from multiple sources
    const [aiVisibilityData, seoPageData, pageScoresData] = await Promise.all([
      db.collection('ai_visibility_page_data').findOne({
        projectId: projectIdObj,
        pageUrl: decodedPageUrl
      }),
      db.collection('seo_page_data').findOne({
        projectId: projectIdObj,
        url: decodedPageUrl
      }),
      db.collection('seo_page_scores').findOne({
        projectId: projectIdObj,
        page_url: decodedPageUrl
      })
    ]);

    // Calculate composite score
    const aiScore = aiVisibilityData?.ai_score || 0;
    const seoScore = pageScoresData?.page_score || 0;
    const compositeScore = Math.round((aiScore * 0.6) + (seoScore * 0.4));

    return {
      success: true,
      data: {
        pageUrl: decodedPageUrl,
        scores: {
          composite: compositeScore,
          ai: aiScore,
          seo: seoScore
        },
        details: {
          aiVisibility: aiVisibilityData ? {
            entities: aiVisibilityData.entities?.length || 0,
            topics: aiVisibilityData.topics?.length || 0,
            sentiment: aiVisibilityData.sentiment,
            readability: aiVisibilityData.readability
          } : null,
          seo: seoPageData ? {
            wordCount: seoPageData.content?.word_count,
            headings: seoPageData.content?.headings,
            metaTags: seoPageData.meta_tags
          } : null
        },
        lastAnalyzed: aiVisibilityData?.last_analyzed || pageScoresData?.last_updated
      }
    };
  }

  /**
   * Run AI Visibility Analysis
   * Additional utility method for future use
   */
  static async runAIVisibilityAnalysis(project, options = {}) {
    const { pageUrls, analysisType = 'full' } = options;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    // This would typically queue a job for AI analysis
    // For now, return a job ID for tracking
    const jobId = new mongoose.Types.ObjectId();

    return {
      success: true,
      data: {
        jobId: jobId.toString(),
        status: 'queued',
        projectId,
        pagesToAnalyze: pageUrls?.length || 0,
        analysisType,
        estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes estimate
      }
    };
  }
}
