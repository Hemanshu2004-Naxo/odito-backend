import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  getVerificationRun,
  getVerificationHistory,
  getLatestVerificationForPage,
} from '../controller/VerificationHistoryController.js';
import {
  getVerificationBatch,
  getVerificationBatchRuns,
} from '../controller/VerificationBatchController.js';

const router = express.Router();

router.use(auth);

/**
 * @route   GET /api/seo/verification-runs/:runId
 * @desc    Retrieve one URL Verification run (read-only)
 * @access  Private (ownership resolved from the run's own projectId)
 */
router.get('/verification-runs/:runId', getVerificationRun);

/**
 * @route   GET /api/seo/projects/:projectId/verification-history
 * @desc    Paginated URL Verification history for a project, newest first
 * @access  Private (project ownership verified)
 */
router.get('/projects/:projectId/verification-history', validateProjectAccess(), getVerificationHistory);

/**
 * @route   GET /api/seo/projects/:projectId/pages/:encodedUrl/latest-verification
 * @desc    Latest URL Verification run for one page
 * @access  Private (project ownership verified)
 */
router.get('/projects/:projectId/pages/:encodedUrl/latest-verification', validateProjectAccess(), getLatestVerificationForPage);

/**
 * @route   GET /api/seo/verification-batches/:batchId
 * @desc    F4-018 — read-only Verification Batch status (frontend fallback
 *          if the verification:batch-completed websocket event is missed;
 *          operator/debugging inspection)
 * @access  Private (ownership resolved from the batch's own projectId)
 */
router.get('/verification-batches/:batchId', getVerificationBatch);

/**
 * @route   GET /api/seo/verification-batches/:batchId/runs
 * @desc    F4-018 — every PageVerificationRun belonging to a batch
 * @access  Private (ownership resolved from the batch's own projectId)
 */
router.get('/verification-batches/:batchId/runs', getVerificationBatchRuns);

export default router;
