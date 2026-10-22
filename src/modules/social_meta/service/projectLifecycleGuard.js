import mongoose from 'mongoose';
import SeoProject from '../../app_user/model/SeoProject.js';

/**
 * projectLifecycleGuard - the ONE place that answers "may anything act for this project right now?" for the background
 * social paths (scheduler, recovery sweeps, platform calls with a stored credential).
 *
 *   active   the project exists and is not in the trash       -> everything may run
 *   trashed  soft-deleted (is_deleted), restorable for 7 days -> nothing is dispatched or reconciled; data is untouched,
 *                                                                so a restore finds the project exactly as it was
 *   missing  no SeoProject document at all (purged, or an     -> orphaned social rows; they must never publish and are
 *            orphan left by an older purge)                      removed by purgeOrphanedSocialData / the daily purge
 *
 * HTTP routes already refuse trashed projects (validateProjectAccess excludes is_deleted), so this guard exists for the
 * paths that have NO request: the cron-driven scheduler and its recovery sweeps.
 */

const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);

export const PROJECT_STATES = Object.freeze({ ACTIVE: 'active', TRASHED: 'trashed', MISSING: 'missing' });

/** @returns {Promise<'active'|'trashed'|'missing'>} */
export async function getProjectState(projectId) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return PROJECT_STATES.MISSING;
  const project = await SeoProject.findById(toId(projectId)).select('is_deleted').lean();
  if (!project) return PROJECT_STATES.MISSING;
  return project.is_deleted === true ? PROJECT_STATES.TRASHED : PROJECT_STATES.ACTIVE;
}

/** Ids of every project currently in the trash (a small set: the trash is purged after 7 days). */
export async function getTrashedProjectIds() {
  return SeoProject.find({ is_deleted: true }).distinct('_id');
}

/**
 * The project part of a background sweep's filter.
 *   - one project requested: that project, or a filter that matches nothing when it is not active
 *   - everything: every project except the trashed ones
 * (Projects that no longer exist cannot be excluded this way; publishNow refuses and cancels their posts, and the
 * orphan sweep removes them.)
 */
export async function activeProjectScope(projectId = null) {
  if (projectId) {
    const state = await getProjectState(projectId);
    return state === PROJECT_STATES.ACTIVE ? { project_id: toId(projectId) } : { _id: { $in: [] } };
  }
  const trashed = await getTrashedProjectIds();
  return trashed.length ? { project_id: { $nin: trashed } } : {};
}

export default { getProjectState, getTrashedProjectIds, activeProjectScope, PROJECT_STATES };
