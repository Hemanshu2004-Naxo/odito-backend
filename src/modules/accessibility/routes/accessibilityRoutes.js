import express from 'express';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { getAccessibilityIssues } from '../controller/accessibilityController.js';
import { fastAccessibilityAuditController } from '../controller/fastAccessibilityController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Rate limiter for fast accessibility audit
 * 20 requests per 15 minutes per IP
 */
const a11yAuditRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many audit requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: (req) => {
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.hostname === 'localhost';
    return isLocalhost && process.env.NODE_ENV !== 'production';
  }
});

/**
 * POST /api/accessibility/fast-audit
 * Fast accessibility audit using Puppeteer + axe-core
 * No authentication required
 * 
 * Body: { url: string }
 * 
 * Returns:
 * - success: boolean
 * - data: { accessibility_score, issues, landmarks, axe_details, execution_time_ms }
 */
router.post('/fast-audit', [
  body('url')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Valid HTTP or HTTPS URL is required')
    .trim()
    .notEmpty()
    .withMessage('URL cannot be empty')
],
  a11yAuditRateLimiter,
  fastAccessibilityAuditController
);

/**
 * GET /api/accessibility/issues
 * Fetch accessibility issues with optional filters
 * 🔒 SECURITY: Requires authentication
 * 
 * Query params:
 * - projectId (optional): Filter by project ID
 * - seo_jobId (optional): Filter by SEO job ID
 * - severity (optional): Filter by severity (high, medium, low)
 * 
 * Returns:
 * - success: boolean
 * - total: number
 * - issues: array of accessibility issues
 */
router.get('/issues', auth, async (req, res) => {
  try {
    const { projectId, seo_jobId, severity } = req.query;

    const result = await getAccessibilityIssues({ projectId, seo_jobId, severity });

    res.json({
      success: true,
      total: result.issues.length,
      issues: result.issues,
      summary: result.summary
    });

  } catch (error) {
    console.error('[Accessibility API] Error fetching issues:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch accessibility issues',
      error: error.message
    });
  }
});

export default router;
