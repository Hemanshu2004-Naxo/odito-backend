import express from 'express';
import auth from '../../user/middleware/auth.js';
import {
  getIssueContext,
  batchIssueContext,
  registryCheck,
} from '../controller/issueContextController.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// GET /issue-context/:projectId/:issueId?pageUrl=...
router.get('/:projectId/:issueId', getIssueContext);

// POST /issue-context/batch
router.post('/batch', batchIssueContext);

// GET /issue-context/registry-check/:issueId
router.get('/registry-check/:issueId', registryCheck);

export default router;
