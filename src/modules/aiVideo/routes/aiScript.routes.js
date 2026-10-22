import express from 'express';
import { 
  generateVideo,
  getVideoData  // Deprecated endpoint for backward compatibility
} from '../controllers/aiScript.controller.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * AI Video Script Routes (DEPRECATED - Script-Based)
 * All routes require authentication
 * ⚠️ These routes are deprecated. Use /api/video routes instead.
 */

// Apply authentication middleware to all routes
router.use(auth);

/**
 * POST /api/ai-video/video
 * Generate a complete video for a project (script-free version)
 */
router.post('/video', generateVideo);

/**
 * GET /api/ai-video/data/:projectId
 * Get structured video data (DEPRECATED - use /api/video/data/:projectId)
 * @deprecated This endpoint is deprecated. Use /api/video/data/:projectId instead.
 */
router.get('/data/:projectId', getVideoData);

export default router;
