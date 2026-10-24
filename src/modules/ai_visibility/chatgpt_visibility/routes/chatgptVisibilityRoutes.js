import express from 'express';
import auth from '../../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../../middleware/auth.middleware.js';
import {
  startRun, getSummary, listRunHistory, getRunDetail, cancelRun, listProjectPromptSets, getProjectPromptSet,
  listRunEvidence, getRunEvidence, getQuestionHistory, getTrend, getCitedPages, compareProjectRuns,
} from '../controllers/chatgptVisibilityController.js';

/**
 * Mounted at /api/ai-visibility/chatgpt (routes/index.js). Everything is authenticated and project-scoped:
 * validateProjectAccess() proves the caller owns :id before any handler runs. Nothing in a request body can choose a model, a
 * prompt, a location or a limit - a run is started from the project's stored profile and server configuration only.
 *
 * This is deliberately separate from /api/app_user/projects/:id/ai-visibility/*, which serves ON-PAGE AI READINESS data.
 */
const router = express.Router();
router.use(auth);

router.post('/projects/:id/runs', validateProjectAccess(), startRun);
router.get('/projects/:id/summary', validateProjectAccess(), getSummary);
router.get('/projects/:id/runs', validateProjectAccess(), listRunHistory);
router.get('/projects/:id/runs/:runId', validateProjectAccess(), getRunDetail);
router.post('/projects/:id/runs/:runId/cancel', validateProjectAccess(), cancelRun);
// Approved-question runs (POST .../runs with { mode: "approved_questions" }): persisted answers + citations, one document per question.
router.get('/projects/:id/runs/:runId/evidence', validateProjectAccess(), listRunEvidence);
router.get('/projects/:id/runs/:runId/evidence/:questionId', validateProjectAccess(), getRunEvidence);
router.get('/projects/:id/questions/:questionId/history', validateProjectAccess(), getQuestionHistory);
// Reporting views over persisted evidence / runs (approved-question runs only).
router.get('/projects/:id/trend', validateProjectAccess(), getTrend);
router.get('/projects/:id/cited-pages', validateProjectAccess(), getCitedPages);
router.get('/projects/:id/compare', validateProjectAccess(), compareProjectRuns);
router.get('/projects/:id/prompt-sets', validateProjectAccess(), listProjectPromptSets);
router.get('/projects/:id/prompt-sets/:setId', validateProjectAccess(), getProjectPromptSet);

export default router;
