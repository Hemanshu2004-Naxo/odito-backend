import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getBusinessInfo, saveBusinessInfo, placeSuggestions, placeDetails } from '../controller/businessInfoController.js';

/**
 * Mounted at /api/projects (routes/index.js). Authenticated and project-scoped; the project id comes only from the path.
 *   GET  /api/projects/:projectId/business-info                       identity + location + verification state
 *   PUT  /api/projects/:projectId/business-info                       { identity?, location? (needs confirmed: true) }
 *   POST /api/projects/:projectId/business-info/places/autocomplete   { input, sessionToken }   Google Places (billed per typing session)
 *   POST /api/projects/:projectId/business-info/places/details        { placeId, sessionToken } Google Places (one call per picked place)
 */
const router = express.Router();
const userKey = (req) => String(req.user?._id || 'anonymous');
const limiter = (max, message) => rateLimit({ standardHeaders: true, legacyHeaders: false, keyGenerator: userKey, windowMs: 15 * 60 * 1000, max, message: { success: false, code: 'RATE_LIMITED', message } });
const readLimiter = limiter(300, 'Too many requests. Please try again shortly.');
const writeLimiter = limiter(60, 'Too many changes. Please wait a few minutes and try again.');
// These two reach a paid provider, so they are tighter than anything else here.
const suggestLimiter = limiter(300, 'Too many address searches. Please wait a few minutes and try again.');
const detailsLimiter = limiter(60, 'Too many address lookups. Please wait a few minutes and try again.');

function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  return next();
}
const scoped = [auth, requireValidProjectId, validateProjectAccess()];

router.get('/:projectId/business-info', ...scoped, readLimiter, getBusinessInfo);
router.put('/:projectId/business-info', ...scoped, writeLimiter, saveBusinessInfo);
router.post('/:projectId/business-info/places/autocomplete', ...scoped, suggestLimiter, placeSuggestions);
router.post('/:projectId/business-info/places/details', ...scoped, detailsLimiter, placeDetails);

export default router;
