import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { startMetaConnection, handleMetaCallback, getMetaPages, selectMetaPage, retryInstagramDiscovery } from '../controller/metaOAuthController.js';

const router = express.Router();

// STEP 1 — authenticated, project-scoped. validateProjectAccess() reads
// projectId from req.query (among other sources) and attaches
// req.project/req.projectId/req.userId — the same shared middleware
// export.exportRoutes.js already uses, rather than duplicating Google's
// own inline SeoProject.findById + ownership-check pattern.
router.get('/start', auth, validateProjectAccess(), startMetaConnection);

// STEP 2 — PUBLIC. Meta redirects the browser here directly; there is no
// Authorization header on this request, so no `auth` middleware. All
// trust comes from the signed OAuth state validated inside the
// controller, never from req.query alone.
router.get('/callback', handleMetaCallback);

// STEP 3 — authenticated, project-scoped. Same validateProjectAccess()
// contract as /start; reads projectId from req.query.
router.get('/pages', auth, validateProjectAccess(), getMetaPages);

// STEP 4 — authenticated, project-scoped. projectId comes from the
// request body (per the Phase 2 spec: "client must NEVER send
// accessToken" — only { projectId }); validateProjectAccess() already
// falls back to req.body.projectId, so no route change is needed there.
router.post('/pages/:pageId/select', auth, validateProjectAccess(), selectMetaPage);

// STEP 5 (Phase 3) — authenticated, project-scoped. Re-runs Facebook Page ->
// Instagram discovery on its own, for the frontend's "Retry" action after a
// discovery failure (selectMetaPage's PendingMetaConnection is already gone
// by then — see retryInstagramDiscovery's own docblock).
router.post('/pages/:pageId/instagram/retry', auth, validateProjectAccess(), retryInstagramDiscovery);

export default router;

