import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { generateAIContentHandler, getAIContentStatusHandler } from '../controller/socialAIContentController.js';
import { socialAIContentGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';

const router = express.Router();

// POST /api/social/ai-content/generate {projectId, platform, contentPillar, objective}   start one post generation; 202
// GET  /api/social/ai-content/status?projectId=[&generationId=]                          state of a generation (+ the saved draft)
// The product of a generation is a real SocialPublication draft that goes through the EXISTING approval
// workflow - this router has no approve / schedule / publish route and never will.
// Order: auth -> project access -> (generate only) rate limit, so an unauthorised call never consumes a user's budget.
router.post('/generate', auth, validateProjectAccess(), socialAIContentGenerateRateLimiter, generateAIContentHandler);
router.get('/status', auth, validateProjectAccess(), getAIContentStatusHandler);

export default router;
