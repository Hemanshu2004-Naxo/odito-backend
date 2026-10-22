import express from 'express';
import { getProjectBrandAsset } from '../controller/brandAssetController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Brand Asset Resolver route
 *
 * GET /projects/:projectId/brand-asset
 *
 * Resolves the best available branding for a project, in priority order:
 * Google Business Profile logo -> website logo -> website favicon ->
 * (caller falls back to generated initials). See
 * services/brandAssetService.js for the full resolution logic.
 *
 * Query Parameters:
 * - force: 'true' to bypass the cached website logo/favicon and re-resolve
 *
 * Response: {
 *   success: true,
 *   data: { brandLogo, favicon, source, resolution, fallbackType }
 * }
 */
router.get('/:projectId/brand-asset',
  auth,
  getProjectBrandAsset
);

export default router;
