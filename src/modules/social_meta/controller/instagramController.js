import { getInstagramOverview } from '../service/instagramOverviewService.js';
import { resolveRange } from '../service/dateRangeUtil.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * InstagramController — HTTP only. All Graph API calls and persistence
 * live in instagramOverviewService.js / instagramInsightsService.js /
 * instagramMediaService.js / the SocialAccount model — same layering as
 * facebookController.js.
 */
export async function getInstagramOverviewHandler(req, res) {
  const projectId = req.projectId;
  const range = resolveRange(req.query?.range);

  try {
    const overview = await getInstagramOverview({ projectId, range });
    return res.json(ResponseUtil.success(overview));
  } catch (error) {
    LoggerUtil.error('[INSTAGRAM_OVERVIEW] Failed to load Instagram overview', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load Instagram data', 500, { code: 'INSTAGRAM_OVERVIEW_FAILED' }));
  }
}

export default { getInstagramOverviewHandler };
