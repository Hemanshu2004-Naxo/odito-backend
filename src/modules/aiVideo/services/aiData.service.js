import { UnifiedJsonService } from '../../pdf/service/unifiedJsonService.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * AI Data Service
 * Responsible for fetching and structuring audit data for script generation
 */
export class AiDataService {
  /**
   * Fetch and structure audit data for a project
   * Uses existing UnifiedJsonService to gather comprehensive audit data
   * 
   * @param {string} projectId - Project ID
   * @param {Object} options - Configuration options (including authToken)
   * @returns {Object} Structured audit data
   */
  static async fetchAuditData(projectId, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[AI_DATA] Fetching audit data for project: ${projectId}`);

      // Validate project exists
      const project = await SeoProject.findById(projectId).lean();
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      // Fetch comprehensive audit data using UnifiedJsonService
      console.log(`[AI_DATA] Calling UnifiedJsonService for: ${projectId}`);
      
      const result = await UnifiedJsonService.getFullReportJson(projectId, {
        includeMetadata: true,
        authToken: options.authToken
      });

      if (!result.success) {
        console.warn(`[AI_DATA] UnifiedJsonService returned partial data:`, result.error);
      }

      const auditData = result.data || {};

      // Structure data specifically for script generation
      const structuredData = this.normalizeAuditData(auditData, project);

      const processingTime = Date.now() - startTime;
      console.log(`[AI_DATA] Audit data fetched successfully | processingTime=${processingTime}ms`);

      return {
        success: true,
        data: structuredData,
        processingTime
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[AI_DATA] Failed to fetch audit data:`, {
        projectId,
        error: error.message,
        processingTime
      });

      throw error;
    }
  }

  /**
   * Normalize audit data into a clean, AI-friendly format
   * This ensures consistent structure regardless of data source
   * 
   * @param {Object} rawData - Raw audit data from UnifiedJsonService
   * @param {Object} project - SeoProject document
   * @returns {Object} Normalized audit data
   */
  static normalizeAuditData(rawData, project) {
    return {
      // Project info
      project: {
        name: project.project_name,
        url: project.main_url,
        industry: project.industry || 'Unknown',
        country: project.country || 'Unknown'
      },

      // Overall scores
      scores: rawData.scores || {
        overall: 0,
        performance: 0,
        seo: 0,
        aiVisibility: 0
      },

      // Issues summary (counts) + display slices from unified JSON
      issues: rawData.issues || {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        total: 0
      },

      topIssues: rawData.topIssues || {
        critical: [],
        high: [],
        medium: [],
        low: []
      },

      issueDistribution: rawData.issueDistribution || {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        total: 0
      },

      // Technical SEO
      technical: rawData.technical || {
        issues: [],
        recommendations: []
      },

      // Performance metrics
      performance: rawData.performance || {
        coreWebVitals: {},
        pageSpeed: 0,
        metrics: []
      },

      // Keywords & Rankings
      keywords: rawData.keywords || {
        totalKeywords: 0,
        topRankings: [],
        opportunities: []
      },

      // AI Visibility & Knowledge Graph
      ai: rawData.ai || {
        visibility: 0,
        structuredData: {},
        knowledgeGraph: {},
        schemaMarkup: []
      },

      // Content readiness
      content: rawData.content || {
        readability: 0,
        structure: {},
        gaps: []
      },

      // Unified recommendations across all areas
      recommendations: rawData.recommendations || [],

      // Metadata
      metadata: {
        generatedAt: new Date().toISOString(),
        projectId: project._id.toString(),
        version: '1.0.0'
      }
    };
  }

  /**
   * Check if audit data is available and recent
   * Helps determine if we need to fetch fresh data
   * 
   * @param {string} projectId - Project ID
   * @param {number} maxAgeMs - Maximum acceptable age in milliseconds (default: 24 hours)
   * @returns {Promise<boolean>} True if recent audit data exists
   */
  static async hasRecentAuditData(projectId, maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      const project = await SeoProject.findById(projectId).lean();
      if (!project || !project.last_analysis_at) {
        return false;
      }

      const ageMs = Date.now() - new Date(project.last_analysis_at).getTime();
      return ageMs < maxAgeMs;
    } catch (error) {
      console.error(`[AI_DATA] Error checking audit data recency:`, error);
      return false;
    }
  }
}

export default AiDataService;
