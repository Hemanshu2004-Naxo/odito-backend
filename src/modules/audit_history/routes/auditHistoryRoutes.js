import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  getAuditHistory,
  getLatestComparison,
  getAuditComparison,
  getProjectTrends,
  getAiImpact,
} from '../controller/AuditHistoryController.js';

const router = express.Router();

router.use(auth);

// GET /api/projects/:projectId/audits — paginated audit history
router.get('/:projectId/audits', validateProjectAccess(), getAuditHistory);

// GET /api/projects/:projectId/comparison/latest — latest vs previous audit
router.get('/:projectId/comparison/latest', validateProjectAccess(), getLatestComparison);

// GET /api/projects/:projectId/comparison?from=N&to=N or ?fromAuditId=X&toAuditId=Y
router.get('/:projectId/comparison', validateProjectAccess(), getAuditComparison);

// GET /api/projects/:projectId/trends — chart-ready trend data + growth summary
router.get('/:projectId/trends', validateProjectAccess(), getProjectTrends);

// GET /api/projects/:projectId/ai-impact — AI recommendation impact metrics
router.get('/:projectId/ai-impact', validateProjectAccess(), getAiImpact);

export default router;
