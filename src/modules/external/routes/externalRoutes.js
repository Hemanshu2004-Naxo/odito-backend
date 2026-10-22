import express from 'express';
import { externalOnboardController, homepageAuditController, homepagePageSpeedController, localSeoController, patchHomepageAuditController, generateHomepageAuditVideoController, getHomepageAuditVideoController, discoverBusinessController, searchBusinessCandidatesController } from '../controller/externalController.js';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';

const router = express.Router();

/**
 * Rate limiter for homepage audit endpoint
 * 20 requests per 15 minutes per IP (increased from 5)
 */
const auditRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per window (increased from 5)
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many audit requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // Add logging for rate limit tracking
  handler: (req, res) => {
    console.log(`[RATE LIMIT] Blocked IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);
    res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      message: 'Too many audit requests. Please try again later.'
    });
  },
  // Skip rate limiting for localhost in development
  skip: (req) => {
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.hostname === 'localhost';
    if (isLocalhost && process.env.NODE_ENV !== 'production') {
      console.log(`[RATE LIMIT] Skipping for localhost: ${req.ip}`);
      return true;
    }
    return false;
  }
});

/**
 * Rate limiter for public business discovery (each call can hit billable
 * Places API). The UI debounces, so a normal user stays far below this.
 * 30 requests per minute per IP; skipped for localhost outside production.
 */
const businessSearchRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many searches. Please wait a moment and try again.'
    });
  },
  skip: (req) => {
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    return isLocalhost && process.env.NODE_ENV !== 'production';
  }
});

/**
 * POST /external/local-seo
 * Fetch local SEO data using Google Places API
 * No authentication required
 * Body: { businessName: string, location: string, scrapedData?: object }
 */
router.post('/local-seo',
  [
    body('businessName')
      .trim()
      .notEmpty()
      .withMessage('Business name is required'),
    body('location')
      .trim()
      .notEmpty()
      .withMessage('Location is required')
  ],
  localSeoController
);

/**
 * POST /external/discover-business
 * Lightweight business discovery from a URL (cheerio-based, no full audit).
 * No authentication required.
 * Body: { url: string }
 */
router.post('/discover-business',
  [body('url').trim().notEmpty().withMessage('URL is required')],
  discoverBusinessController
);

/**
 * POST /external/search-businesses
 * Returns up to 4 Google Places candidates for business name autocomplete.
 * No authentication required (public Places discovery; no Google account needed).
 * Body: { query: string (2-120 chars), location?: string }
 * Validation + error mapping live in the controller.
 */
router.post('/search-businesses',
  businessSearchRateLimiter,
  searchBusinessCandidatesController
);

/**
 * POST /external/onboard
 * External onboarding endpoint - accepts only email
 * No authentication required
 */
router.post('/onboard',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required')
  ],
  externalOnboardController
);

/**
 * POST /external/audit/free
 * Free homepage audit endpoint
 * No authentication required
 * Rate limited: 5 requests per 15 minutes
 */
router.post('/audit/free',
  [
    body('url')
      .isURL({ protocols: ['http', 'https'], require_protocol: true })
      .withMessage('Valid HTTP or HTTPS URL is required')
      .trim()
      .notEmpty()
      .withMessage('URL cannot be empty')
  ],
  auditRateLimiter,
  homepageAuditController
);

/**
 * POST /external/homepage-audit
 * Homepage audit endpoint - matches frontend API call
 * No authentication required
 */
router.post('/homepage-audit', [
  body('url')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Valid HTTP or HTTPS URL is required')
    .trim()
    .notEmpty()
    .withMessage('URL cannot be empty')
],
  auditRateLimiter,
  homepageAuditController
);

/**
 * PATCH /external/homepage-audit/:id
 * Update homepage audit snapshot after async tasks complete (performance, accessibility).
 * No authentication required — audit_id is the opaque token.
 */
router.patch('/homepage-audit/:id', patchHomepageAuditController);

/**
 * POST /external/homepage-audit-video
 * Initiate Homepage Audit video generation from the stored snapshot.
 * GET  /external/homepage-audit-video/:auditId
 * Poll video generation status.
 * No authentication required — auditId is the opaque token.
 */
router.post('/homepage-audit-video', generateHomepageAuditVideoController);
router.get('/homepage-audit-video/:auditId', getHomepageAuditVideoController);

/**
 * POST /external/homepage-pagespeed
 * Homepage PageSpeed endpoint - matches frontend API call
 * No authentication required
 */
router.post('/homepage-pagespeed', [
  body('url')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Valid HTTP or HTTPS URL is required')
    .trim()
    .notEmpty()
    .withMessage('URL cannot be empty')
],
  auditRateLimiter,
  homepagePageSpeedController
);

export default router;
