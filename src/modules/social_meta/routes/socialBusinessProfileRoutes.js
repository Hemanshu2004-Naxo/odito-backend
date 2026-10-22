import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { handleCatalogImageUpload } from '../middleware/catalogImageUpload.js';
import {
  getSocialBusinessProfileHandler, updateSocialBusinessProfileHandler, uploadBrandLogoHandler, deleteBrandLogoHandler,
} from '../controller/socialBusinessProfileController.js';

const router = express.Router();

// GET /api/social/business-profile?projectId=  — resolved profile + editable fields + Google status.
// PUT /api/social/business-profile  { projectId, ...manual fields }  — updates ONLY user-entered fields.
// validateProjectAccess() reads projectId from the query (GET) / body (PUT) and rejects another user's project.
router.get('/', auth, validateProjectAccess(), getSocialBusinessProfileHandler);
router.put('/', auth, validateProjectAccess(), updateSocialBusinessProfileHandler);

// POST /api/social/business-profile/logo  multipart { projectId, file }  — the user's own brand logo.
// DELETE /api/social/business-profile/logo?projectId=  — remove it (fall back to the Google / website logo).
// multer runs BEFORE validateProjectAccess() on the upload: the projectId form field only exists once it parsed the body.
router.post('/logo', auth, handleCatalogImageUpload, validateProjectAccess(), uploadBrandLogoHandler);
router.delete('/logo', auth, validateProjectAccess(), deleteBrandLogoHandler);

export default router;
