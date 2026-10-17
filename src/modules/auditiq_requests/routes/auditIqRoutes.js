import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getIssueServiceState, createIssueServiceRequest } from '../controller/auditIqRequestController.js';

const router = express.Router();

router.use(auth);

// Keyed by user (auth has already run), so one user cannot spam requests/emails from several IPs.
const userKey = (req) => String(req.user?._id || 'anonymous');

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
});

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
});

// validateProjectAccess() would 500 on a malformed id (Mongoose CastError); reject it as a 400 first.
function requireValidProjectId(req, res, next) {
  const projectId = req.body?.projectId ?? req.query?.projectId;
  if (typeof projectId !== 'string' || !mongoose.isValidObjectId(projectId)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  }
  return next();
}

router.get('/service-requests', readLimiter, requireValidProjectId, validateProjectAccess(), getIssueServiceState);
router.post('/service-requests', createLimiter, requireValidProjectId, validateProjectAccess(), createIssueServiceRequest);

export default router;
