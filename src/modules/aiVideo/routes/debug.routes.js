/**
 * Debug Routes for AI Script Generation
 * Provides endpoints to debug data mapping issues
 * 🔒 SECURITY: Disabled in production
 */

import express from 'express';
import { AiDataService } from '../services/aiData.service.js';
import { UnifiedJsonService } from '../../pdf/service/unifiedJsonService.js';
import { debugAuditFlow } from '../services/debugAuditFlow.service.js';

const router = express.Router();

// 🔒 SECURITY: Block all debug routes in production
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      message: 'Debug routes are disabled in production'
    });
  }
  next();
});

/**
 * 🔧 STEP 2: CREATE TEMP API - COMPLETE DEBUG FLOW
 * GET /api/debug/audit/:projectId
 * Complete debug flow to trace data loss
 */
router.get('/audit/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    console.log(`\n🚀 DEBUG API CALLED for project: ${projectId}`);
    console.log("=".repeat(80));
    
    // Call the comprehensive debug function
    const debugResult = await debugAuditFlow(projectId);
    
    if (debugResult.success) {
      return res.status(200).json({
        success: true,
        message: "Debug flow completed successfully",
        data: debugResult.summary
      });
    } else {
      return res.status(500).json({
        success: false,
        error: debugResult.error,
        message: "Debug flow failed"
      });
    }
    
  } catch (error) {
    console.error('[DEBUG API] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      projectId: req.params.projectId
    });
  }
});

/**
 * GET /api/debug/quick-audit/:projectId
 * Quick debug to check data availability
 */
router.get('/quick-audit/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    console.log(`[DEBUG] Quick audit for project: ${projectId}`);
    
    // Method 1: Try AiDataService first
    let aiDataResult;
    try {
      aiDataResult = await AiDataService.fetchAuditData(projectId);
      console.log('[DEBUG] AiDataService result:', {
        success: aiDataResult.success,
        hasData: !!aiDataResult.data,
        dataKeys: aiDataResult.data ? Object.keys(aiDataResult.data) : []
      });
    } catch (error) {
      console.log('[DEBUG] AiDataService failed:', error.message);
    }
    
    // Method 2: Try UnifiedJsonService directly
    let unifiedResult;
    try {
      unifiedResult = await UnifiedJsonService.getFullReportJson(projectId, {
        includeMetadata: true
      });
      console.log('[DEBUG] UnifiedJsonService result:', {
        success: unifiedResult.success,
        hasData: !!unifiedResult.data,
        dataKeys: unifiedResult.data ? Object.keys(unifiedResult.data) : []
      });
    } catch (error) {
      console.log('[DEBUG] UnifiedJsonService failed:', error.message);
    }
    
    // Return both results for comparison
    const debugData = {
      projectId,
      timestamp: new Date().toISOString(),
      aiDataService: {
        success: !!aiDataResult,
        data: aiDataResult?.data || null,
        error: aiDataResult ? null : (error.message || 'Unknown error')
      },
      unifiedService: {
        success: !!unifiedResult,
        data: unifiedResult?.data || null,
        error: unifiedResult ? null : (error.message || 'Unknown error')
      }
    };
    
    // Log data paths for debugging
    if (debugData.aiDataService.data) {
      console.log('[DEBUG] AiDataService paths:');
      console.log('  - issueDistribution:', !!debugData.aiDataService.data.issueDistribution);
      console.log('  - scores:', !!debugData.aiDataService.data.scores);
      console.log('  - project:', !!debugData.aiDataService.data.project);
      console.log('  - recommendations:', !!debugData.aiDataService.data.recommendations);
    }
    
    if (debugData.unifiedService.data) {
      console.log('[DEBUG] UnifiedService paths:');
      console.log('  - issueDistribution:', !!debugData.unifiedService.data.issueDistribution);
      console.log('  - scores:', !!debugData.unifiedService.data.scores);
      console.log('  - project:', !!debugData.unifiedService.data.project);
      console.log('  - recommendations:', !!debugData.unifiedService.data.recommendations);
    }
    
    return res.status(200).json({
      success: true,
      debugData
    });
    
  } catch (error) {
    console.error('[DEBUG] Debug endpoint error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      projectId: req.params.projectId
    });
  }
});

/**
 * GET /api/debug/test-mapping/:projectId
 * Test the mapping functions with real data
 */
router.get('/test-mapping/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    console.log(`[DEBUG] Testing mapping for project: ${projectId}`);
    
    // Get raw data
    const aiDataResult = await AiDataService.fetchAuditData(projectId);
    const auditData = aiDataResult.data;
    
    // Import AiScriptService to test mapping
    const { AiScriptService } = await import('../services/aiScript.service.js');
    
    // Test buildAuditSnapshot
    console.log('[DEBUG] Testing buildAuditSnapshot...');
    const auditSnapshot = await AiScriptService.buildAuditSnapshot(auditData);
    
    // Test buildPromptData
    console.log('[DEBUG] Testing buildPromptData...');
    const promptData = AiScriptService.buildPromptData(auditData);
    
    // Test testScript function
    console.log('[DEBUG] Testing testScript...');
    const testOutput = AiScriptService.testScript(auditSnapshot);
    
    return res.status(200).json({
      success: true,
      projectId,
      mappingResults: {
        auditSnapshot: {
          projectName: auditSnapshot.projectName,
          issueDistribution: auditSnapshot.issueDistribution,
          scores: auditSnapshot.scores,
          recommendationCount: auditSnapshot.recommendations?.length || 0
        },
        promptData: {
          projectName: promptData.projectName,
          issueDistribution: promptData.issueDistribution,
          scores: promptData.scores,
          topRecommendationsCount: promptData.topRecommendations?.length || 0
        },
        testScriptOutput: testOutput
      }
    });
    
  } catch (error) {
    console.error('[DEBUG] Test mapping error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      projectId: req.params.projectId
    });
  }
});

export default router;
