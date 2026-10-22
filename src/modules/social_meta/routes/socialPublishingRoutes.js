import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  listPublicationsHandler, getPublicationHandler, createPublicationHandler, updatePublicationHandler,
  deletePublicationHandler, schedulePublicationHandler, cancelPublicationHandler, publishPublicationHandler,
  bulkCreatePublicationsHandler,
  submitContentHandler, approveContentHandler, requestContentChangesHandler, submitDesignHandler, approveDesignHandler,
  requestDesignChangesHandler, approvalSummaryHandler, getApprovalSettingsHandler, updateApprovalSettingsHandler,
} from '../controller/socialPublishingController.js';
import {
  getBulkImportBatchHandler, getBulkImportRowsHandler,
  validateBulkImportHandler, getBulkImportTemplateHandler,
  importBulkUploadHandler, getBulkImportErrorsHandler,
} from '../controller/bulkImportController.js';
import { handleBulkImportUpload } from '../middleware/bulkImportUpload.js';

const router = express.Router();

// The publication id is always `:publicationId`, never `:id` —
// validateProjectAccess() itself reads `req.params.id` as a possible
// project id, so naming it `:id` here would silently let a publication's
// Mongo _id be misinterpreted as the project id on every one of these
// routes. projectId always comes from the query string (GET) or JSON
// body (everything else), matching every other route in this module.
router.get('/', auth, validateProjectAccess(), listPublicationsHandler);
router.post('/', auth, validateProjectAccess(), createPublicationHandler);
router.post('/bulk', auth, validateProjectAccess(), bulkCreatePublicationsHandler);

// Bulk-upload CSV/XLSX import. Declared BEFORE the `/:publicationId`
// routes below: `/bulk-upload/...` is two path segments so Express's
// single-segment `/:publicationId` pattern can never capture it, but
// keeping these first makes that guarantee order-proof. The literal
// `/template` and `/validate` paths are declared BEFORE `/:batchId` so
// they are never read as a batch id.
//
// `/validate` is multipart/form-data — handleBulkImportUpload (a
// DEDICATED multer config, separate from the image/video upload
// middleware) runs BEFORE validateProjectAccess() so req.body.projectId
// exists once the form is parsed, exactly like the media upload route.
router.get('/bulk-upload/template', auth, validateProjectAccess(), getBulkImportTemplateHandler);
router.post('/bulk-upload/validate', auth, handleBulkImportUpload, validateProjectAccess(), validateBulkImportHandler);
// Phase 3: turn a ready batch's valid rows into real SocialPublication
// records (no upload middleware — a plain JSON body). Declared before the
// bare `/bulk-upload/:batchId` GET so `/:batchId/import` and
// `/:batchId/errors` resolve to their own handlers.
router.post('/bulk-upload/:batchId/import', auth, validateProjectAccess(), importBulkUploadHandler);
router.get('/bulk-upload/:batchId/errors', auth, validateProjectAccess(), getBulkImportErrorsHandler);
router.get('/bulk-upload/:batchId', auth, validateProjectAccess(), getBulkImportBatchHandler);
router.get('/bulk-upload/:batchId/rows', auth, validateProjectAccess(), getBulkImportRowsHandler);

// Content approval workflow. The literal `/approvals/summary` and
// `/approval-settings` paths are declared BEFORE `/:publicationId` so they are
// never read as a publication id (`/approval-settings` is a single segment).
router.get('/approvals/summary', auth, validateProjectAccess(), approvalSummaryHandler);
router.get('/approval-settings', auth, validateProjectAccess(), getApprovalSettingsHandler);
router.put('/approval-settings', auth, validateProjectAccess(), updateApprovalSettingsHandler);

router.get('/:publicationId', auth, validateProjectAccess(), getPublicationHandler);
router.patch('/:publicationId', auth, validateProjectAccess(), updatePublicationHandler);
router.delete('/:publicationId', auth, validateProjectAccess(), deletePublicationHandler);
router.post('/:publicationId/publish', auth, validateProjectAccess(), publishPublicationHandler);
router.post('/:publicationId/cancel', auth, validateProjectAccess(), cancelPublicationHandler);
router.post('/:publicationId/schedule', auth, validateProjectAccess(), schedulePublicationHandler);
router.post('/:publicationId/content/submit', auth, validateProjectAccess(), submitContentHandler);
router.post('/:publicationId/content/approve', auth, validateProjectAccess(), approveContentHandler);
router.post('/:publicationId/content/request-changes', auth, validateProjectAccess(), requestContentChangesHandler);
router.post('/:publicationId/design/submit', auth, validateProjectAccess(), submitDesignHandler);
router.post('/:publicationId/design/approve', auth, validateProjectAccess(), approveDesignHandler);
router.post('/:publicationId/design/request-changes', auth, validateProjectAccess(), requestDesignChangesHandler);

export default router;
