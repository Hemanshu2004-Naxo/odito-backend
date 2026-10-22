import { AuthUtil } from '../../../utils/AuthUtil.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';

/**
 * For routes keyed only by :taskId (no projectId anywhere on the request),
 * ownership can only be resolved after the task is loaded, from its own
 * projectId — mirrors VerificationHistoryController.getVerificationRun's
 * exact pattern (the same shared AuthUtil.validateProjectAccess used by the
 * validateProjectAccess() middleware on projectId-bearing routes).
 *
 * Returns true if access is allowed. On denial, writes the response itself
 * (404/403/500) and returns false — callers must `return` immediately.
 */
export async function assertTaskOwnership(req, res, task) {
  try {
    await AuthUtil.validateProjectAccess(req.user._id, task.projectId);
    return true;
  } catch (error) {
    if (error.type === 'NOT_FOUND') {
      res.status(404).json(ResponseUtil.notFound(error.message));
    } else if (error.type === 'ACCESS_DENIED') {
      res.status(403).json(ResponseUtil.accessDenied(error.message));
    } else {
      res.status(error.statusCode || 500).json(ResponseUtil.error(error.message, error.statusCode || 500));
    }
    return false;
  }
}
