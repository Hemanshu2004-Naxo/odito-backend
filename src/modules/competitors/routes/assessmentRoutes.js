import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { list, override, removeOverride, request } from '../controller/assessmentController.js';

/**
 * Mounted at /api/projects (routes/index.js). Authenticated and project-scoped. None of these routes calls a paid provider.
 *   POST   /api/projects/:projectId/competitor-assessments/request   { domains[<=50], force? }   queue an assessment for missing / stale ones
 *   GET    /api/projects/:projectId/competitor-assessments?domains=a.com,b.com                      what is stored (no request to any site)
 *   PUT    /api/projects/:projectId/competitor-assessments/override  { domain, class, note? }       the user's own decision (always wins)
 *   DELETE /api/projects/:projectId/competitor-assessments/override?domain=a.com                    remove that decision
 */
const router = express.Router();
const userKey = (req) => String(req.user?._id || 'anonymous');
const limiter = (max, message) => rateLimit({ standardHeaders: true, legacyHeaders: false, keyGenerator: userKey, windowMs: 15 * 60 * 1000, max, message: { success: false, code: 'RATE_LIMITED', message } });
const readLimiter = limiter(600, 'Too many requests. Please try again shortly.');
// Each request can make the server read up to 50 public homepages, so it has its own, much tighter limit.
const requestLimiter = limiter(40, 'Too many relevance checks. Please wait a few minutes and try again.');
const writeLimiter = limiter(120, 'Too many changes. Please wait a few minutes and try again.');

function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  return next();
}
const scoped = [auth, requireValidProjectId, validateProjectAccess()];

router.post('/:projectId/competitor-assessments/request', ...scoped, requestLimiter, request);
router.get('/:projectId/competitor-assessments', ...scoped, readLimiter, list);
router.put('/:projectId/competitor-assessments/override', ...scoped, writeLimiter, override);
router.delete('/:projectId/competitor-assessments/override', ...scoped, writeLimiter, removeOverride);

export default router;
