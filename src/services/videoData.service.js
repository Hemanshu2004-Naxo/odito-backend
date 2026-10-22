/**
 * Video Data Service  
 * Provides structured data for video generation without scripts
 * Replaces script-based approach with pure score/metric data
 */

import { AiDataService } from '../modules/aiVideo/services/aiData.service.js';
import { ScoreOnlyResponseService } from '../services/scoreOnlyResponse.service.js';

export class VideoDataService {
  /**
   * Get video generation data (scores only, no scripts)
   * @param {string} projectId - Project ID
   * @param {Object} options - Configuration options
   * @returns {Object} Structured data for video generation
   */
  static async getVideoData(projectId, options = {}) {
    try {
      console.log(`[VIDEO_DATA] Fetching structured data for project: ${projectId}`);

      // Fetch audit data using existing service
      const auditResult = await AiDataService.fetchAuditData(projectId, {
        authToken: options.authToken
      });

      const auditData = auditResult.data;

      // Extract and structure data for video generation
      const videoData = {
        // Project metadata
        project: {
          name: auditData.project?.name || 'Website',
          url: auditData.project?.url || 'N/A',
          industry: auditData.project?.industry || 'Technology'
        },

        // Core scores (the foundation of video content)
        scores: {
          overall: Math.round(Number(auditData.scores?.overall || auditData.scores?.seo || 0)),
          performance: Math.round(Number(auditData.scores?.performance || 0)),
          seo: Math.round(Number(auditData.scores?.seo || auditData.scores?.seoHealth || 0)),
          aiVisibility: Math.round(Number(auditData.scores?.aiVisibility || 0)),
          accessibility: Math.round(Number(auditData.scores?.accessibility || 0))
        },

        // Issue distribution for priority discussion
        issueDistribution: {
          critical: Number(auditData.issueDistribution?.critical || 0),
          high: Number(auditData.issueDistribution?.high || 0),
          medium: Number(auditData.issueDistribution?.medium || 0),
          low: Number(auditData.issueDistribution?.low || 0),
          total: Number(auditData.issueDistribution?.total || 0)
        },

        // Top issues (titles only, no descriptions)
        topIssues: {
          critical: this.extractIssueTitles(auditData.topIssues?.critical || []).slice(0, 3),
          high: this.extractIssueTitles(auditData.topIssues?.high || []).slice(0, 5),
          medium: this.extractIssueTitles(auditData.topIssues?.medium || []).slice(0, 3),
          low: this.extractIssueTitles(auditData.topIssues?.low || []).slice(0, 2)
        },

        // Performance metrics (numbers only)
        performanceMetrics: {
          mobileScore: Math.round(Number(auditData.performance?.mobileScore || 0)),
          desktopScore: Math.round(Number(auditData.performance?.desktopScore || 0)),
          pageSpeed: Math.round(Number(auditData.performance?.avgPerformance || auditData.performance?.mobileScore || auditData.performance?.desktopScore || 0)),
          lcp: this.formatMetricValue(auditData.performance?.mobileMetrics?.[0]?.mobile || auditData.performance?.lcp),
          tbt: this.formatMetricValue(auditData.performance?.mobileMetrics?.[1]?.mobile || auditData.performance?.tbt),
          cls: this.formatMetricValue(auditData.performance?.mobileMetrics?.[3]?.mobile || auditData.performance?.cls)
        },

        // Technical highlights (check results only)
        technicalHighlights: {
          totalChecks: Number(auditData.technical?.checks?.length || 0),
          criticalIssues: this.extractIssueTitles(auditData.technical?.checks?.filter(c => c.status === 'FAIL') || []).slice(0, 3),
          topRecommendations: this.extractIssueTitles(auditData.technical?.checks?.slice(0, 5) || [])
        },

        // Keyword data (rankings and opportunities)
        keywordData: {
          totalKeywords: Number(auditData.keywords?.totalKeywords || 0),
          topRankings: this.extractKeywordData(auditData.keywords?.topRankings || []).slice(0, 5),
          opportunities: this.extractKeywordData(auditData.keywords?.opportunities || []).slice(0, 3)
        },

        // Recommendations (titles only)
        recommendations: this.extractRecommendationTitles(auditData.recommendations || []).slice(0, 5),

        // AI Hub data not available in fallback path (no AIScript snapshot)
        aiHubSnapshot: null,

        // Metadata
        metadata: {
          generatedAt: new Date().toISOString(),
          source: 'VideoDataService',
          version: '2.0.0'
        }
      };

      // Validate that this is score-only data
      ScoreOnlyResponseService.validateScoreOnlyResponse(videoData);

      console.log(`[VIDEO_DATA] ✅ Structured data validated and ready for video generation`);
      return {
        success: true,
        data: videoData
      };

    } catch (error) {
      console.error(`[VIDEO_DATA] ❌ Failed to fetch video data:`, error);
      throw error;
    }
  }

  /**
   * Extract issue titles (remove descriptions, keep only titles)
   * @param {Array} issues - Raw issues array
   * @returns {Array} Array of issue titles
   */
  static extractIssueTitles(issues) {
    if (!Array.isArray(issues)) return [];
    
    return issues
      .map(issue => {
        if (typeof issue === 'string') return issue;
        return issue?.title || issue?.issue || issue?.name || 'Technical Issue';
      })
      .filter(title => title && title !== 'Technical Issue')
      .slice(0, 10); // Limit to prevent overly long videos
  }

  /**
   * Extract keyword data (position and volume only)
   * @param {Array} keywords - Raw keywords array  
   * @returns {Array} Array of keyword data
   */
  static extractKeywordData(keywords) {
    if (!Array.isArray(keywords)) return [];
    
    return keywords
      .map(keyword => ({
        keyword: keyword?.keyword || keyword?.query || 'Unknown',
        position: Number(keyword?.position || keyword?.rank || 0),
        volume: Number(keyword?.volume || keyword?.searchVolume || 0),
        url: keyword?.url || null
      }))
      .filter(k => k.keyword !== 'Unknown')
      .slice(0, 10);
  }

  /**
   * Extract recommendation titles (remove detailed descriptions)
   * @param {Array} recommendations - Raw recommendations array
   * @returns {Array} Array of recommendation titles
   */
  static extractRecommendationTitles(recommendations) {
    if (!Array.isArray(recommendations)) return [];
    
    return recommendations
      .map(rec => {
        if (typeof rec === 'string') return rec;
        return rec?.title || rec?.recommendation || rec?.name || 'Recommendation';
      })
      .filter(title => title && title !== 'Recommendation')
      .slice(0, 8);
  }

  /**
   * Format metric values for display
   * @param {*} value - Raw metric value
   * @returns {string} Formatted value
   */
  static formatMetricValue(value) {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'string') return value;
    return 'N/A';
  }

  /**
   * Get video data in specific page format for slides
   * @param {string} projectId - Project ID
   * @param {string} pageType - Type of page/data needed
   * @param {Object} options - Configuration options
   * @returns {Object} Page-specific data
   */
  static async getPageVideoData(projectId, pageType, options = {}) {
    const fullData = await this.getVideoData(projectId, options);
    const data = fullData.data;

    switch (pageType) {
      case 'overview':
        return {
          page: 'overview',
          scores: data.scores,
          issueDistribution: data.issueDistribution,
          project: data.project
        };

      case 'issues':
        return {
          page: 'issues', 
          scores: data.scores,
          topIssues: data.topIssues,
          issueDistribution: data.issueDistribution
        };

      case 'technical':
        return {
          page: 'technical',
          scores: data.scores,
          technicalHighlights: data.technicalHighlights,
          topIssues: data.topIssues.high
        };

      case 'performance':
        return {
          page: 'performance',
          scores: data.scores,
          performanceMetrics: data.performanceMetrics
        };

      case 'keywords':
        return {
          page: 'keywords',
          scores: data.scores,
          keywordData: data.keywordData
        };

      default:
        throw new Error(`Unknown page type: ${pageType}`);
    }
  }
}

export default VideoDataService;
