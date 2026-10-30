import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../../middleware/auth.middleware.js';
import { getSection } from '../controller/domainOverviewController.js';
import { exportBacklinks } from '../controller/backlinksExportController.js';
import { getSettings as getAnchorSettings, putSettings as putAnchorSettings } from '../controller/anchorSettingsController.js';
import { exportReferringDomains } from '../controller/referringDomainsExportController.js';
import { exportTopPages } from '../controller/topPagesExportController.js';
import { getSettings as getDomainLists, patchSettings as patchDomainLists } from '../controller/domainListController.js';
import {
  addExcluded, addTracked, getSettings, removeExcluded, removeTracked,
} from '../controller/competitorSettingsController.js';
import { hasRankedKeywordsParams } from '../validator/rankedKeywordsQuery.js';
import { hasBacklinksParams } from '../validator/backlinksQuery.js';
import { hasCompetitorsParams } from '../validator/competitorsQuery.js';
import {
  REFRESH_LIMIT, RANKED_KEYWORDS_QUERY_LIMIT, COMPETITORS_QUERY_LIMIT, BACKLINKS_QUERY_LIMIT, BULK_TRAFFIC_LIMIT, COMPETITOR_SETTINGS_WRITE_LIMIT,
  BACKLINKS_LIST_LIMIT, BACKLINKS_EXPORT_LIMIT, ANCHORS_QUERY_LIMIT, ANCHOR_SETTINGS_WRITE_LIMIT,
  REFERRING_DOMAINS_QUERY_LIMIT, REFERRING_DOMAINS_EXPORT_LIMIT, DOMAIN_LISTS_WRITE_LIMIT, DOMAIN_PAGES_QUERY_LIMIT, TOP_PAGES_EXPORT_LIMIT,
} from '../config.js';

/**
 * Mounted at /api/projects (routes/index.js):
 *   GET /api/projects/:projectId/domain-overview/:section        one section of the page (cached; `?refresh=1` skips the cache)
 * section = rank-overview | history | ranked-keywords | competitors | backlinks | backlinks-list | anchors | anchor-profile | referring-domains |
 *           rd-rank-buckets | rd-toxic-count | rd-last-30 | domain-pages | tp-counts | tp-fix-first | top-pages-traffic | bulk-traffic. Authenticated and project-scoped.
 * Auth is applied per route (not router.use) because this router shares the /projects mount with other routers.
 *   GET    /api/projects/:projectId/backlinks-export                            the Backlinks page's "export with current filters" (streamed CSV)
 *   GET    /api/projects/:projectId/top-pages-export                            the Top Pages page's "export with current filters" (streamed CSV)
 *   GET    /api/projects/:projectId/referring-domains-export                    the Referring Domains page's "export with current filters" (streamed CSV)
 *   GET|PATCH /api/projects/:projectId/referring-domain-settings                the project's disavowed + reviewed domain lists
 *   GET|PUT /api/projects/:projectId/anchor-settings                            the project's saved brand terms + target keywords
 *   GET    /api/projects/:projectId/competitor-settings                         the project's tracked + excluded competitor lists
 *   POST   /api/projects/:projectId/competitor-settings/tracked | excluded      add domain(s)
 *   DELETE /api/projects/:projectId/competitor-settings/tracked | excluded/:domain
 */
const router = express.Router();

// Keyed by user (auth has already run), so one user cannot spend provider credits from several IPs.
const userKey = (req) => String(req.user?._id || 'anonymous');
const limiterOptions = { standardHeaders: true, legacyHeaders: false, keyGenerator: userKey };

const readLimiter = rateLimit({
  ...limiterOptions,
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
});

// Only cache-skipping requests can cost money, so only they count against this tighter limit.
const refreshLimiter = rateLimit({
  ...limiterOptions,
  windowMs: REFRESH_LIMIT.windowMs,
  max: REFRESH_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many refreshes. Please wait a few minutes and try again.' },
});
const limitRefreshes = (req, res, next) => (['1', 'true'].includes(String(req.query.refresh)) ? refreshLimiter(req, res, next) : next());

// Every distinct page / sort / filter of the ranked keywords is a distinct paid provider call, so those requests (and only those) get
// their own per-user limit; the dashboard's plain top-5 request is not counted.
const queryLimiter = rateLimit({
  ...limiterOptions,
  windowMs: RANKED_KEYWORDS_QUERY_LIMIT.windowMs,
  max: RANKED_KEYWORDS_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many keyword searches. Please wait a few minutes and try again.' },
});
const limitKeywordQueries = (req, res, next) => (
  req.params.section === 'ranked-keywords' && hasRankedKeywordsParams(req.query) ? queryLimiter(req, res, next) : next()
);

// Competitors: every distinct page / sort / filter / toggle is a distinct paid call; the default view (the dashboard card's) is not counted.
const competitorsLimiter = rateLimit({
  ...limiterOptions,
  windowMs: COMPETITORS_QUERY_LIMIT.windowMs,
  max: COMPETITORS_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many competitor searches. Please wait a few minutes and try again.' },
});
const limitCompetitorQueries = (req, res, next) => (
  req.params.section === 'competitors' && hasCompetitorsParams(req.query) ? competitorsLimiter(req, res, next) : next()
);

// Lost / All / Dofollow only are distinct paid calls (at most 6 combinations, each cached); the default view is not counted.
const backlinksLimiter = rateLimit({
  ...limiterOptions,
  windowMs: BACKLINKS_QUERY_LIMIT.windowMs,
  max: BACKLINKS_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many backlink searches. Please wait a few minutes and try again.' },
});
const limitBacklinkQueries = (req, res, next) => (
  req.params.section === 'backlinks' && hasBacklinksParams(req.query) ? backlinksLimiter(req, res, next) : next()
);

// Backlinks list: every page / tab / sort / filter is a distinct paid call (cache hits count too). Only the plain default view is free of it.
const backlinksListLimiter = rateLimit({
  ...limiterOptions,
  windowMs: BACKLINKS_LIST_LIMIT.windowMs,
  max: BACKLINKS_LIST_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many backlink searches. Please wait a few minutes and try again.' },
});
const limitBacklinksList = (req, res, next) => (req.params.section === 'backlinks-list' ? backlinksListLimiter(req, res, next) : next());

// Anchors: every page / status / sort / filter is a distinct paid call (cache hits count too). The profile is one fixed request, free of it.
const anchorsLimiter = rateLimit({
  ...limiterOptions,
  windowMs: ANCHORS_QUERY_LIMIT.windowMs,
  max: ANCHORS_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many anchor searches. Please wait a few minutes and try again.' },
});
const limitAnchors = (req, res, next) => (req.params.section === 'anchors' ? anchorsLimiter(req, res, next) : next());

const anchorSettingsWriteLimiter = rateLimit({
  ...limiterOptions,
  windowMs: ANCHOR_SETTINGS_WRITE_LIMIT.windowMs,
  max: ANCHOR_SETTINGS_WRITE_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes. Please wait a few minutes and try again.' },
});

// Referring domains: every page / status / sort / filter is a distinct paid call (cache hits count too). The two profile-level count cards are
// NOT limited here: they have their own budget of REAL provider calls (service/providerBudget.js), so a cache hit never uses it.
const referringDomainsLimiter = rateLimit({
  ...limiterOptions,
  windowMs: REFERRING_DOMAINS_QUERY_LIMIT.windowMs,
  max: REFERRING_DOMAINS_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many referring-domain searches. Please wait a few minutes and try again.' },
});
const limitReferringDomains = (req, res, next) => (req.params.section === 'referring-domains' ? referringDomainsLimiter(req, res, next) : next());

// Top pages: every page / sort / filter is a distinct paid call (cache hits count too). The headline counts, "Fix first" and the traffic join have their own
// budget of REAL provider calls (service/providerBudget.js), so a cache hit never uses it.
const topPagesLimiter = rateLimit({
  ...limiterOptions,
  windowMs: DOMAIN_PAGES_QUERY_LIMIT.windowMs,
  max: DOMAIN_PAGES_QUERY_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many page searches. Please wait a few minutes and try again.' },
});
const limitTopPages = (req, res, next) => (req.params.section === 'domain-pages' ? topPagesLimiter(req, res, next) : next());

const topPagesExportLimiter = rateLimit({
  ...limiterOptions,
  windowMs: TOP_PAGES_EXPORT_LIMIT.windowMs,
  max: TOP_PAGES_EXPORT_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many exports. Please wait a few minutes and try again.' },
});

const referringDomainsExportLimiter = rateLimit({
  ...limiterOptions,
  windowMs: REFERRING_DOMAINS_EXPORT_LIMIT.windowMs,
  max: REFERRING_DOMAINS_EXPORT_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many exports. Please wait a few minutes and try again.' },
});

const domainListsWriteLimiter = rateLimit({
  ...limiterOptions,
  windowMs: DOMAIN_LISTS_WRITE_LIMIT.windowMs,
  max: DOMAIN_LISTS_WRITE_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes. Please wait a few minutes and try again.' },
});

// A big export buys up to 10 batches: a small limit of its own.
const exportLimiter = rateLimit({
  ...limiterOptions,
  windowMs: BACKLINKS_EXPORT_LIMIT.windowMs,
  max: BACKLINKS_EXPORT_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many exports. Please wait a few minutes and try again.' },
});

// Every distinct set of compared domains is a distinct paid call.
const bulkTrafficLimiter = rateLimit({
  ...limiterOptions,
  windowMs: BULK_TRAFFIC_LIMIT.windowMs,
  max: BULK_TRAFFIC_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many comparisons. Please wait a few minutes and try again.' },
});
const limitBulkTraffic = (req, res, next) => (req.params.section === 'bulk-traffic' ? bulkTrafficLimiter(req, res, next) : next());

const settingsWriteLimiter = rateLimit({
  ...limiterOptions,
  windowMs: COMPETITOR_SETTINGS_WRITE_LIMIT.windowMs,
  max: COMPETITOR_SETTINGS_WRITE_LIMIT.max,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes. Please wait a few minutes and try again.' },
});

// validateProjectAccess() would 500 on a malformed id (Mongoose CastError); reject it as a 400 first.
function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  }
  return next();
}

router.get(
  '/:projectId/domain-overview/:section',
  auth, readLimiter, requireValidProjectId, validateProjectAccess(), limitRefreshes, limitKeywordQueries, limitCompetitorQueries, limitBacklinkQueries, limitBacklinksList, limitAnchors, limitReferringDomains, limitTopPages, limitBulkTraffic, getSection,
);

const projectScoped = [auth, readLimiter, requireValidProjectId, validateProjectAccess()];
router.get('/:projectId/backlinks-export', ...projectScoped, exportLimiter, exportBacklinks);
router.get('/:projectId/referring-domains-export', ...projectScoped, referringDomainsExportLimiter, exportReferringDomains);
router.get('/:projectId/top-pages-export', ...projectScoped, topPagesExportLimiter, exportTopPages);
router.get('/:projectId/referring-domain-settings', ...projectScoped, getDomainLists);
router.patch('/:projectId/referring-domain-settings', ...projectScoped, domainListsWriteLimiter, patchDomainLists);
router.get('/:projectId/anchor-settings', ...projectScoped, getAnchorSettings);
router.put('/:projectId/anchor-settings', ...projectScoped, anchorSettingsWriteLimiter, putAnchorSettings);
router.get('/:projectId/competitor-settings', ...projectScoped, getSettings);
router.post('/:projectId/competitor-settings/tracked', ...projectScoped, settingsWriteLimiter, addTracked);
router.delete('/:projectId/competitor-settings/tracked/:domain', ...projectScoped, settingsWriteLimiter, removeTracked);
router.post('/:projectId/competitor-settings/excluded', ...projectScoped, settingsWriteLimiter, addExcluded);
router.delete('/:projectId/competitor-settings/excluded/:domain', ...projectScoped, settingsWriteLimiter, removeExcluded);

export default router;
