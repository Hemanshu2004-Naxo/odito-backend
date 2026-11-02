import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { options, search } from '../controller/localController.js';

/**
 * Mounted at /api/projects (routes/index.js). Authenticated and project-scoped.
 *   GET  /api/projects/:projectId/local-competitors/options   radii, search centre, suggested categories (no Google request)
 *   POST /api/projects/:projectId/local-competitors/search    one explicit search: { radiusKm?, queries?, types?, geocode? }
 */
const router = express.Router();
const userKey = (req) => String(req.user?._id || 'anonymous');
const limiter = (max, message) => rateLimit({ standardHeaders: true, legacyHeaders: false, keyGenerator: userKey, windowMs: 15 * 60 * 1000, max, message: { success: false, code: 'RATE_LIMITED', message } });
const readLimiter = limiter(300, 'Too many requests. Please try again shortly.');
// Every search is billed by Google: a tight per-user limit on top of the per-project daily budget.
const searchLimiter = limiter(15, 'Too many local searches. Please wait a few minutes and try again.');

function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  return next();
}
const scoped = [auth, requireValidProjectId, validateProjectAccess()];

router.get('/:projectId/local-competitors/options', ...scoped, readLimiter, options);
router.post('/:projectId/local-competitors/search', ...scoped, searchLimiter, search);

export default router;
