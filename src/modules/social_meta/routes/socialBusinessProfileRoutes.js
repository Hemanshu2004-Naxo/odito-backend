import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { handleCatalogImageUpload } from '../middleware/catalogImageUpload.js';
import { handleBrandFontUpload } from '../middleware/brandFontUpload.js';
import {
  getSocialBusinessProfileHandler, updateSocialBusinessProfileHandler, uploadBrandLogoHandler, deleteBrandLogoHandler, uploadBrandFontHandler, deleteBrandFontHandler,
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

// POST /api/social/business-profile/font?role=heading|body&weight=regular|bold  multipart { projectId, file }  — a brand font file
// DELETE /api/social/business-profile/font { projectId, role, weight }  — remove it (the font name stays; designs fall back and say so)
router.post('/font', auth, handleBrandFontUpload, validateProjectAccess(), uploadBrandFontHandler);
router.delete('/font', auth, validateProjectAccess(), deleteBrandFontHandler);

export default router;
