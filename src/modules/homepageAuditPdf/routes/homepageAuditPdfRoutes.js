import express from 'express';
import { getHomepageAuditPdfDataController, generateHomepageAuditPdfController } from '../controller/homepageAuditPdfController.js';
import auth from '../../../modules/user/middleware/auth.js';

const router = express.Router();

// GET /homepage-audit-pdf/:auditId/data — data layer only, no PDF generation,
// no download, no job route yet.
router.get('/:auditId/data', getHomepageAuditPdfDataController);

// POST /homepage-audit-pdf/:auditId/generate — generate PDF using Puppeteer
router.post('/:auditId/generate', generateHomepageAuditPdfController);

export default router;
