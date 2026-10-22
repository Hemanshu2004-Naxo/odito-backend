import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getPageAIIssues } from '../controller/aiHubController.js';

const router = express.Router();
router.use(auth);

router.get('/:projectId/issues', validateProjectAccess(), getPageAIIssues);

export default router;
