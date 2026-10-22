import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getGEOHubData, getGEOHubIssues, getGEOHubIssueDetail } from '../controller/aiHubController.js';

const router = express.Router();
router.use(auth);

router.get('/:projectId',                validateProjectAccess(), getGEOHubData);
router.get('/:projectId/issues',         validateProjectAccess(), getGEOHubIssues);
router.get('/:projectId/issues/:ruleId', validateProjectAccess(), getGEOHubIssueDetail);

export default router;
