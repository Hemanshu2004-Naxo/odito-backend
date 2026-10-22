import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getAISOHubData, getAISOHubIssues, getAISOHubIssueDetail } from '../controller/aiHubController.js';

const router = express.Router();
router.use(auth);

router.get('/:projectId',         validateProjectAccess(), getAISOHubData);
router.get('/:projectId/issues',          validateProjectAccess(), getAISOHubIssues);
router.get('/:projectId/issues/:ruleId',  validateProjectAccess(), getAISOHubIssueDetail);

export default router;
