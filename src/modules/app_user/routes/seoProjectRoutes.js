import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess, requireAdmin } from '../../../middleware/auth.middleware.js';
import {
  createSeoProject,
  getAllSeoProjects,
  getSeoProjectById,
  updateSeoProject,
  updateSeoProjectStatus,
  deleteSeoProject,
  getTrashedProjects,
  getTrashedProjectById,
  restoreProject,
  permanentlyDeleteProject,
  getProjectScrapingSummary,
  getProjectsNeedingScrape,
  getProjectDashboard,
  getIssueCounts,
  getProjectOverview
} from '../controller/seoProjectController.js';
import {
  getProjectLinks,
  getProjectPages,
  getProjectPerformance,
  getProjectSummary,
  getProjectIssues,
  getProjectIssuesByPage,
  getPageIssues,
  getOnPageIssues,
  getAIVisibilityPage,
  getAIVisibilityPages,
  getAIVisibilityWorstPages,
  getAIVisibilityEntityGraph,
  getIssueUrls,
  getTechnicalChecks,
  getTechnicalCheckDetail,
  getProjectPreAudit
} from '../controller/projectDataController.js';
import { getUrlPool, submitUrlSelection, getPageFailures } from '../controller/urlSelectionController.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(auth);

// Project routes
router.post('/projects', createSeoProject);
router.get('/projects', getAllSeoProjects);

// Trash routes — must be registered BEFORE '/projects/:id' or Express would
// match '/projects/trash' as that route with id='trash'. Not behind
// validateProjectAccess(): that middleware now excludes trashed projects
// (see AuthUtil.validateProjectAccess), which is the opposite of what these
// two endpoints need — they each do their own is_deleted:true-scoped lookup.
router.get('/projects/trash', getTrashedProjects);
router.get('/projects/trash/:id', getTrashedProjectById);
router.post('/projects/trash/:id/restore', restoreProject);
router.delete('/projects/trash/:id/permanent', permanentlyDeleteProject);

router.get('/projects/:id', validateProjectAccess(), getSeoProjectById);
router.put('/projects/:id', validateProjectAccess(), updateSeoProject);
router.patch('/projects/:id/status', validateProjectAccess(), updateSeoProjectStatus);
router.delete('/projects/:id', validateProjectAccess(), deleteSeoProject);

// Scraping-related routes
router.get('/projects/:id/scraping-summary', validateProjectAccess(), getProjectScrapingSummary);
// 🔒 SECURITY: was previously reachable by any authenticated user and returned
// every user's projects due for a scrape (cross-user data leak). The Weekly
// Recrawl scheduler no longer calls this over HTTP at all — it calls
// SeoProject.getProjectsNeedingScrape() directly in-process (see
// jobs/service/weeklyRecheckScheduler.js). This route is kept only for
// admin/ops visibility, now gated accordingly.
router.get('/projects-needing-scrape', requireAdmin(), getProjectsNeedingScrape);

// NEW: Optimized dashboard routes
router.get('/projects/:id/overview', validateProjectAccess(), getProjectOverview);
router.get('/projects/:id/issue-counts', validateProjectAccess(), getIssueCounts);

// Project data display routes
router.get('/projects/:id/links', validateProjectAccess(), getProjectLinks);
router.get('/projects/:id/pages', validateProjectAccess(), getProjectPages);
router.get('/projects/:id/performance', validateProjectAccess(), getProjectPerformance);
router.get('/projects/:id/summary', validateProjectAccess(), getProjectSummary);
router.get('/projects/:id/dashboard', validateProjectAccess(), getProjectDashboard);
router.get('/projects/:id/issues', validateProjectAccess(), getProjectIssues);
router.get('/projects/:id/issues-by-page', validateProjectAccess(), getProjectIssuesByPage);
router.get('/projects/:id/page-issues', validateProjectAccess(), getPageIssues);
router.get('/projects/:id/onpage-issues', validateProjectAccess(), getOnPageIssues);
router.get('/projects/:id/onpage-issues/:issueCode', validateProjectAccess(), getIssueUrls);
router.get('/projects/:id/technical-checks', validateProjectAccess(), getTechnicalChecks);
router.get('/projects/:id/technical-checks/:checkId', validateProjectAccess(), getTechnicalCheckDetail);

// Pre-audit route
router.get('/projects/:id/pre-audit', validateProjectAccess(), getProjectPreAudit);

// URL Selection workflow routes
router.get('/projects/:id/url-pool', validateProjectAccess(), getUrlPool);
router.post('/projects/:id/url-selection', validateProjectAccess(), submitUrlSelection);
router.get('/projects/:id/page-failures', validateProjectAccess(), getPageFailures);

// AI Visibility routes
router.get('/projects/:id/ai-visibility/page', validateProjectAccess(), getAIVisibilityPage);
router.get('/projects/:id/ai-visibility/pages', validateProjectAccess(), getAIVisibilityPages);
router.get('/projects/:id/ai-visibility/worst-pages', validateProjectAccess(), getAIVisibilityWorstPages);
router.get('/projects/:id/ai-visibility/entity-graph', validateProjectAccess(), getAIVisibilityEntityGraph);

// Test endpoint to verify routes are working
router.get('/test-routes', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Routes are working',
    availableRoutes: [
      '/projects/:id/links',
      '/projects/:id/pages', 
      '/projects/:id/performance',
      '/projects/:id/summary',
      '/projects/:id/dashboard',
      '/projects/:id/issues',
      '/projects/:id/issues-by-page',
      '/projects/:id/page-issues',
      '/projects/:id/onpage-issues',
      '/projects/:id/onpage-issues/:issueCode',
      '/projects/:id/technical-checks',
      '/projects/:id/technical-checks/:checkId',
      '/projects/:id/screenshot'
    ]
  });
});

export default router;
