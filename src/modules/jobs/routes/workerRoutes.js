import express from 'express';
import { claimJob, validateClaimJob } from '../controller/workerController.js';

const router = express.Router();

/**
 * Worker job claiming endpoints
 * These are endpoints that workers call to get and claim jobs
 */

// POST /workers/claim - Claim a job of a specific type
router.post('/claim', validateClaimJob, claimJob);

export default router;
