import mongoose from 'mongoose';
import SeoProviderRequest from '../model/SeoProviderRequest.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Provider request accounting. `recordProviderRequest` is best effort and never throws or delays a purchase's answer: a ledger problem is
 * logged, not turned into a failed page. `summarizeUsage` reads MongoDB only.
 */

/** Only write when MongoDB is connected: a model write with no connection would sit in Mongoose's buffer instead of failing. */
export const dbReady = () => mongoose.connection.readyState === 1;

const count = (items) => (Array.isArray(items) ? items.length : null);

/** Number of records in a parsed section result, whatever its shape (rows, or a single summary). */
export function returnedRecordsOf(result) {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.items)) return result.items.length;
  if (Array.isArray(result.history)) return count(result.history);
  return 1;
}

export async function recordProviderRequest(entry, { model = SeoProviderRequest, ready = dbReady } = {}) {
  if (!ready()) return null;
  try {
    const doc = await model.create({
      projectId: entry.projectId, scanId: entry.scanId ?? null, trigger: entry.trigger, dataset: entry.dataset, endpoint: entry.endpoint,
      target: entry.target, startedAt: entry.startedAt, durationMs: entry.durationMs ?? null, success: Boolean(entry.success),
      errorCode: entry.success ? null : String(entry.errorCode ?? 'UNKNOWN').slice(0, 60),
      requestedRecords: Number.isFinite(entry.requestedRecords) ? entry.requestedRecords : null,
      returnedRecords: Number.isFinite(entry.returnedRecords) ? entry.returnedRecords : null,
      retryCount: entry.retryCount ?? 0,
      cost: typeof entry.cost === 'number' && Number.isFinite(entry.cost) ? entry.cost : null,
    });
    return doc._id;
  } catch (err) {
    LoggerUtil.warn('Provider request ledger: could not record a request', { dataset: entry?.dataset, error: err?.message });
    return null;
  }
}

const GROUP = {
  requests: { $sum: 1 },
  failures: { $sum: { $cond: ['$success', 0, 1] } },
  returnedRecords: { $sum: { $ifNull: ['$returnedRecords', 0] } },
  reportedCost: { $sum: { $ifNull: ['$cost', 0] } },
  requestsWithCost: { $sum: { $cond: [{ $isNumber: '$cost' }, 1, 0] } },
};
const shape = ({ _id, ...g }) => ({ ...g, requestsWithoutCost: g.requests - g.requestsWithCost, costComplete: g.requestsWithCost === g.requests });

/**
 * Project-level (last `days` days) or scan-level usage. `reportedCost` adds ONLY the costs the provider reported; `costComplete` says whether
 * every request had one. Bounded: the window is capped and the groups are by dataset / trigger.
 */
export async function summarizeUsage({ projectId, scanId = null, days = 30, now = new Date() }, { model = SeoProviderRequest } = {}) {
  const match = scanId ? { projectId, scanId } : { projectId, startedAt: { $gte: new Date(now.getTime() - Math.min(Math.max(1, days), 365) * 86_400_000) } };
  const [r] = await model.aggregate([
    { $match: match },
    { $facet: {
      total: [{ $group: { _id: null, ...GROUP } }],
      byDataset: [{ $group: { _id: '$dataset', ...GROUP } }, { $sort: { requests: -1 } }, { $limit: 50 }],
      byTrigger: [{ $group: { _id: '$trigger', ...GROUP } }],
      recentFailures: [{ $match: { success: false } }, { $sort: { startedAt: -1 } }, { $limit: 10 }, { $project: { _id: 0, dataset: 1, errorCode: 1, startedAt: 1, scanId: 1 } }],
    } },
  ]);
  const empty = { requests: 0, failures: 0, returnedRecords: 0, reportedCost: 0, requestsWithCost: 0, requestsWithoutCost: 0, costComplete: true };
  return {
    scope: scanId ? { scanId: String(scanId) } : { days: Math.min(Math.max(1, days), 365) },
    total: r?.total?.[0] ? shape(r.total[0]) : empty,
    byDataset: (r?.byDataset ?? []).map((g) => ({ dataset: g._id, ...shape(g) })),
    byTrigger: (r?.byTrigger ?? []).map((g) => ({ trigger: g._id, ...shape(g) })),
    recentFailures: r?.recentFailures ?? [],
  };
}
