import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import SeoProject from '../model/SeoProject.js';
import { resolveProjectBrandAssets } from '../../../services/brandAssetService.js';

/**
 * GET /projects/:projectId/brand-asset
 *
 * Thin HTTP wrapper around brandAssetService.resolveProjectBrandAssets() -
 * the platform-wide Brand Asset Resolver. Any other server-side module
 * (PDF/email generation, other controllers) should call
 * resolveProjectBrandAssets() directly rather than going through this route.
 *
 * Query params: force=true - bypass the website-assets cache and re-resolve
 *
 * Response: { success: true, data: { brandLogo, favicon, source, resolution, fallbackType } }
 */
export const getProjectBrandAsset = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const force = req.query.force === 'true';

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const brandAsset = await resolveProjectBrandAssets(project, { force });

    return res.json(ResponseUtil.success(brandAsset));

  } catch (error) {
    LoggerUtil.error('Error resolving brand asset', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to resolve brand asset', 500));
  }
};

export default { getProjectBrandAsset };
