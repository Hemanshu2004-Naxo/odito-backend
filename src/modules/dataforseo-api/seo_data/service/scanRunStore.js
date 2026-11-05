import SeoScanRun, { ACTIVE_STATUSES } from '../model/SeoScanRun.js';

/**
 * The MongoDB side of the scan queue, the per-project lock and scan state. Every operation is ONE atomic statement, so any number of web
 * instances and workers can call these at once:
 *
 *   tryAcquire   one insert (status `queued`) carrying lockKey = projectId; the partial unique index rejects a second active scan (E11000) -> null
 *   claimNext    one findOneAndUpdate: takes the oldest due `queued` scan, or a `running` scan whose lease expired (its worker died) -> that worker owns it
 *   heartbeat    extends the lease, only while THIS worker still owns the scan
 *   requeue      hands a scan back to the queue (graceful shutdown, a transient failure) keeping every completed dataset
 *   finish       ends a scan and REMOVES lockKey (the unique index only covers string values)
 *
 * seoScanService / the worker take this object as a dependency, so their logic is tested against an in-memory implementation of the same contract.
 */

const DUPLICATE_KEY = 11000;

// The lock IS the unique index: a scan must never start where it is not guaranteed to exist (autoIndex may be off in production).
let indexesReady = null;
const ensureIndexes = () => { indexesReady ??= SeoScanRun.createIndexes().catch((err) => { indexesReady = null; throw err; }); return indexesReady; };

export const mongoRunStore = {
  /** @returns {Promise<object|null>} the created (queued) run, or null when the project already has an active scan */
  async tryAcquire(doc) {
    await ensureIndexes();
    try {
      const created = await SeoScanRun.create({ ...doc, status: 'queued', lockKey: String(doc.projectId) });
      return created.toObject();
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) return null;
      throw err;
    }
  },

  async findActive(projectId) {
    return SeoScanRun.findOne({ projectId, lockKey: String(projectId) }).lean();
  },

  /**
   * Atomically takes the next scan to work on: a due queued scan, or a running one whose lease ran out. Returns it as the claimant sees it
   * (status running, attempts incremented, lease extended) or null. A claim never takes a scan another worker still holds.
   */
  async claimNext({ workerId, now, leaseMs }) {
    return SeoScanRun.findOneAndUpdate(
      {
        lockKey: { $type: 'string' },
        $or: [
          { status: 'queued', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
          { status: 'running', leaseUntil: { $lt: now } },
        ],
      },
      [{ $set: {
        status: 'running',
        workerId,
        leaseUntil: new Date(now.getTime() + leaseMs),
        startedAt: { $ifNull: ['$startedAt', now] },
        attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
        // A dataset the dead worker had started goes back to pending; completed ones stay completed.
        datasets: { $map: { input: '$datasets', as: 'd', in: { $cond: [{ $eq: ['$$d.status', 'running'] }, { $mergeObjects: ['$$d', { status: 'pending' }] }, '$$d'] } } },
      } }],
      { sort: { createdAt: 1 }, new: true },
    ).lean();
  },

  /** @returns {Promise<boolean>} false = this worker no longer owns the scan (it was taken over) */
  async heartbeat(runId, workerId, leaseUntil) {
    const res = await SeoScanRun.updateOne({ _id: runId, workerId, status: 'running', lockKey: { $type: 'string' } }, { $set: { leaseUntil } });
    return res.matchedCount === 1;
  },

  /** Gives the scan back to the queue (delayed by `nextAttemptAt`), for the next claim. Only the owner can do it. */
  async requeue(runId, workerId, { nextAttemptAt }) {
    const res = await SeoScanRun.updateOne(
      { _id: runId, workerId, status: 'running', lockKey: { $type: 'string' } },
      { $set: { status: 'queued', nextAttemptAt, leaseUntil: null }, $unset: { workerId: 1 } },
    );
    return res.matchedCount === 1;
  },

  /** One dataset's state, with its counter increments in the SAME statement so a crash cannot leave them disagreeing. */
  async updateDataset(runId, datasetId, patch, inc = {}) {
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`datasets.$.${k}`, v]));
    const update = { $set: set };
    if (Object.keys(inc).length) update.$inc = inc;
    await SeoScanRun.updateOne({ _id: runId, 'datasets.id': datasetId }, update);
  },

  /** Ends the scan and frees the lock. */
  async finish(runId, { status, error = null, now }) {
    return SeoScanRun.findOneAndUpdate(
      { _id: runId },
      { $set: { status, error, finishedAt: now, leaseUntil: null }, $unset: { lockKey: 1, workerId: 1 } },
      { new: true },
    ).lean();
  },

  async get(projectId, runId) {
    return SeoScanRun.findOne({ _id: runId, projectId }).lean();
  },

  async getById(runId) {
    return SeoScanRun.findById(runId).lean();
  },

  async latest(projectId) {
    return SeoScanRun.findOne({ projectId }).sort({ createdAt: -1 }).lean();
  },

  async list(projectId, limit = 10) {
    return SeoScanRun.find({ projectId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(1, limit), 20)).lean();
  },
};

export { ACTIVE_STATUSES };
