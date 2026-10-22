import { VideoDataService } from '../../../services/videoData.service.js';
import { ScoreOnlyResponseService } from '../../../services/scoreOnlyResponse.service.js';
import { JobService } from '../../jobs/service/jobService.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import AIScript from '../models/aiScript.model.js';
import { AiScriptService } from '../services/aiScript.service.js';
import { AIGeneratedVideoService } from '../../video/services/aiGeneratedVideo.service.js';
import { ObjectId } from 'mongodb';

/**
 * AI Script Controller
 * Handles API endpoints for script generation
 */

/**
 * POST /api/ai-video/script
 * Generate or retrieve a video narration script for a project
 * 
 * @body {projectId} string - Project ID
 * @returns {Object} Generated script
 */
export const generateScript = async (req, res) => {
  try {
    const { projectId } = req.body;
    const userId = req.user?._id;

    // Validate input
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    console.log(`[SCRIPT_CTRL] Generate script request | projectId=${projectId} | userId=${userId}`);

    // Extract auth token from request header
    const authToken = req.headers.authorization?.split(' ')[1];

    // Generate script using service
    const result = await AiScriptService.generateScript(projectId, {
      forceRegenerate: req.body.forceRegenerate || false,
      authToken: authToken
    });

    // Return success response
    return res.status(200).json({
      success: true,
      script: result.script,
      isExisting: result.isExisting || false,
      processingTime: result.processingTime,
      aiProvider: result.aiProvider || 'unknown',
      message: result.isExisting ? 'Existing script retrieved' : 'Script generated successfully'
    });

  } catch (error) {
    console.error('[SCRIPT_CTRL] Generate script error:', {
      message: error.message,
      projectId: req.body?.projectId,
      stack: error.stack
    });

    // Return error response with appropriate status code
    if (error.message.includes('Project not found')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }

    if (error.message.includes('API key') || error.message.includes('configuration')) {
      return res.status(503).json({
        success: false,
        message: 'AI service temporarily unavailable. Please try again later.'
      });
    }

    if (error.message.includes('quota')) {
      return res.status(429).json({
        success: false,
        message: 'AI service quota exceeded. Please try again later.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to generate script',
      error: error.message
    });
  }
};

/**
 * GET /api/ai-video/script/:projectId
 * Get existing script for a project
 * 
 * @param {projectId} string - Project ID (URL param)
 * @returns {Object} Script data
 */
export const getScript = async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?._id;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    console.log(`[SCRIPT_CTRL] Get script request | projectId=${projectId}`);

    const script = await AiScriptService.getScriptByProjectId(projectId);

    if (!script) {
      return res.status(404).json({
        success: false,
        message: 'Script not found for this project. Generate a script first.'
      });
    }

    return res.status(200).json({
      success: true,
      script: script.script,
      status: script.status,
      createdAt: script.createdAt,
      updatedAt: script.updatedAt,
      processingTime: script.processingTime,
      aiProvider: script.aiProvider || 'unknown'
    });

  } catch (error) {
    console.error('[SCRIPT_CTRL] Get script error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve script',
      error: error.message
    });
  }
};

/**
 * DELETE /api/ai-video/script/:projectId
 * Delete script for a project
 * 
 * @param {projectId} string - Project ID (URL param)
 * @returns {Object} Success response
 */
export const deleteScript = async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?._id;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    console.log(`[SCRIPT_CTRL] Delete script request | projectId=${projectId}`);

    // Verify ownership
    const script = await AIScript.findOne({ projectId }).select('userId');
    if (script && script.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You do not own this script'
      });
    }

    await AiScriptService.deleteScript(projectId);

    return res.status(200).json({
      success: true,
      message: 'Script deleted successfully'
    });

  } catch (error) {
    console.error('[SCRIPT_CTRL] Delete script error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to delete script',
      error: error.message
    });
  }
};

/**
 * GET /api/ai-video/data/:projectId
 * Get structured data for video generation (DEPRECATED - use /api/video/data/:projectId)
 * @deprecated Use video data controller instead
 */
export const getVideoData = async (req, res) => {
  try {
    const { projectId } = req.params;
    console.log(`[VIDEO_CTRL] ⚠️ DEPRECATED: getVideoData called, redirecting to new service`);
    
    // Redirect to new service
    const result = await VideoDataService.getVideoData(projectId, {
      authToken: req.headers.authorization?.split(' ')[1]
    });

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: 'Video data not found',
        error: result.error
      });
    }

    const response = {
      success: true,
      data: result.data,
      deprecated: true,
      message: 'This endpoint is deprecated. Use /api/video/data/:projectId instead'
    };

    // Validate response
    ScoreOnlyResponseService.validateScoreOnlyResponse(response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[VIDEO_CTRL] Get video data error:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve video data',
      error: error.message
    });
  }
};

/**
 * POST /api/ai-video/video
 * Generate a complete video for a project
 * Uses score-only data, no scripts
 * 
 * @body {projectId} string - Project ID
 * @returns {Object} Job ID for tracking
 */
export const generateVideo = async (req, res) => {
  try {
    const { projectId } = req.body;
    const userId = req.user?._id;

    // Validate input
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    console.log(`[VIDEO_CTRL] Generate video request | projectId=${projectId} | userId=${userId}`);

    // Validate project exists
    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check if video data is available (NO SCRIPT CHECK)
    console.log(`[VIDEO_CTRL] Checking for available video data...`);
    try {
      const videoDataCheck = await VideoDataService.getVideoData(projectId, {
        authToken: req.headers.authorization?.split(' ')[1]
      });
      
      if (!videoDataCheck.success) {
        return res.status(400).json({
          success: false,
          message: 'Video data not available. Please complete a website audit first.',
          error: videoDataCheck.error
        });
      }
      
      console.log(`[VIDEO_CTRL] ✅ Video data available, proceeding with video generation`);
    } catch (dataError) {
      console.error(`[VIDEO_CTRL] Video data check failed:`, dataError);
      return res.status(400).json({
        success: false,
        message: 'Unable to access video data. Please ensure audit data is available.',
        error: dataError.message
      });
    }

    // 🧠 ENSURE SCRIPT EXISTS IN aiScript COLLECTION BEFORE VIDEO DISPATCH
    console.log(`[VIDEO_CTRL] Ensuring script exists for projectId=${projectId}...`);
    
    try {
      // Check if script already exists
      let existingScript = await AIScript.findOne({ projectId });
      
      if (!existingScript || !existingScript.script) {
        console.log(`[VIDEO_CTRL] No script found, generating script for projectId=${projectId}...`);
        
        // Generate script using the same service as the script generation endpoint
        const scriptResult = await AiScriptService.generateScript(projectId, {
          forceRegenerate: true, // Force generation for video
          authToken: req.headers.authorization?.split(' ')[1]
        });
        
        if (scriptResult.success && scriptResult.script) {
          console.log(`[VIDEO_CTRL] ✅ Script generated successfully for projectId=${projectId}`);
          console.log(`[VIDEO_CTRL] 🧠 SCRIPT BEFORE SAVE:`, scriptResult.script);
          console.log(`[VIDEO_CTRL] 🧠 SCRIPT LENGTH:`, scriptResult.script?.length || 0);
          
          // Verify script was actually saved to database by the service
          existingScript = await AIScript.findOne({ projectId });
          if (existingScript && existingScript.script) {
            console.log(`[VIDEO_CTRL] ✅ Script verified in aiScript collection for projectId=${projectId}`);
            console.log(`[VIDEO_CTRL] 📄 STORED SCRIPT LENGTH:`, existingScript.script?.length || 0);
          } else {
            console.error(`[VIDEO_CTRL] ❌ CRITICAL: Script not found in aiScript after generation for projectId=${projectId}`);
            return res.status(500).json({
              success: false,
              message: 'Script generation failed - script not saved to database'
            });
          }
        } else {
          console.error(`[VIDEO_CTRL] ❌ Script generation failed for projectId=${projectId}:`, scriptResult);
          return res.status(500).json({
            success: false,
            message: 'Script generation failed',
            error: scriptResult.error || 'Unknown error'
          });
        }
      } else {
        console.log(`[VIDEO_CTRL] ✅ Script already exists in aiScript collection for projectId=${projectId}`);
        console.log(`[VIDEO_CTRL] 📄 EXISTING SCRIPT LENGTH:`, existingScript.script?.length || 0);
      }
      
    } catch (scriptError) {
      console.error(`[VIDEO_CTRL] ❌ Script handling failed for projectId=${projectId}:`, scriptError);
      return res.status(500).json({
        success: false,
        message: 'Script preparation failed',
        error: scriptError.message
      });
    }

    // Create video generation job
    const jobService = new JobService();
    const job = await jobService.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: 'VIDEO_GENERATION',
      input_data: { projectId },
      priority: 5
    });

    console.log(`[VIDEO_CTRL] Video generation job created: ${job._id}`);

    // 🎯 PART 1: IMMEDIATE INSERT - Create PROCESSING video document
    console.log(`[VIDEO_CTRL] INSERT VIDEO DOC:`, { userId, projectId, jobId: job._id });
    
    try {
      const processingVideo = await AIGeneratedVideoService.saveVideo({
        userId: userId,
        projectId: projectId,
        jobId: job._id.toString(),
        videoUrl: null,
        videoFileName: null,
        status: 'PROCESSING',
        fileSize: null,
        processingTime: null,
        error: null
      });
      
      console.log(`[VIDEO_CTRL] ✅ PROCESSING video document created | videoId=${processingVideo._id} | status=PROCESSING`);
    } catch (insertError) {
      console.error(`[VIDEO_CTRL] ❌ Failed to create PROCESSING video document:`, insertError);
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize video tracking',
        error: insertError.message
      });
    }

    // Dispatch job to Video Worker immediately
    const jobDispatcher = new JobDispatcher();
    jobDispatcher.dispatchVideoGenerationJob(job).catch(error => {
      console.error(`[VIDEO_CTRL] VIDEO_GENERATION dispatch failed | jobId=${job._id}:`, error);
    });

    // Return score-only response
    const response = {
      success: true,
      jobId: job._id.toString(),
      message: 'Video generation job created and dispatched successfully'
    };

    // Validate response before sending
    ScoreOnlyResponseService.validateScoreOnlyResponse(response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[VIDEO_CTRL] Generate video error:', {
      message: error.message,
      projectId: req.body?.projectId,
      stack: error.stack
    });

    // Return appropriate error responses
    if (error.message.includes('Project not found')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }

    if (error.message.includes('FORBIDDEN CONTENT DETECTED')) {
      return res.status(500).json({
        success: false,
        message: 'Response validation failed - forbidden content detected',
        error: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to start video generation',
      error: error.message
    });
  }
};

export default {
  generateVideo,
  getVideoData  // Deprecated endpoint for backward compatibility
};
