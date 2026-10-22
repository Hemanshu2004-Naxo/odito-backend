import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { handleSocialMediaUpload } from '../middleware/socialMediaUpload.js';
import { uploadSocialMediaHandler } from '../controller/socialMediaUploadController.js';

const router = express.Router();

// multer runs BEFORE validateProjectAccess() here — unlike every other
// route in this module, this request is multipart/form-data, so
// req.body.projectId (which validateProjectAccess() reads) only exists
// once multer has parsed the form fields. validateProjectAccess() itself
// is unchanged; it already reads req.body.projectId like any other POST.
router.post('/upload', auth, handleSocialMediaUpload, validateProjectAccess(), uploadSocialMediaHandler);

export default router;
