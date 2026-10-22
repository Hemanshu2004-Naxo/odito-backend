import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import { resolveRange } from './businessProfileReviewMetrics.js';
import { buildComparison, comparisonWindows } from './businessProfileReviewComparisonMetrics.js';

/**
 * Month-over-month / year-over-year comparison, read ENTIRELY from the daily
 * snapshots: no review is scanned, nothing is recomputed from raw data and
 * Google is never called. Per request: one date-range snapshot query (the three
 * windows, served by the unique project/location/date index) + one
 * "earliest snapshot" lookup (same index, limit 1).
 *
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.locationId        the STORED location (authorised by the caller)
 * @param {string} p.rangeKey          the dashboard range - the same one every other module uses
 * @param {string} p.snapshotTimezone  the timezone the snapshots are cut in (owner zone -> env default -> UTC)
 * @param {Date}   [p.now]
 */
export async function getReviewComparison({ projectId, locationId, rangeKey, snapshotTimezone = 'UTC', now = new Date() }) {
  const range = resolveRange(rangeKey, now, snapshotTimezone);
  const w = comparisonWindows(range);
  const between = (win) => ({ snapshot_date: { $gte: win.startKey, $lte: win.endKey } });

  const scope = { project_id: projectId, business_location_id: locationId };
  const [rows, first] = await Promise.all([
    BusinessProfileReviewSnapshot.find({ ...scope, $or: [between(w.current), between(w.mom), between(w.yoy)] })
      .select('snapshot_date timezone metric_rules_version metrics')
      .sort({ snapshot_date: 1 })
      .lean(),
    BusinessProfileReviewSnapshot.findOne(scope).sort({ snapshot_date: 1 }).select('snapshot_date').lean(),
  ]);

  return buildComparison({ range, rows, snapshotTimezone, historyStartsOn: first?.snapshot_date || null });
}

export default { getReviewComparison };
