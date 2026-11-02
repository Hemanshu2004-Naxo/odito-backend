import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { addFromDiscovery, create, details, list, refresh, remove, update } from '../controller/myCompetitorsController.js';

/**
 * Mounted at /api/projects (routes/index.js). Authenticated and project-scoped.
 *   GET    /api/projects/:projectId/my-competitors         the project's chosen competitors
 *   POST   /api/projects/:projectId/my-competitors         add one   { name?, domain?, address?, placeId?, notes?, source? }
 *   POST   /api/projects/:projectId/my-competitors/discovered   add a business found in the SEO list / Local Competitors (merged, never duplicated)
 *   GET    /api/projects/:projectId/my-competitors/:competitorId     one competitor with everything stored (no provider call)
 *   POST   /api/projects/:projectId/my-competitors/:competitorId/refresh   queue a manual SEO refresh (202)
 *   PATCH  /api/projects/:projectId/my-competitors/:competitorId     edit one
 *   DELETE /api/projects/:projectId/my-competitors/:competitorId     remove one
 */
const router = express.Router();

const userKey = (req) => String(req.user?._id || 'anonymous');
const limiter = (max, message) => rateLimit({
  standardHeaders: true, legacyHeaders: false, keyGenerator: userKey, windowMs: 15 * 60 * 1000, max,
  message: { success: false, code: 'RATE_LIMITED', message },
});
const readLimiter = limiter(600, 'Too many requests. Please try again shortly.');
const writeLimiter = limiter(120, 'Too many changes. Please wait a few minutes and try again.');
// A refresh queues paid provider calls, so it has its own, much tighter limit (the per-competitor cool-down is enforced by the service).
const refreshLimiter = limiter(30, 'Too many refreshes. Please wait a few minutes and try again.');

function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  }
  return next();
}

const scoped = [auth, requireValidProjectId, validateProjectAccess()];
router.get('/:projectId/my-competitors', ...scoped, readLimiter, list);
router.post('/:projectId/my-competitors', ...scoped, writeLimiter, create);
router.post('/:projectId/my-competitors/discovered', ...scoped, writeLimiter, addFromDiscovery);
// The competitor's id is `:competitorId`, NOT `:id`: validateProjectAccess() reads `req.params.id` before `req.params.projectId`, so a
// route param called `id` would be looked up as a PROJECT id (and answer 404 for every edit and remove).
router.get('/:projectId/my-competitors/:competitorId', ...scoped, readLimiter, details);
router.post('/:projectId/my-competitors/:competitorId/refresh', ...scoped, refreshLimiter, refresh);
router.patch('/:projectId/my-competitors/:competitorId', ...scoped, writeLimiter, update);
router.delete('/:projectId/my-competitors/:competitorId', ...scoped, writeLimiter, remove);

export default router;
