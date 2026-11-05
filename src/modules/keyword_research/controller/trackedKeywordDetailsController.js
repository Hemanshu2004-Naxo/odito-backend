import mongoose from 'mongoose';
import { getTrackedKeywordDetails, TrackedKeywordNotFound } from '../service/trackedKeywordDetailsService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/seo/keywords/:projectId/:keywordId/details
 * One tracked keyword's expanded-row data. Thin: validates the ids, asks the service (which enforces ownership from the session
 * user), maps the one expected failure to 404. A project that is not the caller's and a keyword that is not in it both answer 404.
 */
export const getTrackedKeywordDetailsController = async (req, res) => {
  const { projectId, keywordId } = req.params;
  const userId = req.user?._id;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (!mongoose.Types.ObjectId.isValid(projectId)) return res.status(400).json({ success: false, message: 'Invalid projectId format' });
  if (!mongoose.Types.ObjectId.isValid(keywordId)) return res.status(400).json({ success: false, message: 'Invalid keywordId format' });

  try {
    const data = await getTrackedKeywordDetails({ projectId, keywordId, userId });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof TrackedKeywordNotFound) return res.status(404).json({ success: false, message: 'Tracked keyword not found' });
    LoggerUtil.error('Tracked keyword details error', err);
    return res.status(500).json({ success: false, message: 'Internal server error while fetching keyword details' });
  }
};
