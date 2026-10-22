/**
 * AI Video Routes (Refactored - Script-Free)
 * Routes for video generation using structured data only
 */

import express from 'express';
import { generateVideo, getVideoData } from '../controllers/aiScript.controller.js';
import { ScoreOnlyResponseService } from '../../../services/scoreOnlyResponse.service.js';

const router = express.Router();

// Apply score-only validation middleware to all routes
router.use(ScoreOnlyResponseService.scoreOnlyMiddleware);

/**
 * POST /api/ai-video/video
 * Generate a complete video for a project (script-free)
 */
router.post('/video', generateVideo);

/**
 * GET /api/ai-video/data/:projectId
 * Get structured video data (DEPRECATED - use /api/video/data/:projectId)
 * @deprecated This endpoint is deprecated. Use /api/video/data/:projectId instead.
 */
router.get('/data/:projectId', getVideoData);

export default router;
