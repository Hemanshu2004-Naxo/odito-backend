import { schedule } from 'node-cron';
import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import SeoProject from '../modules/app_user/model/SeoProject.js';
import User from '../modules/user/model/User.js';
import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import {
  captureReviewSnapshot, resolveSnapshotTimezone, snapshotWindow,
} from './businessProfileReviewSnapshotService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

const SERVICE = 'BusinessProfileReviewSnapshotScheduler';

// Hourly, not once a day: each project's "today" is cut in ITS OWNER's
// timezone, so the first tick after a local midnight is what creates that
// day's row. A location that already has today's row is skipped with a single
// batched lookup, so an hourly tick costs one query when nothing is due.
const CRON_EXPRESSION = process.env.REVIEW_SNAPSHOT_CRON || '10 * * * *';
const ENABLED = process.env.REVIEW_SNAPSHOT_ENABLED !== 'false';

let task = null;

/**
 * Snapshot every connected Business Profile location that has no snapshot yet
 * for its current local day. Exported separately from start() so it can be run
 * directly (tests, an ops "run now") without waiting for the cron tick.
 *
 * Safety is in the data layer, not in this loop: the unique
 * (project, location, day) index + upsert make a second tick, a late tick, a
 * restart or a second backend instance harmless. A failure for one location
 * never aborts the others and is simply retried on the next tick.
 *
 * Connections are READ ONLY here (ids, never tokens) and no Google API is
 * called: an `expired`/`revoked` connection still has stored reviews to
 * snapshot, and a snapshot failure must never touch connection status.
 *
 * @returns {Promise<{considered:number, captured:number, skipped:number, failed:number, failedProjects:object[]}>}
 */
export async function runOnce({ now = new Date() } = {}) {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');
  const summary = { considered: 0, captured: 0, skipped: 0, failed: 0, failedProjects: [] };

  let targets = [];
  try {
    const connections = await GoogleConnection.find({
      purpose: 'business_profile',
      business_location_id: { $exists: true, $nin: [null, ''] },
    }).select('_id project_id business_account_id business_location_id').lean();
    if (!connections.length) {
      LoggerUtil.service(SERVICE, 'run', 'completed', { durationMs: Date.now() - startedAt, ...summary });
      return summary;
    }

    const projects = await SeoProject.find({
      _id: { $in: connections.map((c) => c.project_id) },
      is_deleted: { $ne: true },
    }).select('_id user_id').lean();
    const ownerByProject = new Map(projects.map((p) => [String(p._id), p.user_id]));

    const owners = await User.find({ _id: { $in: [...new Set(projects.map((p) => String(p.user_id)))] } })
      .select('timezone').lean();
    const tzByUser = new Map(owners.map((u) => [String(u._id), u.timezone]));

    targets = connections
      .filter((c) => ownerByProject.has(String(c.project_id)))
      .map((c) => {
        const userId = ownerByProject.get(String(c.project_id));
        const timezone = resolveSnapshotTimezone(tzByUser.get(String(userId)));
        return { connection: c, userId, timezone, snapshotDate: snapshotWindow(now, timezone).snapshotDate };
      });

    // One batched lookup for "already snapshotted today" instead of one per project.
    const existing = await BusinessProfileReviewSnapshot.find({
      project_id: { $in: targets.map((t) => t.connection.project_id) },
      snapshot_date: { $in: [...new Set(targets.map((t) => t.snapshotDate))] },
    }).select('project_id business_location_id snapshot_date').lean();
    const done = new Set(existing.map((s) => `${s.project_id}:${s.business_location_id}:${s.snapshot_date}`));

    summary.considered = targets.length;
    targets = targets.filter((t) => {
      const key = `${t.connection.project_id}:${t.connection.business_location_id}:${t.snapshotDate}`;
      if (done.has(key)) { summary.skipped += 1; return false; }
      return true;
    });
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to determine snapshot targets`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
    return summary;
  }

  for (const t of targets) {
    const projectId = String(t.connection.project_id);
    try {
      await captureReviewSnapshot({
        projectId,
        locationId: t.connection.business_location_id,
        userId: t.userId,
        connectionId: t.connection._id,
        accountId: t.connection.business_account_id,
        timezone: t.timezone,
        now,
      });
      summary.captured += 1;
    } catch (error) {
      // Logged inside captureReviewSnapshot; the next tick retries this location.
      summary.failed += 1;
      summary.failedProjects.push({ projectId, error: error.message });
    }
  }

  LoggerUtil.service(SERVICE, 'run', 'completed', {
    durationMs: Date.now() - startedAt,
    considered: summary.considered, captured: summary.captured, skipped: summary.skipped, failed: summary.failed,
  });
  return summary;
}

/**
 * Start the hourly tick. No-op if already started. Set
 * REVIEW_SNAPSHOT_ENABLED=false to disable without a code change.
 */
export function startReviewSnapshotScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'REVIEW_SNAPSHOT_ENABLED=false' });
    return null;
  }
  if (task) {
    LoggerUtil.warn(`${SERVICE}: start called but scheduler is already running`);
    return task;
  }

  task = schedule(
    CRON_EXPRESSION,
    () => {
      runOnce().catch((error) => {
        LoggerUtil.error(`${SERVICE}: run crashed unexpectedly`, error);
      });
    },
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: CRON_EXPRESSION });
  return task;
}

export function stopReviewSnapshotScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
