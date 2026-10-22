import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { createLeadValidator, updateLeadValidator, listLeadsValidator, projectIdQueryValidator } from '../validator/leadValidator.js';
import {
  createLead,
  getLeads,
  getLeadStats,
  getLeadById,
  updateLead,
  deleteLead,
} from '../controller/leadController.js';

const router = express.Router();

router.use(auth);

// projectId travels in body/query on these routes, so ownership can be
// checked up front by the shared middleware (same pattern as
// modules/tasks/routes/taskRoutes.js). /stats must be registered before
// /:id to avoid the route collision.
router.get('/stats', projectIdQueryValidator, validateProjectAccess(), getLeadStats);
router.post('/', createLeadValidator, validateProjectAccess(), createLead);
router.get('/', listLeadsValidator, validateProjectAccess(), getLeads);

// :id-only routes have no projectId on the request — ownership is resolved
// from the loaded lead's own projectId inline (assertLeadOwnership in
// leadController.js), same pattern as taskController.js/taskAuthz.js.
router.get('/:id', getLeadById);
router.patch('/:id', updateLeadValidator, updateLead);
router.delete('/:id', deleteLead);

export default router;
