import SeoScanRun, { ACTIVE_STATUSES } from '../model/SeoScanRun.js';

/**
 * The MongoDB side of scan locking and scan state. Every operation is a single atomic statement, so any number of backend instances can
 * call these at once:
 *
 *   tryAcquire   one insert carrying lockKey = projectId; the partial unique index rejects a second active scan (E11000) -> null
 *   expireStale  ends a scan whose lease ran out (crashed worker) with ONE conditional update, which also frees the lock
 *   heartbeat    extends the lease of a scan that still holds the lock
 *   finish       ends a scan and REMOVES lockKey (the unique index only covers string values)
 *
 * seoScanService takes this object as a dependency, so its logic is tested against an in-memory implementation of the same contract.
 */

const DUPLICATE_KEY = 11000;

// The lock IS the unique index: a scan must never start where it is not guaranteed to exist (autoIndex may be off in production).
let indexesReady = null;
const ensureIndexes = () => { indexesReady ??= SeoScanRun.createIndexes().catch((err) => { indexesReady = null; throw err; }); return indexesReady; };

export const mongoRunStore = {
  /** @returns {Promise<object|null>} the created run, or null when the project already has an active scan */
  async tryAcquire(doc) {
    await ensureIndexes();
    try {
      const created = await SeoScanRun.create({ ...doc, lockKey: String(doc.projectId) });
      return created.toObject();
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) return null;
      throw err;
    }
  },

  async findActive(projectId) {
    return SeoScanRun.findOne({ projectId, lockKey: String(projectId) }).lean();
  },

  /** Ends the project's active scan if (and only if) its lease has expired. @returns the ended run or null */
  async expireStale(projectId, now) {
    return SeoScanRun.findOneAndUpdate(
      { projectId, lockKey: String(projectId), leaseUntil: { $lt: now } },
      { $set: { status: 'failed', error: { code: 'SCAN_LEASE_EXPIRED' }, finishedAt: now }, $unset: { lockKey: 1 } },
      { new: true },
    ).lean();
  },

  async heartbeat(runId, leaseUntil) {
    const res = await SeoScanRun.updateOne({ _id: runId, lockKey: { $type: 'string' } }, { $set: { leaseUntil } });
    return res.matchedCount === 1;
  },

  async setStarted(runId, now) {
    await SeoScanRun.updateOne({ _id: runId }, { $set: { status: 'running', startedAt: now } });
  },

  async updateDataset(runId, datasetId, patch) {
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`datasets.$.${k}`, v]));
    await SeoScanRun.updateOne({ _id: runId, 'datasets.id': datasetId }, { $set: set });
  },

  async addCounters(runId, { completed = 0, failed = 0, requests = 0, cost = 0 }) {
    await SeoScanRun.updateOne({ _id: runId }, { $inc: { datasetsCompleted: completed, datasetsFailed: failed, providerRequestsCount: requests, reportedCost: cost } });
  },

  /** Ends the scan and frees the lock. */
  async finish(runId, { status, error = null, now }) {
    return SeoScanRun.findOneAndUpdate(
      { _id: runId },
      { $set: { status, error, finishedAt: now }, $unset: { lockKey: 1 } },
      { new: true },
    ).lean();
  },

  async get(projectId, runId) {
    return SeoScanRun.findOne({ _id: runId, projectId }).lean();
  },

  async latest(projectId) {
    return SeoScanRun.findOne({ projectId }).sort({ createdAt: -1 }).lean();
  },

  async list(projectId, limit = 10) {
    return SeoScanRun.find({ projectId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(1, limit), 20)).lean();
  },
};

export { ACTIVE_STATUSES };
