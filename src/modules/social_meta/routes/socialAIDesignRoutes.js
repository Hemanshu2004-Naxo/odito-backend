import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  generateAIDesignHandler, getAIDesignStatusHandler, getStudioHandler, studioGenerateHandler, studioRegenerateHandler, studioSelectHandler,
} from '../controller/socialAIDesignController.js';
import { socialAIDesignGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';

const router = express.Router();

// POST /api/social/ai-design/generate {projectId, publicationId, contentVersion[, replaceApproved]}   start one design generation; 202
// GET  /api/social/ai-design/status?projectId&publicationId[&generationId]                            state of a generation (+ the real publication)
// The product of a generation is media on an EXISTING SocialPublication that then goes through the existing
// design approval - this router has no approve / schedule / publish route and never will.
// Order: auth -> project access -> (generate only) rate limit, so an unauthorised call never consumes a user's budget.
router.post('/generate', auth, validateProjectAccess(), socialAIDesignGenerateRateLimiter, generateAIDesignHandler);
router.get('/status', auth, validateProjectAccess(), getAIDesignStatusHandler);

// Creative Studio. The same pipeline and record: candidates are stored but are NOT the post's design until /studio/select attaches one through the
// versioned attach (to Design Review). There is still no approve / schedule / publish route here. The two AI routes share the design rate limit.
router.get('/studio', auth, validateProjectAccess(), getStudioHandler);
router.post('/studio/generate', auth, validateProjectAccess(), socialAIDesignGenerateRateLimiter, studioGenerateHandler);
router.post('/studio/regenerate', auth, validateProjectAccess(), socialAIDesignGenerateRateLimiter, studioRegenerateHandler);
router.post('/studio/select', auth, validateProjectAccess(), studioSelectHandler);

export default router;
