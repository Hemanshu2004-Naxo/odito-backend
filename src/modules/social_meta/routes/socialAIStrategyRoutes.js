import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getAIStrategyHandler, getAIStrategyStatusHandler, generateAIStrategyHandler, previewStrategyPlanHandler } from '../controller/socialAIStrategyController.js';
import { socialAIStrategyGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';

const router = express.Router();

// GET  /api/social/ai-strategy?projectId=            current strategy + latest attempt + profile comparison
// GET  /api/social/ai-strategy/status?projectId=     generation status only (polling)
// POST /api/social/ai-strategy/generate {projectId}  start (or re-run) a generation; 202
// The strategy is read-only: there is deliberately no PUT/PATCH (it is regenerated, not hand-edited).
// Order: auth -> project access -> (generate only) rate limit, so an unauthorised call never consumes a user's budget.
router.get('/', auth, validateProjectAccess(), getAIStrategyHandler);
router.get('/status', auth, validateProjectAccess(), getAIStrategyStatusHandler);
// POST /api/social/ai-strategy/plan-preview {projectId, postsPerWeek, months, platforms}  exact planned-post count + platform states + allowance fit; no AI, no write
router.post('/plan-preview', auth, validateProjectAccess(), previewStrategyPlanHandler);
router.post('/generate', auth, validateProjectAccess(), socialAIStrategyGenerateRateLimiter, generateAIStrategyHandler);

export default router;
