import express from 'express';
import authRoutes from '../modules/user/routes/authRoutes.js';
import oauthRoutes from '../modules/user/routes/oauth.routes.js';
import seoProjectRoutes from '../modules/app_user/routes/seoProjectRoutes.js';
import scrapingRoutes from '../modules/app_user/routes/scrapingRoutes.js';
import seoOnboardingRoutes from '../modules/app_user/routes/seoOnboardingRoutes.js';
import jobRoutes from '../modules/jobs/routes/jobRoutes.js';
import workerRoutes from '../modules/jobs/routes/workerRoutes.js';
import searchConsoleRoutes from '../modules/app_user/routes/searchConsoleRoutes.js';
import analyticsRoutes from '../modules/app_user/routes/analyticsRoutes.js';
import businessProfileRoutes from '../modules/app_user/routes/businessProfileRoutes.js';
import googleAdsRoutes from '../modules/app_user/routes/googleAdsRoutes.js';
import aiCampaignRoutes from '../modules/aiCampaign/routes/aiCampaignRoutes.js';
import brandAssetRoutes from '../modules/app_user/routes/brandAssetRoutes.js';
import exportRoutes from '../modules/export/exportRoutes.js';
import keywordResearchRoutes from '../modules/keyword_research/routes/keywordResearchRoutes.js';
import pdfRoutes from '../modules/pdf/routes/pdfRoutes.js';
import aiVideoScriptRoutes from '../modules/aiVideo/routes/aiScript.routes.js';
import aiVideoRoutes from '../modules/aiVideo/routes/aiVideo.routes.js';
import videoDataRoutes from '../modules/video/routes/videoData.routes.js';
import debugRoutes from '../modules/aiVideo/routes/debug.routes.js';
import businessRoutes from '../modules/app_user/routes/businessRoutes.js';
import externalRoutes from '../modules/external/routes/externalRoutes.js';
import accessibilityRoutes from '../modules/accessibility/routes/accessibilityRoutes.js';
import recommendationRoutes from '../modules/recommendations/routes/recommendationRoutes.js';
import issueContextRoutes from '../modules/issue-context/routes/issueContextRoutes.js';
import fixLogRoutes from '../modules/fix-logs/routes/fixLogRoutes.js';
import taskRoutes from '../modules/tasks/routes/taskRoutes.js';
import auditHistoryRoutes from '../modules/audit_history/routes/auditHistoryRoutes.js';
import verificationHistoryRoutes from '../modules/verification/routes/verificationHistoryRoutes.js';
import pagespeedRoutes from '../modules/pagespeed/routes/pagespeedRoutes.js';
import aiHubRoutes from '../modules/ai_hub/routes/aiHubRoutes.js';
import aeoHubRoutes from '../modules/ai_hub/routes/aeoHubRoutes.js';
import geoHubRoutes from '../modules/ai_hub/routes/geoHubRoutes.js';
import aiPagesRoutes from '../modules/ai_hub/routes/aiPagesRoutes.js';
import homepageAuditPdfRoutes from '../modules/homepageAuditPdf/routes/homepageAuditPdfRoutes.js';
import subscriptionRoutes from '../modules/subscription/routes/subscriptionRoutes.js';
import pagePurchaseRoutes from '../modules/page_purchase/routes/pagePurchaseRoutes.js';
import creditPurchaseRoutes from '../modules/credit_purchase/routes/creditPurchaseRoutes.js';
import systemAdminRoutes from '../modules/system_admin/routes/systemAdminRoutes.js';
import leadRoutes from '../modules/lead/routes/leadRoutes.js';
import auditIqRoutes from '../modules/auditiq_requests/routes/auditIqRoutes.js';
import wordPressRoutes from '../modules/external_integration/routes/wordPressRoutes.js';
import wordPressPluginRoutes from '../modules/external_integration/routes/wordPressPluginRoutes.js';
import metaRoutes from '../modules/social_meta/routes/metaRoutes.js';
import socialAccountRoutes from '../modules/social_meta/routes/socialAccountRoutes.js';
import facebookRoutes from '../modules/social_meta/routes/facebookRoutes.js';
import instagramRoutes from '../modules/social_meta/routes/instagramRoutes.js';
import feedRoutes from '../modules/social_meta/routes/feedRoutes.js';
import socialPublishingRoutes from '../modules/social_meta/routes/socialPublishingRoutes.js';
import socialMediaRoutes from '../modules/social_meta/routes/socialMediaRoutes.js';
import socialBusinessProfileRoutes from '../modules/social_meta/routes/socialBusinessProfileRoutes.js';
import socialProductRoutes from '../modules/social_meta/routes/socialProductRoutes.js';
import socialAIStrategyRoutes from '../modules/social_meta/routes/socialAIStrategyRoutes.js';
import socialContentCalendarRoutes from '../modules/social_meta/routes/socialContentCalendarRoutes.js';
import socialAIContentRoutes from '../modules/social_meta/routes/socialAIContentRoutes.js';
import socialAIDesignRoutes from '../modules/social_meta/routes/socialAIDesignRoutes.js';
const router = express.Router();

router.use('/auth', authRoutes);
router.use('/auth/oauth', oauthRoutes);
// All project-related routes (including project data)
router.use('/app_user', seoProjectRoutes);
// Business verification routes
router.use('/app_user', businessRoutes);
// Scraping pipeline routes
router.use('/seo', scrapingRoutes);
// SEO onboarding routes (keyword generation + ranking check)
router.use('/seo', seoOnboardingRoutes);
// URL Verification history (read-only)
router.use('/seo', verificationHistoryRoutes);
// Search Console routes (matches frontend API calls)
router.use('/projects', searchConsoleRoutes);
// Analytics routes (matches frontend API calls)
router.use('/projects', analyticsRoutes);
// Business Profile routes (matches frontend API calls)
router.use('/projects', businessProfileRoutes);
// Google Ads routes (matches frontend API calls)
router.use('/projects', googleAdsRoutes);
// AI Campaign Builder — Draft foundation (Phase 1: authenticated draft CRUD
// only; no Claude generation, no Google Ads publishing yet — those are
// later phases). Additive sibling namespace to the Google Ads routes above;
// does not modify any existing Google Ads endpoint. See modules/aiCampaign/.
router.use('/google-ads/ai-campaigns', aiCampaignRoutes);
// Brand Asset Resolver routes (platform-wide logo/favicon resolution)
router.use('/projects', brandAssetRoutes);
// Job status update routes (for Python worker callbacks)
router.use('/jobs', jobRoutes);
// Worker job claiming routes
router.use('/workers', workerRoutes);
// Export routes
router.use('/export', exportRoutes);
// Keywords Research routes
router.use('/keywords', keywordResearchRoutes);
// PDF data routes
router.use('/pdf', pdfRoutes);
// AI Video Script routes (deprecated - script-based)
router.use('/ai-video', aiVideoScriptRoutes);
// AI Video routes (new - script-free)
router.use('/ai-video', aiVideoRoutes);
// Video Data routes (new - structured data only)
router.use('/video', videoDataRoutes);
// Debug routes for AI script generation
router.use('/debug', debugRoutes);
// External onboarding routes (no auth required)
router.use('/external', externalRoutes);
// Direct homepage-audit route for frontend compatibility
router.use('/', externalRoutes);
// Accessibility issues routes
router.use('/accessibility', accessibilityRoutes);
// AI Recommendation engine routes
router.use('/recommendations', recommendationRoutes);
// Issue Context Engine routes
router.use('/issue-context', issueContextRoutes);
// Fix tracking routes (deprecated — use /tasks instead)
router.use('/fix-logs', fixLogRoutes);
// Task lifecycle routes (new — replaces /fix-logs)
router.use('/tasks', taskRoutes);
// Audit history and comparison routes
router.use('/projects', auditHistoryRoutes);
// PageSpeed standalone rescan routes
router.use('/pagespeed', pagespeedRoutes);
// AISO Hub V2 routes
router.use('/aiso-hub', aiHubRoutes);
// AEO Hub V2 routes
router.use('/aeo-hub', aeoHubRoutes);
// GEO Hub V2 routes
router.use('/geo-hub', geoHubRoutes);
// AI Pages (URL-level AI issue detail) routes
router.use('/ai-pages', aiPagesRoutes);
// Homepage Audit PDF data layer (dev/debug/renderer-consumption only — no
// PDF generation route yet)
router.use('/homepage-audit-pdf', homepageAuditPdfRoutes);
// Subscription foundation: GET /subscription (auth), GET /plans (public)
router.use('/', subscriptionRoutes);
// One-time "Buy More Pages" purchases (mode: 'payment' — never a
// subscription change; see modules/page_purchase/)
router.use('/', pagePurchaseRoutes);
// One-time "Buy Credits" purchases (mode: 'payment' — never a
// subscription change; see modules/credit_purchase/)
router.use('/', creditPurchaseRoutes);
// System Admin console (roleId === 1 only; see modules/system_admin/)
router.use('/', systemAdminRoutes);
// Lead backend foundation (Phase 1 — authenticated CRUD only, no public
// capture endpoint yet; see modules/lead/)
router.use('/leads', leadRoutes);
// AuditIQ tab of the issue detail page: Express Fix / Technical Audit + Fix / Expert Fix
// requests and the availability of the strategy-call booking (see modules/auditiq_requests/)
router.use('/auditiq', auditIqRoutes);
// WordPress plugin pairing/heartbeat/form-sync (Phase 3A — structure and
// form discovery only, no submission capture yet). MUST be registered
// before the '/wordpress' mount below: wordPressRoutes applies a blanket
// `router.use(auth)` (JWT) to its entire prefix, which would otherwise
// swallow every /wordpress/plugin/* request — including /pair, which is
// deliberately NOT JWT-gated (the pairing token itself is the credential)
// — before Express ever got a chance to fall through to this more specific
// router. Express matches mounted prefixes in registration order, so the
// more specific '/wordpress/plugin' must win first.
router.use('/wordpress/plugin', wordPressPluginRoutes);
// WordPress connection layer (Phase 2 — connect/verify/status/disconnect
// only, no lead capture yet; see modules/external_integration/)
router.use('/wordpress', wordPressRoutes);
// Meta (Facebook + Instagram) OAuth foundation (Phase 1 — connection
// round-trip only: no token persistence, no Page/Instagram discovery, no
// analytics yet; see modules/social_meta/). Each route sets its own auth
// requirement individually (/start is authenticated, /callback is public
// since Meta redirects the browser here directly), so — unlike the
// WordPress mount above — there's no blanket-auth ordering hazard to
// worry about with this single mount.
router.use('/social/meta', metaRoutes);

// Real, MongoDB-sourced connection status for any connected social
// platform (Facebook/Instagram today) — the piece Phase 2/3 deferred and
// whose absence caused "Connected" to reset to "Not Connected" on every
// page refresh, since nothing previously asked the backend for real state.
router.use('/social/accounts', socialAccountRoutes);

// Real Facebook Page data (profile/posts/insights) for the dashboard —
// never fake/demo values; returns connected:false + a reason when the
// stored token is invalid or Meta has no data to give.
router.use('/social/facebook', facebookRoutes);

// Real Instagram Overview dashboard data (post count, engagements,
// followers gained, likes, comments-vs-likes chart) — replaces the
// frontend's static lib/socialMediaDummyData.js Instagram card.
router.use('/social/instagram', instagramRoutes);

// Real Facebook + Instagram Feeds (posts/media synced from Meta into
// MongoDB by socialSyncService.js) — replaces the frontend's static
// lib/socialFeedsDummyData.js. Never fake data; x/linkedin/tiktok are not
// integrated yet and report real 0 counts, never a placeholder number.
router.use('/social/feeds', feedRoutes);

// Real Facebook + Instagram publishing (drafts, scheduling, and actual
// Meta publish attempts via platformAdapters/) — see socialPublishingService.js.
router.use('/social/publishing', socialPublishingRoutes);

// Media upload for social posts (image/video -> a public HTTPS URL usable
// by the Facebook/Instagram Graph API adapters) — see mediaStorageService.js.
router.use('/social/media', socialMediaRoutes);

// Social Media AI business profile: the user-entered half (SocialBusinessProfile) layered on top of the
// existing GBP / project data by socialBusinessProfileResolver.js. No second copy of any Google data.
router.use('/social/business-profile', socialBusinessProfileRoutes);

// Social Media AI product catalog: user-entered, project-scoped products with images (SocialProduct). Part of the
// resolved business profile for product businesses. Images reuse the shared media validation + storage.
router.use('/social/products', socialProductRoutes);

// Social Media AI strategy: generated from the resolved business profile (never from a second copy of it).
// Read-only; generation is asynchronous and project-scoped. See modules/social_meta/service/aiStrategy/.
router.use('/social/ai-strategy', socialAIStrategyRoutes);

// Social Media AI content calendar: the PLAN generated from the stored strategy + the user's posts per week, platforms
// and dates (SocialContentCalendar / SocialContentCalendarItem). Planning only: it never writes captions or publishes.
router.use('/social/content-calendar', socialContentCalendarRoutes);

// Social Media AI content: ONE AI-written post -> a real SocialPublication draft that enters the existing
// content approval workflow. Writes from the stored strategy snapshot; never schedules or publishes.
router.use('/social/ai-content', socialAIContentRoutes);
router.use('/social/ai-design', socialAIDesignRoutes);

export default router;
