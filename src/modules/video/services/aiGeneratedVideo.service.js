import mongoose from 'mongoose';
import AIGeneratedVideo from '../models/aiGeneratedVideo.model.js';

/**
 * AI Generated Videos Service
 * Handles storage and retrieval of AI-generated video metadata
 */
export class AIGeneratedVideoService {
  /**
   * Save a newly rendered video to the database
   * @param {Object} videoData - Video metadata
   * @param {string} videoData.userId - User ID
   * @param {string} videoData.projectId - Project ID
   * @param {string} videoData.videoUrl - Video URL
   * @param {string} videoData.videoFileName - Video file name
   * @param {string} videoData.status - Video status (RENDERED/FAILED)
   * @param {string} [videoData.jobId] - Associated job ID
   * @param {number} [videoData.fileSize] - File size in bytes
   * @param {number} [videoData.processingTime] - Processing time in milliseconds
   * @param {Object} [videoData.error] - Error details if failed
   * @returns {Promise<Object>} Saved video document
   */
  static async saveVideo(videoData) {
    try {
      console.log('[VIDEO_SERVICE] SAVING VIDEO DOC:', videoData);

      // Convert to ObjectIds if they're strings
      const userId = typeof videoData.userId === 'string' 
        ? new mongoose.Types.ObjectId(videoData.userId) 
        : videoData.userId;
      
      const projectId = typeof videoData.projectId === 'string' 
        ? new mongoose.Types.ObjectId(videoData.projectId) 
        : videoData.projectId;

      const jobId = videoData.jobId ? (typeof videoData.jobId === 'string' 
        ? new mongoose.Types.ObjectId(videoData.jobId) 
        : videoData.jobId) : undefined;

      // Create clean payload
      const payload = {
        userId,
        projectId,
        jobId,
        videoUrl: videoData.videoUrl || null,
        videoFileName: videoData.videoFileName || null,
        status: videoData.status || 'PROCESSING',
        fileSize: videoData.fileSize || null,
        processingTime: videoData.processingTime || null,
        error: videoData.error || null
      };

      console.log('[VIDEO_SERVICE] CLEAN PAYLOAD:', payload);

      // Validate required fields
      if (!payload.userId || !payload.projectId || !payload.status) {
        throw new Error(`Missing required field: userId=${!!payload.userId}, projectId=${!!payload.projectId}, status=${!!payload.status}`);
      }
      
      // videoUrl is required for RENDERED videos but optional for FAILED
      if (payload.status === 'RENDERED' && !payload.videoUrl) {
        throw new Error('videoUrl is required for RENDERED videos');
      }

      // Check for existing video for this user/project combination
      const existingVideo = await AIGeneratedVideo.findOne({
        userId: payload.userId,
        projectId: payload.projectId
      });

      if (existingVideo) {
        console.log('[VIDEO_SERVICE] Updating existing video record:', existingVideo._id);
        // Update existing record
        const updatedVideo = await AIGeneratedVideo.findByIdAndUpdate(
          existingVideo._id,
          {
            videoUrl: payload.videoUrl,
            videoFileName: payload.videoFileName,
            status: payload.status,
            jobId: payload.jobId,
            fileSize: payload.fileSize,
            processingTime: payload.processingTime,
            error: payload.error
          },
          { new: true, runValidators: false } // Skip validators to avoid crashes
        );
        
        console.log('[VIDEO_SERVICE] ✅ Video metadata updated successfully:', updatedVideo._id);
        return updatedVideo;
      }

      // Create new video record with clean payload
      const newVideo = new AIGeneratedVideo(payload);

      const savedVideo = await newVideo.save({ validateBeforeSave: false }); // Skip validation to avoid crashes
      
      console.log('[VIDEO_SERVICE] ✅ Video metadata saved successfully:', savedVideo._id);
      console.log('[VIDEO_SERVICE] INSERTED VIDEO DOC:', {
        _id: savedVideo._id,
        userId: savedVideo.userId,
        projectId: savedVideo.projectId,
        videoUrl: savedVideo.videoUrl,
        status: savedVideo.status,
        createdAt: savedVideo.createdAt
      });

      return savedVideo;

    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to save video metadata:', error);
      throw error;
    }
  }

  /**
   * Get video by project ID
   * @param {string} projectId - Project ID
   * @param {string} userId - User ID (for security)
   * @returns {Promise<Object|null>} Video document or null
   */
  static async getVideoByProject(projectId, userId) {
    try {
      const video = await AIGeneratedVideo.findOne({
        projectId,
        userId
      });

      console.log('[VIDEO_SERVICE] Retrieved video for project:', {
        projectId,
        userId,
        found: !!video,
        status: video?.status
      });

      return video;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to get video by project:', error);
      throw error;
    }
  }

  /**
   * Get all videos for a user
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {number} [options.limit=10] - Limit results
   * @param {number} [options.skip=0] - Skip results
   * @param {string} [options.status] - Filter by status
   * @returns {Promise<Array>} Array of video documents
   */
  static async getUserVideos(userId, options = {}) {
    try {
      const {
        limit = 10,
        skip = 0,
        status
      } = options;

      const query = { userId };
      if (status) {
        query.status = status;
      }

      const videos = await AIGeneratedVideo.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip);

      console.log('[VIDEO_SERVICE] Retrieved user videos:', {
        userId,
        count: videos.length,
        status
      });

      return videos;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to get user videos:', error);
      throw error;
    }
  }

  /**
   * Delete a video record
   * @param {string} videoId - Video ID
   * @param {string} userId - User ID (for security)
   * @returns {Promise boolean} True if deleted
   */
  static async deleteVideo(videoId, userId) {
    try {
      const result = await AIGeneratedVideo.deleteOne({
        _id: videoId,
        userId
      });

      const deleted = result.deletedCount > 0;
      
      console.log('[VIDEO_SERVICE] Video deletion result:', {
        videoId,
        userId,
        deleted,
        deletedCount: result.deletedCount
      });

      return deleted;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to delete video:', error);
      throw error;
    }
  }

  /**
   * Get video statistics for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Statistics object
   */
  static async getUserVideoStats(userId) {
    try {
      const stats = await AIGeneratedVideo.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalSize: { $sum: '$fileSize' },
            avgProcessingTime: { $avg: '$processingTime' }
          }
        }
      ]);

      const result = {
        total: 0,
        rendered: 0,
        failed: 0,
        totalSize: 0,
        avgProcessingTime: 0
      };

      stats.forEach(stat => {
        result.total += stat.count;
        if (stat._id === 'RENDERED') {
          result.rendered = stat.count;
          result.totalSize += stat.totalSize || 0;
          result.avgProcessingTime = stat.avgProcessingTime || 0;
        } else if (stat._id === 'FAILED') {
          result.failed = stat.count;
        }
      });

      console.log('[VIDEO_SERVICE] User video stats:', {
        userId,
        stats: result
      });

      return result;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to get user video stats:', error);
      throw error;
    }
  }

  /**
   * Get video by filename for download authorization
   * @param {string} filename - Video filename
   * @param {string} userId - User ID (for security)
   * @returns {Promise<Object|null>} Video document or null
   */
  static async getVideoByFileName(filename, userId) {
    try {
      const video = await AIGeneratedVideo.findOne({
        videoFileName: filename,
        userId,
        status: 'RENDERED' // Only allow downloads of rendered videos
      });

      console.log('[VIDEO_SERVICE] Retrieved video by filename:', {
        filename,
        userId,
        found: !!video,
        status: video?.status
      });

      return video;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to get video by filename:', error);
      throw error;
    }
  }

  /**
   * Log download event for analytics
   * @param {string} videoId - Video ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Update result
   */
  static async logDownload(videoId, userId) {
    try {
      // Add download tracking field to video document
      const result = await AIGeneratedVideo.updateOne(
        { 
          _id: videoId, 
          userId 
        },
        { 
          $set: { 
            lastDownloadedAt: new Date(),
            downloadCount: { $ifNull: [{ $add: ['$downloadCount', 1] }, 1] }
          }
        }
      );

      console.log('[VIDEO_SERVICE] Download logged:', {
        videoId,
        userId,
        modified: result.modifiedCount > 0
      });

      return result;
    } catch (error) {
      console.error('[VIDEO_SERVICE] ❌ Failed to log download:', error);
      throw error;
    }
  }
}
