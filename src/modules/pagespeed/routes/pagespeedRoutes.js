import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  rescanPageSpeed,
  getPageSpeedStatus,
  forwardWsEvent,
} from '../controller/pagespeedController.js';

const router = express.Router();

// All user-facing routes require authentication
router.use(auth);

// POST /api/pagespeed/rescan/:projectId
// Trigger standalone PageSpeed rescan (no full audit, no credit deduction)
router.post(
  '/rescan/:projectId',
  validateProjectAccess(),
  rescanPageSpeed,
);

// GET /api/pagespeed/status/:projectId
// Poll current scan status + metadata
router.get(
  '/status/:projectId',
  validateProjectAccess(),
  getPageSpeedStatus,
);

// POST /api/pagespeed/ws-event
// Internal bridge: Python worker → Node.js → Socket.IO clients
// Intentionally no auth: only reachable from the Python worker on the same internal network
router.post('/ws-event', forwardWsEvent);

export default router;
