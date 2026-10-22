import express from 'express';
import auth from '../../user/middleware/auth.js';
import { markFixed, reopenIssue, getFixLogs, getFixedUrls } from '../controller/fixLogController.js';

const router = express.Router();

// Deprecation warning middleware
router.use((req, res, next) => {
  res.setHeader('Warning', '299 - "This endpoint is deprecated. Please use /tasks endpoints instead."');
  console.warn(`[DEPRECATED] Request to legacy endpoint: ${req.originalUrl || req.url}`);
  next();
});

router.use(auth);

router.post('/fix',         markFixed);
router.post('/reopen',      reopenIssue);
router.get('/fixed-urls',   getFixedUrls);
router.get('/',             getFixLogs);

export default router;
