import express from 'express';
import KeywordRankingController from '../controller/keywordRankingController.js';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';

const router = express.Router();
const rankingController = new KeywordRankingController();

// 🔒 SECURITY: Apply authentication to all keyword routes
router.use(auth);


// ========== Keyword Ranking Routes ==========

// POST /api/keywords/rankings/check - Check keyword rankings
// validateProjectAccess: the caller must own :projectId / body.projectId (404 unknown, 403 someone else's).
router.post('/rankings/check', validateProjectAccess(), rankingController.checkRankings.bind(rankingController));

// GET /api/keywords/rankings/summary/:projectId - Get ranking summary for project
router.get('/rankings/summary/:projectId', validateProjectAccess(), rankingController.getRankingSummary.bind(rankingController));

// GET /api/keywords/rankings/history/:projectId - Get ranking history for project
router.get('/rankings/history/:projectId', validateProjectAccess(), rankingController.getRankingHistory.bind(rankingController));

// GET /api/keywords/rankings/project/:projectId - Get all rankings for project
router.get('/rankings/project/:projectId', validateProjectAccess(), rankingController.getProjectRankings.bind(rankingController));

// POST /api/keywords/rankings/test - Test keyword ranking (standalone)
router.post('/rankings/test', rankingController.testRanking.bind(rankingController));

export default router;
