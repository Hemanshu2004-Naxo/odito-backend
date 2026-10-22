import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getDefaultController } from '../controller/investigationController.js';

/**
 * Mounted by recommendationRoutes.js AFTER `router.use(auth)`, so every route here is authenticated.
 * validateProjectAccess() proves the caller owns `projectId` (body or query); handlers then scope every query by it.
 * The investigation id params are deliberately NOT named `id` (see the note at the bottom of recommendationRoutes.js).
 */
const router = express.Router();

// Starting an investigation makes outbound same-site requests and a model call: throttle per user.
const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.INVESTIGATION_RATE_LIMIT ?? 40),
  keyGenerator: (req) => String(req.user?.id || req.userId || ipKeyGenerator(req.ip)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many investigations. Please try again shortly.' },
});

const lazy = (name) => (req, res, next) => getDefaultController()[name](req, res, next);

router.post('/investigations', startLimiter, validateProjectAccess(), lazy('start'));
router.get('/investigations/:investigationId', validateProjectAccess(), lazy('get'));
router.post('/investigations/:investigationId/cancel', validateProjectAccess(), lazy('cancel'));
router.post('/investigations/:investigationId/prepare-fix', startLimiter, validateProjectAccess(), lazy('prepareFix'));
router.post('/investigations/:investigationId/confirm-address', startLimiter, validateProjectAccess(), lazy('confirmAddress'));
router.post('/investigations/:investigationId/approve', startLimiter, validateProjectAccess(), lazy('approve'));
router.post('/investigations/:investigationId/verify', startLimiter, validateProjectAccess(), lazy('verify'));

export default router;
