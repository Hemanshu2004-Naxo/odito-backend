import express from 'express';
import auth from '../../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../../middleware/auth.middleware.js';
import {
  startRun, getQuestionSelection, getSummary, listRunHistory, getRunDetail, cancelRun, listRunEvidence, getRunEvidence, getQuestionHistory, getTrend,
} from '../controllers/googleAioController.js';

/**
 * Mounted at /api/ai-visibility/google-aio (routes/index.js). Everything is authenticated and project-scoped: validateProjectAccess()
 * proves the caller owns :id before any handler runs. A request body can only name a device and (optionally) exactly five question
 * ids from the project's approved set; the location, language, depth and every limit come from the stored profile and server config.
 */
const router = express.Router();
router.use(auth);

router.post('/projects/:id/runs', validateProjectAccess(), startRun);
router.get('/projects/:id/question-selection', validateProjectAccess(), getQuestionSelection);
router.get('/projects/:id/summary', validateProjectAccess(), getSummary);
router.get('/projects/:id/runs', validateProjectAccess(), listRunHistory);
router.get('/projects/:id/runs/:runId', validateProjectAccess(), getRunDetail);
router.post('/projects/:id/runs/:runId/cancel', validateProjectAccess(), cancelRun);
router.get('/projects/:id/runs/:runId/evidence', validateProjectAccess(), listRunEvidence);
router.get('/projects/:id/runs/:runId/evidence/:questionId', validateProjectAccess(), getRunEvidence);
router.get('/projects/:id/questions/:questionId/history', validateProjectAccess(), getQuestionHistory);
router.get('/projects/:id/trend', validateProjectAccess(), getTrend);

export default router;
