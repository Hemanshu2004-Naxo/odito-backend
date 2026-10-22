import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getFacebookOverviewHandler, getFacebookAccountsHandler, switchFacebookAccountHandler } from '../controller/facebookController.js';

const router = express.Router();

// GET /api/social/facebook/overview?projectId= — real Page info/posts/
// insights for the project's currently ACTIVE Facebook Page. Returns
// { connected: false } (or connected:false + reason) rather than fake
// zeros when there is no connection or Meta rejects the stored token.
router.get('/overview', auth, validateProjectAccess(), getFacebookOverviewHandler);

// GET /api/social/facebook/accounts?projectId= — every connected Facebook
// Page for the project (Switch Account feature). Safe metadata only.
router.get('/accounts', auth, validateProjectAccess(), getFacebookAccountsHandler);

// POST /api/social/facebook/switch — body: { projectId, socialAccountId }.
// Switches which already-connected Page is active. Never triggers OAuth,
// never accepts/returns a token.
router.post('/switch', auth, validateProjectAccess(), switchFacebookAccountHandler);

export default router;
