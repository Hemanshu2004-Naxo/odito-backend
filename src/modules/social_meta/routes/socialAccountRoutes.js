import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getSocialAccountsStatus, disconnectSocialAccount, verifySocialAccounts } from '../controller/socialAccountController.js';

const router = express.Router();

// GET /api/social/accounts?projectId= — real connection status (Facebook +
// Instagram) for a project, sourced from MongoDB, never from any
// OAuth-flow-transient state. Mounted at a different prefix than
// metaRoutes.js (/social/accounts vs /social/meta/...) since this isn't
// Meta-OAuth-specific — it's the one place any connected social platform's
// status would eventually live.
router.get('/', auth, validateProjectAccess(), getSocialAccountsStatus);

// DELETE /api/social/accounts/:platform — body: { projectId }. Keyed by
// platform, not a raw document ID (see disconnectSocialAccount's own
// comment for why) — validateProjectAccess() reads projectId from the
// body for this method, same as selectMetaPage's own convention.
// POST /api/social/accounts/verify — body: { projectId }. Live token health
// check against Meta (see metaTokenService.js); never returns a token.
router.post('/verify', auth, validateProjectAccess(), verifySocialAccounts);

router.delete('/:platform', auth, validateProjectAccess(), disconnectSocialAccount);

export default router;
