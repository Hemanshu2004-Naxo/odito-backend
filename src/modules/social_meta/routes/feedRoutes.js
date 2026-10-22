import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getFeedsHandler, syncFeedsHandler } from '../controller/feedController.js';

const router = express.Router();

// GET /api/social/feeds?projectId=&platform=&status=&search=&from=&to=&sort=&page=&limit=
// Real Facebook + Instagram posts, read from MongoDB only (never calls
// Meta directly — see socialFeedService.js). x/linkedin/tiktok are not
// integrated yet and always report 0 in `summary`, never a fake count.
router.get('/', auth, validateProjectAccess(), getFeedsHandler);

// POST /api/social/feeds/sync — body: { projectId }. The Feeds page
// Refresh button: syncs every connected Facebook/Instagram account for
// the project from Meta into MongoDB, then the frontend refetches GET /.
router.post('/sync', auth, validateProjectAccess(), syncFeedsHandler);

export default router;
