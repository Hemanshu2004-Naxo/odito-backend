import express from 'express';
import { generatePDF } from './exportController.js';
import auth from '../../modules/user/middleware/auth.js';
import { validateProjectAccess } from '../../middleware/auth.middleware.js';

const router = express.Router();

// Generate PDF for a project
// POST /api/export/projects/:projectId/export/:type
router.post('/projects/:projectId/export/:type', auth, validateProjectAccess(), generatePDF);

// Generate PDF for a project (GET support for browser testing)
// GET /api/export/projects/:projectId/export/:type
router.get('/projects/:projectId/export/:type', auth, validateProjectAccess(), generatePDF);

// Export status endpoint
// GET /api/export/status
router.get('/status', (req, res) => {
  res.json({
    success: true,
    message: 'Backend PDF export system is operational',
    timestamp: new Date().toISOString()
  });
});

export default router;
