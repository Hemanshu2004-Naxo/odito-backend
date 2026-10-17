import express from 'express';
import rateLimit from 'express-rate-limit';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  createTask,
  updateTaskStatus,
  getTasks,
  getTaskById,
  getTaskHistory,
  getTaskSummary,
  getActiveTaskUrls,
  deleteTask,
  applyWordPressFix,
  linkTaskRecommendation,
} from '../controller/taskController.js';
import { previewWordPressFix, reverifyWordPressFix, rollbackWordPressFix } from '../controller/taskWordPressSchemaFix.js';
import { listImageAltImages, previewImageAltFix, applyImageAltFix, reverifyImageAltFix, rollbackImageAltFix } from '../controller/taskImageAltFix.js';

const router = express.Router();

router.use(auth);

// Each request makes a live outbound call to a customer's WordPress site
// (read-before-write + the write itself) — throttled well below what a
// single user clicking "Apply" repeatedly could generate, and far below
// anything a bulk flow (a later phase, not this one) would need, since bulk
// fixes are explicitly routed through the Job system instead of this
// endpoint (see the Phase 4 architecture report).
const wordPressFixReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.', code: 'RATE_LIMITED' },
});

const applyWordPressFixLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many WordPress fix attempts. Please try again shortly.', code: 'RATE_LIMITED' },
});

// projectId travels in query/body on these routes, so ownership can be
// checked up front by the shared middleware. Summary/active-urls must come
// before /:taskId to avoid route collision.
router.get('/summary',      validateProjectAccess(), getTaskSummary);
router.get('/active-urls',  validateProjectAccess(), getActiveTaskUrls);
router.post('/',            validateProjectAccess(), createTask);
router.get('/',              validateProjectAccess(), getTasks);

// :taskId-only routes have no projectId on the request — ownership is
// resolved from the loaded task's own projectId inline (assertTaskOwnership
// in taskController.js), same pattern as VerificationHistoryController.
router.get('/:taskId',          getTaskById);
router.get('/:taskId/history',  getTaskHistory);
router.patch('/:taskId/status', updateTaskStatus);
router.patch('/:taskId/link-recommendation', linkTaskRecommendation);
router.post('/:taskId/apply-wordpress', applyWordPressFixLimiter, applyWordPressFix);
// Typed schema fixes (Organization): preview the exact change, re-verify saved + rendered state, roll back safely.
router.get('/:taskId/wordpress-fix/preview', wordPressFixReadLimiter, previewWordPressFix);
// sameAs needs the owner's selected links to plan, so its preview is a POST with the same read-only guarantee.
router.post('/:taskId/wordpress-fix/preview', wordPressFixReadLimiter, previewWordPressFix);
router.post('/:taskId/wordpress-fix/reverify', applyWordPressFixLimiter, reverifyWordPressFix);
router.post('/:taskId/wordpress-fix/rollback', applyWordPressFixLimiter, rollbackWordPressFix);
// Image alt text (WordPress media library), one image at a time: list this task's images, read-only preview, approve + apply,
// re-verify, roll back. The body names an image of THIS task; the attachment is resolved server-side.
router.get('/:taskId/image-alt/images', wordPressFixReadLimiter, listImageAltImages);
router.post('/:taskId/image-alt/preview', wordPressFixReadLimiter, previewImageAltFix);
router.post('/:taskId/image-alt/apply', applyWordPressFixLimiter, applyImageAltFix);
router.post('/:taskId/image-alt/reverify', applyWordPressFixLimiter, reverifyImageAltFix);
router.post('/:taskId/image-alt/rollback', applyWordPressFixLimiter, rollbackImageAltFix);
router.delete('/:taskId',       deleteTask);

export default router;
