import express from 'express';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess, requireAdmin } from '../../../middleware/auth.middleware.js';
import {
  generateRecommendation,
  invalidateByRule,
  invalidateByProject,
  getStats,
  purgeFallbacks,
  getRecommendationById,
  regenerateBreadcrumbHierarchy,
  confirmOrganizationAddress,
} from '../controller/recommendationController.js';
import { discoverSameAs, validateSameAsUrls, previewSameAs } from '../controller/sameAsController.js';
import investigationRoutes from '../../ai-investigation/routes/investigationRoutes.js';
import { discoverBreadcrumbTrail, classifyBreadcrumbPages } from '../controller/breadcrumbController.js';

const router = express.Router();

// All recommendation routes require authentication
router.use(auth);

// Universal evidence-driven investigation engine (additive; /generate below is unchanged). See modules/ai-investigation/.
router.use(investigationRoutes);

// Generate or retrieve a recommendation (main endpoint) — projectId in body
router.post('/generate', validateProjectAccess(), generateRecommendation);

// Owner-confirmed breadcrumb hierarchy -> deterministic BreadcrumbList recommendation. Authenticated, project-scoped
// (projectId in the body is verified against the user), validated server-side; starts no audit and no job.
router.post('/breadcrumb-hierarchy', validateProjectAccess(), regenerateBreadcrumbHierarchy);

// Owner-confirmed business address -> the Organization address recommendation. Same guarantees as above: authenticated,
// project-scoped, validated server-side, starts no audit or job and does not modify the website.
router.post('/organization-address', validateProjectAccess(), confirmOrganizationAddress);

// Organization sameAs: discover the organization's own profile links on the site (a bounded number of same-site page fetches),
// validate the owner's typed links, preview the exact change. Read-only: nothing is written to WordPress and no credit is used.
// Authenticated and project-scoped like everything above; throttled because discovery makes outbound same-site requests.
const sameAsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.', code: 'RATE_LIMITED' },
});
router.post('/same-as/discovery', sameAsLimiter, validateProjectAccess(), discoverSameAs);
router.post('/same-as/validate', sameAsLimiter, validateProjectAccess(), validateSameAsUrls);
router.post('/same-as/preview', sameAsLimiter, validateProjectAccess(), previewSameAs);

// Breadcrumb discovery: what trail does this page really have (or can honestly be offered)? Read-only, project-scoped, throttled because it
// makes a few same-site page requests. Nothing is written to WordPress and no credit is used.
router.post('/breadcrumb/discovery', sameAsLimiter, validateProjectAccess(), discoverBreadcrumbTrail);
router.post('/breadcrumb/pages', sameAsLimiter, validateProjectAccess(), classifyBreadcrumbPages);

// Invalidate-by-project also carries a projectId to check; invalidate-by-rule
// and purge-fallbacks have no projectId on the request at all (rule-scoped /
// platform-wide respectively) so they're gated by role instead of ownership.
router.post('/invalidate/rule', requireAdmin(), invalidateByRule);
router.post('/invalidate/project', validateProjectAccess(), invalidateByProject);

// Purge poisoned fallback cache (one-time cleanup) — platform-wide when
// projectId is omitted, so admin-only.
router.post('/purge-fallbacks', requireAdmin(), purgeFallbacks);

// Stats endpoint
router.get('/stats/:projectId', validateProjectAccess(), getStats);

// Generic get-by-id — must stay LAST among GET routes so it never shadows
// the more specific /stats/:projectId above. Deliberately NOT named :id —
// validateProjectAccess() checks req.params.id FIRST (before
// req.query.projectId), designed for routes where :id IS the project's own
// id (there are none of those in this router); naming it :recommendationId
// avoids that collision, confirmed by a live repro that a plain :id here
// makes the middleware try to validate project access using the
// RECOMMENDATION's id and fail with a Mongoose cast error before this
// route's own controller — which does the real ownership check — is ever
// reached.
router.get('/:recommendationId', validateProjectAccess(), getRecommendationById);

export default router;
