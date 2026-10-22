import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getInstagramOverviewHandler } from '../controller/instagramController.js';

const router = express.Router();

// GET /api/social/instagram/overview?projectId= — real Instagram Business
// account data (post count, engagements, followers gained, likes,
// comments-vs-likes chart from already-synced posts). Returns
// { connected: false } (or connected:false + reason) rather than fake
// numbers when there is no connection or Meta rejects the stored token.
router.get('/overview', auth, validateProjectAccess(), getInstagramOverviewHandler);

export default router;
