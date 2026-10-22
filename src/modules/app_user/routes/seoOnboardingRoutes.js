import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  generateKeywords,
  checkRanking,
  saveRanking,
  getProjectRankings,
  rescanKeyword,
  addKeywordController,
  deleteKeywordController,
  resolveWebsiteLocation
} from '../controller/seoOnboardingController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

// Apply authentication to all routes
router.use(auth);

/**
 * Per-user rate limiter for the keyword rescan endpoint.
 * 20 rescan requests per hour per authenticated user.
 * Scoped to user ID so NAT/shared networks don't block other users.
 * Skipped in non-production environments for local development.
 *
 * keyGenerator uses req.user._id directly (not req.ip) — auth middleware
 * always runs first on this router, so req.user is guaranteed to be set.
 * Avoiding req.ip prevents the ERR_ERL_KEY_GEN_IPV6 validation error in v8.
 */
const rescanRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user._id.toString(),
  message: {
    success: false,
    error: 'rescan_rate_limit_exceeded',
    message: 'Maximum 20 keyword re-scans per hour. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== 'production'
});

/**
 * Same shape as rescanRateLimiter above — Add Keyword triggers an identical
 * real DataForSEO cost per call, so it gets the same 20/hour budget. A
 * separate limiter instance (not a shared one) since they're semantically
 * different actions, matching how this file already declares one limiter
 * per rate-limited route rather than sharing state across routes.
 */
const addKeywordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user._id.toString(),
  message: {
    success: false,
    error: 'add_keyword_rate_limit_exceeded',
    message: 'Maximum 20 keyword additions per hour. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== 'production'
});

/**
 * @route   POST /api/seo/generate-keywords
 * @desc    Generate top 5 keywords for a business sub-type via DataForSEO
 * @access  Private
 * @body    { subType: string, location?: string, country?: string, language?: string }
 */
router.post('/generate-keywords', generateKeywords);

/**
 * @route   POST /api/seo/check-ranking
 * @desc    Check Google ranking position for keywords against a domain
 * @access  Private
 * @body    { domain: string, keywords: string[], location?: string, country?: string, language?: string }
 */
router.post('/check-ranking', checkRanking);

/**
 * @route   POST /api/seo/save-ranking
 * @desc    Save ranking results to seo_rankings collection
 * @access  Private
 * @body    { projectId: string, domain: string, location?: string, keywords: [{keyword,rank}] }
 */
router.post('/save-ranking', saveRanking);

/**
 * @route   GET /api/seo/rankings/:projectId
 * @desc    Get ranking results for a project (canonical doc first, archive fallback)
 * @access  Private
 * @param   projectId - Project ID
 */
router.get('/rankings/:projectId', getProjectRankings);

/**
 * @route   POST /api/seo/keywords/:projectId/rescan
 * @desc    Re-scan a single keyword and merge result into canonical ranking document
 * @access  Private
 * @param   projectId - Project ID
 * @body    { keyword: string }
 * @rateLimit 20 requests per hour per user; 30-min per-keyword cooldown enforced in controller
 */
router.post('/keywords/:projectId/rescan', rescanRateLimiter, rescanKeyword);

/**
 * @route   POST /api/seo/keywords/:projectId
 * @desc    Add one new keyword to an already-onboarded project's tracked list
 * @access  Private
 * @param   projectId - Project ID
 * @body    { keyword: string }
 * @rateLimit 20 requests per hour per user (same budget as rescan — identical DataForSEO cost)
 */
router.post('/keywords/:projectId', addKeywordRateLimiter, addKeywordController);

/**
 * @route   DELETE /api/seo/keywords/:projectId/:keyword
 * @desc    Remove one keyword from active tracking (history is preserved)
 * @access  Private
 * @param   projectId - Project ID
 * @param   keyword - URL-encoded keyword string to remove
 */
router.delete('/keywords/:projectId/:keyword', deleteKeywordController);

/**
 * @route   POST /api/seo/resolve-website-location
 * @desc    Resolve city/country from extracted website metadata (Local SEO fallback)
 * @access  Private
 * @body    { address?: string, extractedMetadata?: object }
 */
router.post('/resolve-website-location', resolveWebsiteLocation);

export default router;
