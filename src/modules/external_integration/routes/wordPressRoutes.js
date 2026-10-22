import express from 'express';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  connectWordPressValidator,
  projectIdQueryValidator,
  projectIdBodyValidator,
  pageSeoDataValidator,
  h1ContextValidator,
} from '../validator/wordPressValidator.js';
import {
  connectWordPress,
  getConnectionStatus,
  verifyConnection,
  disconnectConnection,
  getCapabilities,
  getPageSeoData,
  getSiteSchema,
  getH1Context,
  getPageResolution,
} from '../controller/wordPressController.js';

const router = express.Router();

router.use(auth);

// User-click-driven (JWT-authenticated dashboard traffic), unlike the
// plugin's machine-to-machine limiters in wordPressPluginRoutes.js — bounds
// a runaway frontend polling loop rather than genuine per-request abuse.
// getPageSeoData is the tighter of the two: it makes a live outbound call
// to the customer's WordPress site on every request, so it's throttled
// closer to what a human clicking through issue pages would generate.
const capabilitiesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.' },
});

const seoDataLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.', code: 'RATE_LIMITED' },
});

// projectId travels in the body/query on every one of these routes (a
// WordPressConnection is looked up BY projectId, never by its own id), so
// ownership can always be checked up front by the shared middleware — no
// :id-only inline-ownership split needed here, unlike leadRoutes.js.
router.post('/connect', connectWordPressValidator, validateProjectAccess(), connectWordPress);
router.get('/status', projectIdQueryValidator, validateProjectAccess(), getConnectionStatus);
router.post('/verify', projectIdBodyValidator, validateProjectAccess(), verifyConnection);
router.delete('/disconnect', projectIdQueryValidator, validateProjectAccess(), disconnectConnection);

// Phase 4, Step 1-2 (locked architecture) — read + capability detection only.
router.get('/capabilities', capabilitiesLimiter, projectIdQueryValidator, validateProjectAccess(), getCapabilities);
router.get('/seo-data', seoDataLimiter, pageSeoDataValidator, validateProjectAccess(), getPageSeoData);
// Site-scoped schema (Organization sameAs, breadcrumbs) — same live-read
// cost profile as seo-data (one outbound call to the customer's site), so
// shares its tighter limiter.
// URL -> WordPress page/post resolution (shared resolver) — one to three outbound reads.
router.get('/page-resolution', seoDataLimiter, pageSeoDataValidator, validateProjectAccess(), getPageResolution);
router.get('/site-schema', seoDataLimiter, projectIdQueryValidator, validateProjectAccess(), getSiteSchema);
// Page-content (H1) fix eligibility — reads the page's stored content and rendered HTML from the
// customer's site (two outbound calls), so it shares the tighter limiter. Read-only.
router.get('/h1-context', seoDataLimiter, h1ContextValidator, validateProjectAccess(), getH1Context);

export default router;
