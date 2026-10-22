import express from 'express';
import { body, validationResult } from 'express-validator';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { AIGeneratedVideoService } from '../services/aiGeneratedVideo.service.js';
import path from 'path';
import fs from 'fs';

const router = express.Router();

/**
 * GET /api/video/ai-generated/:projectId
 * Get AI-generated video for a project
 * 
 * @param {string} projectId - Project ID
 * @returns {Object} Video metadata or 404
 */
router.get('/:projectId', auth, validateProjectAccess(), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id || req.userId; // Use authenticated user from middleware

    console.log(`[VIDEO_API] Get video request | projectId=${projectId} | userId=${userId}`);

    const video = await AIGeneratedVideoService.getVideoByProject(projectId, userId);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: 'No video found for this project'
      });
    }

    return res.status(200).json({
      success: true,
      video: {
        id: video._id,
        videoUrl: video.videoUrl,
        videoFileName: video.videoFileName,
        status: video.status,
        createdAt: video.createdAt,
        fileSize: video.fileSize,
        processingTime: video.processingTime
      }
    });

  } catch (error) {
    console.error('[VIDEO_API] Get video error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve video',
      error: error.message
    });
  }
});

/**
 * GET /api/video/ai-generated
 * Get all AI-generated videos for the authenticated user
 * 
 * @query {number} [limit=10] - Limit results
 * @query {number} [skip=0] - Skip results  
 * @query {string} [status] - Filter by status (RENDERED/FAILED)
 * @returns {Array} Array of video metadata
 */
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId; // Use authenticated user from middleware
    const { limit = 10, skip = 0, status } = req.query;

    console.log(`[VIDEO_API] Get user videos request | userId=${userId} | limit=${limit} | skip=${skip} | status=${status}`);

    const videos = await AIGeneratedVideoService.getUserVideos(userId, {
      limit: parseInt(limit),
      skip: parseInt(skip),
      status
    });

    const videoData = videos.map(video => ({
      id: video._id,
      projectId: video.projectId,
      projectName: 'Unknown Project', // Not populated in test
      projectUrl: 'N/A', // Not populated in test
      videoUrl: video.videoUrl,
      videoFileName: video.videoFileName,
      status: video.status,
      createdAt: video.createdAt,
      fileSize: video.fileSize,
      processingTime: video.processingTime
    }));

    return res.status(200).json({
      success: true,
      videos: videoData,
      count: videoData.length
    });

  } catch (error) {
    console.error('[VIDEO_API] Get user videos error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve videos',
      error: error.message
    });
  }
});

/**
 * GET /api/video/ai-generated/stats
 * Get video statistics for the authenticated user
 * 
 * @returns {Object} Video statistics
 */
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId; // Use authenticated user from middleware

    console.log(`[VIDEO_API] Get user video stats request | userId=${userId}`);

    const stats = await AIGeneratedVideoService.getUserVideoStats(userId);

    return res.status(200).json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('[VIDEO_API] Get video stats error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve video statistics',
      error: error.message
    });
  }
});

/**
 * DELETE /api/video/ai-generated/:videoId
 * Delete an AI-generated video
 * 
 * @param {string} videoId - Video ID
 * @returns {Object} Success response
 */
router.delete('/:videoId', auth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.user?.id || req.userId; // Use authenticated user from middleware

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: 'videoId is required'
      });
    }

    console.log(`[VIDEO_API] Delete video request | videoId=${videoId} | userId=${userId}`);

    const deleted = await AIGeneratedVideoService.deleteVideo(videoId, userId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Video not found or you do not have permission to delete it'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Video deleted successfully'
    });

  } catch (error) {
    console.error('[VIDEO_API] Delete video error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete video',
      error: error.message
    });
  }
});

/**
 * GET /api/video/ai-generated/download/:filename
 * Download a video file securely with authentication
 * 
 * @param {string} filename - Video filename
 * @returns {File} Video file download
 */
router.get('/download/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = req.user?.id || req.userId;

    console.log(`[VIDEO_API] Download video request | filename=${filename} | userId=${userId}`);

    // Security: Validate filename parameter
    if (!filename) {
      return res.status(400).json({
        success: false,
        message: 'Filename is required'
      });
    }

    // Security: Prevent path traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      console.warn(`[VIDEO_API] Suspicious filename detected: ${filename}`);
      return res.status(400).json({
        success: false,
        message: 'Invalid filename'
      });
    }

    // Security: Only allow mp4 files with reasonable naming
    if (!filename.endsWith('.mp4') || filename.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file format or name too long'
      });
    }

    // Construct file path
    const videosDir = path.join(process.cwd(), 'public', 'videos');
    const filePath = path.join(videosDir, filename);

    console.log(`[VIDEO_API] Checking file path: ${filePath}`);

    // Security: Ensure file exists within videos directory
    if (!filePath.startsWith(videosDir)) {
      console.warn(`[VIDEO_API] Path traversal attempt detected: ${filePath}`);
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.log(`[VIDEO_API] File not found: ${filePath}`);
      return res.status(404).json({
        success: false,
        message: 'Video file not found'
      });
    }

    // Security: Verify user owns this video by checking database
    const video = await AIGeneratedVideoService.getVideoByFileName(filename, userId);
    if (!video) {
      console.warn(`[VIDEO_API] User ${userId} attempted to download unauthorized file: ${filename}`);
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to download this video'
      });
    }

    console.log(`[VIDEO_API] ✅ Download authorized for user ${userId}, file: ${filename}`);

    // Optional: Log download event
    try {
      await AIGeneratedVideoService.logDownload(video._id, userId);
    } catch (logError) {
      console.warn(`[VIDEO_API] Failed to log download:`, logError);
      // Continue with download even if logging fails
    }

    // Force file download
    res.download(filePath, filename, (err) => {
      if (err) {
        console.error(`[VIDEO_API] Download error for ${filename}:`, err);
        if (!res.headersSent) {
          return res.status(500).json({
            success: false,
            message: 'Download failed',
            error: err.message
          });
        }
      } else {
        console.log(`[VIDEO_API] ✅ Download completed: ${filename}`);
      }
    });

  } catch (error) {
    console.error('[VIDEO_API] Download video error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to download video',
        error: error.message
      });
    }
  }
});

export default router;
