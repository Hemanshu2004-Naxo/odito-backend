import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getAEOHubData, getAEOHubIssues, getAEOHubIssueDetail } from '../controller/aiHubController.js';

const router = express.Router();
router.use(auth);

router.get('/:projectId',                validateProjectAccess(), getAEOHubData);
router.get('/:projectId/issues',         validateProjectAccess(), getAEOHubIssues);
router.get('/:projectId/issues/:ruleId', validateProjectAccess(), getAEOHubIssueDetail);

export default router;
