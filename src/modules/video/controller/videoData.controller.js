/**
 * Video Data Controller
 * Provides structured data for video generation without scripts
 */

import { VideoDataService } from '../../../services/videoData.service.js';
import { ScoreOnlyResponseService } from '../../../services/scoreOnlyResponse.service.js';
import AIScript from '../../aiVideo/models/aiScript.model.js';

/**
 * GET /api/video/data/:projectId
 * Get structured video data for a project (scores only, no scripts)
 * 
 * @param {projectId} string - Project ID (URL param)
 * @returns {Object} Structured video data
 */
export const getVideoData = async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?._id;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    console.log("VIDEO GENERATION START | projectId:", projectId);

    // Step 1: Check AIScript model for audit snapshot
    console.log("AISCRIPT DATA CHECK - Finding document for projectId:", projectId);
    const scriptDoc = await AIScript.findOne({ projectId });
    console.log("AISCRIPT DATA:", scriptDoc);

    // Step 2: Check if it contains auditSnapshot
    if (!scriptDoc || !scriptDoc.auditSnapshot) {
      console.log("❌ No auditSnapshot found in AIScript, falling back to VideoDataService");
      // Fallback to original service if no snapshot exists
      const result = await VideoDataService.getVideoData(projectId, {
        authToken: req.headers.authorization?.split(' ')[1]
      });

      if (!result.success) {
        return res.status(404).json({
          success: false,
          message: 'Video data not found for this project',
          error: result.error
        });
      }

      const response = {
        success: true,
        data: result.data,
        message: 'Video data retrieved successfully (fallback)'
      };

      ScoreOnlyResponseService.validateScoreOnlyResponse(response);
      return res.status(200).json(response);
    }

    // Step 3: Build videoData from auditSnapshot
    console.log("✅ Building videoData from auditSnapshot");
    const snapshot = scriptDoc.auditSnapshot;
    
    const videoData = {
      topIssues: snapshot.topIssues || { critical: [], high: [], medium: [], low: [] },
      technicalHighlights: {
        totalChecks: snapshot.technicalHighlights?.checks?.length || 0,
        criticalIssues: snapshot.technicalHighlights?.criticalIssues || [],
        topRecommendations: snapshot.technicalHighlights?.topRecommendations || []
      },
      performanceMetrics: {
        mobileScore: snapshot.performanceMetrics?.mobileScore || 0,
        desktopScore: snapshot.performanceMetrics?.desktopScore || 0,
        pageSpeed: snapshot.performanceMetrics?.pageSpeed || 0,
        lcp: snapshot.performanceMetrics?.metrics?.[0]?.mobile || "N/A",
        tbt: snapshot.performanceMetrics?.metrics?.[1]?.mobile || "N/A",
        cls: snapshot.performanceMetrics?.metrics?.[3]?.mobile || "N/A"
      },
      scores: snapshot.scores || { overall: 0, performance: 0, seo: 0, aiVisibility: 0 },
      issueDistribution: snapshot.issueDistribution || { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      project: {
        name: snapshot.projectName || 'Website',
        url: snapshot.url || 'N/A'
      },
      aiHubSnapshot: snapshot.aiHubSnapshot || null,
    };

    // Step 4: Keep script from AIScript (for reference)
    const script = scriptDoc.script;

    console.log("FINAL VIDEO DATA:", videoData);
    console.log("✅ Video data built from auditSnapshot successfully");
    console.log("✅ topIssues.high.length:", videoData.topIssues.high?.length || 0);
    console.log("✅ technicalHighlights.totalChecks:", videoData.technicalHighlights.totalChecks);

    const response = {
      success: true,
      data: videoData,
      script: script, // Include script for reference
      message: 'Video data retrieved successfully from auditSnapshot'
    };

    // Validate response is score-only before sending
    ScoreOnlyResponseService.validateScoreOnlyResponse(response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[VIDEO_DATA_CTRL] Get video data error:', error);

    // Check if it's a validation error (forbidden content)
    if (error.message.includes('FORBIDDEN CONTENT DETECTED')) {
      return res.status(500).json({
        success: false,
        message: 'Response validation failed - forbidden content detected',
        error: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve video data',
      error: error.message
    });
  }
};

/**
 * GET /api/video/data/:projectId/:pageType
 * Get page-specific video data for slides
 * 
 * @param {projectId} string - Project ID (URL param)
 * @param {pageType} string - Page type (overview, issues, technical, performance, keywords, ai)
 * @returns {Object} Page-specific structured data
 */
export const getPageVideoData = async (req, res) => {
  try {
    const { projectId, pageType } = req.params;
    const userId = req.user?._id;

    if (!projectId || !pageType) {
      return res.status(400).json({
        success: false,
        message: 'projectId and pageType are required'
      });
    }

    console.log(`[VIDEO_DATA_CTRL] Get page video data | projectId=${projectId} | pageType=${pageType}`);

    // Validate page type
    const validPageTypes = ['overview', 'issues', 'technical', 'performance', 'keywords', 'ai'];
    if (!validPageTypes.includes(pageType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid pageType. Must be one of: ${validPageTypes.join(', ')}`
      });
    }

    // Get page-specific data
    const result = await VideoDataService.getPageVideoData(projectId, pageType, {
      authToken: req.headers.authorization?.split(' ')[1]
    });

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: `Video data for page '${pageType}' not found`,
        error: result.error
      });
    }

    // Return score-only response
    const response = {
      success: true,
      data: result.data,
      pageType: pageType,
      message: `Video data for '${pageType}' retrieved successfully`
    };

    // Validate response is score-only before sending
    ScoreOnlyResponseService.validateScoreOnlyResponse(response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[VIDEO_DATA_CTRL] Get page video data error:', error);

    // Check if it's a validation error
    if (error.message.includes('FORBIDDEN CONTENT DETECTED')) {
      return res.status(500).json({
        success: false,
        message: 'Response validation failed - forbidden content detected',
        error: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve page video data',
      error: error.message
    });
  }
};

/**
 * GET /api/video/template/:slideType
 * Get template example for a slide type (for testing)
 * 
 * @param {slideType} string - Slide type
 * @returns {Object} Template example
 */
export const getSlideTemplate = async (req, res) => {
  try {
    const { slideType } = req.params;

    if (!slideType) {
      return res.status(400).json({
        success: false,
        message: 'slideType is required'
      });
    }

    // Import template service
    const VideoTemplateService = require('../../../video/services/videoTemplate.service');
    
    // Create sample data for template
    const sampleData = {
      scores: {
        overall: 75,
        performance: 68,
        seo: 82,
        aiVisibility: 70
      },
      project: {
        name: 'Sample Website',
        url: 'https://example.com'
      },
      issueDistribution: {
        critical: 2,
        high: 8,
        medium: 15,
        low: 5,
        total: 30
      },
      topIssues: {
        high: ['Missing meta descriptions', 'Slow page load speed', 'Mobile optimization issues'],
        medium: ['Image alt text missing', 'Header structure problems']
      },
      performanceMetrics: {
        mobileScore: 68,
        desktopScore: 75,
        pageSpeed: 72,
        lcp: '4.2',
        tbt: '1200'
      },
      technicalHighlights: {
        totalChecks: 45,
        criticalIssues: ['SSL certificate expired', 'XML sitemap missing'],
        topRecommendations: ['Implement HTTPS', 'Add structured data']
      },
      keywordData: {
        totalKeywords: 125,
        topRankings: [
          { keyword: 'web design', position: 12, volume: 2400 },
          { keyword: 'seo services', position: 18, volume: 1600 }
        ],
        opportunities: [
          { keyword: 'local seo', position: 45, volume: 800 }
        ]
      },
      recommendations: [
        'Optimize page load speed',
        'Add missing meta descriptions',
        'Implement structured data markup',
        'Fix mobile usability issues',
        'Improve internal linking'
      ]
    };

    // Generate template narration
    const narration = VideoTemplateService.generateSlideNarration(slideType, sampleData);

    const response = {
      success: true,
      slideType: slideType,
      sampleData: sampleData,
      templateNarration: narration,
      message: `Template for '${slideType}' slide generated successfully`
    };

    // Validate response is score-only
    ScoreOnlyResponseService.validateScoreOnlyResponse(response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[VIDEO_DATA_CTRL] Get slide template error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to generate slide template',
      error: error.message
    });
  }
};

export default {
  getVideoData,
  getPageVideoData,
  getSlideTemplate
};
