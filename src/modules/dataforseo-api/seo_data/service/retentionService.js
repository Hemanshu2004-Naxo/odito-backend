import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoScanRun from '../model/SeoScanRun.js';
import SeoProviderRequest from '../model/SeoProviderRequest.js';
import { KINDS, STATE_PART, STATE_TYPE } from '../datasets/definitions.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Retention for the stored row sets. NOTHING here runs by itself: it is a function the CLI (scripts/retention.js) calls, dry-run by default.
 *
 * Rules (per project and dataset, i.e. per "complete scan" history of keywords / backlinks live / backlinks lost / ...):
 *   - the NEWEST complete scan is always kept, however old it is (the pages read it);
 *   - the newest `keepScans` complete scans are kept, and any scan newer than `maxAgeDays`;
 *   - a scan that is still active (queued / running) is never touched, nor are the rows it is writing;
 *   - a removed scan loses its rows AND its state snapshot together, so a comparison can never point at a scan whose rows are gone;
 *   - rows of a scan that never completed (a failed or abandoned collection: they have no state snapshot) are removed once older than
 *     `orphanHours` (nothing reads them);
 *   - provider request ledger rows older than `ledgerDays` are removed; summary snapshots (small, one per real purchase) are kept.
 * Deletes run in batches by _id with a pause between them, so a large clean-up does not spike the database.
 */

export const RETENTION_DEFAULTS = Object.freeze({
  keepScans: Math.max(1, Number.parseInt(process.env.SEO_RETENTION_KEEP_SCANS, 10) || 8),
  maxAgeDays: Math.max(1, Number.parseInt(process.env.SEO_RETENTION_MAX_AGE_DAYS, 10) || 180),
  orphanHours: Math.max(1, Number.parseInt(process.env.SEO_RETENTION_ORPHAN_HOURS, 10) || 48),
  ledgerDays: Math.max(30, Number.parseInt(process.env.SEO_RETENTION_LEDGER_DAYS, 10) || 400),
  batchSize: Math.max(10, Math.min(5000, Number.parseInt(process.env.SEO_RETENTION_BATCH, 10) || 1000)),
  pauseMs: Math.max(0, Number.parseInt(process.env.SEO_RETENTION_PAUSE_MS, 10) || 100),
});

const KIND_BY_PART = Object.fromEntries(Object.entries(STATE_PART).map(([kind, part]) => [part, kind]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 86_400_000;

/** Pure: which complete scans of one dataset to keep. `states` newest first. */
export function chooseScans(states, { now, keepScans, maxAgeDays, activeScanIds = new Set() }) {
  const keep = []; const remove = [];
  states.forEach((s, i) => {
    const young = new Date(s.capturedAt).getTime() >= now.getTime() - maxAgeDays * DAY;
    if (i === 0 || i < keepScans || young || activeScanIds.has(String(s.scanId))) keep.push(s); else remove.push(s);
  });
  return { keep, remove };
}

async function deleteInBatches(model, filter, { dryRun, batchSize, pauseMs }) {
  if (dryRun) return model.countDocuments(filter);
  let deleted = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const ids = await model.find(filter).select('_id').limit(batchSize).lean();
    if (!ids.length) return deleted;
    // eslint-disable-next-line no-await-in-loop
    const res = await model.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
    deleted += res.deletedCount ?? 0;
    // eslint-disable-next-line no-await-in-loop
    if (pauseMs) await sleep(pauseMs);
  }
}

/**
 * @param {{ dryRun?: boolean, projectId?: any, now?: Date, keepScans?: number, maxAgeDays?: number, orphanHours?: number, ledgerDays?: number, batchSize?: number, pauseMs?: number }} [options]
 * @returns {Promise<{ dryRun: boolean, groups: object[], totals: object }>}
 */
export async function runRetention(options = {}) {
  const cfg = { ...RETENTION_DEFAULTS, dryRun: true, now: new Date(), ...options };
  const { dryRun, now } = cfg;
  const log = (message, data) => LoggerUtil.info(`SEO retention${dryRun ? ' (dry run)' : ''}: ${message}`, data);

  const scope = cfg.projectId ? { projectId: cfg.projectId } : {};
  const groups = await SeoSnapshot.aggregate([
    { $match: { ...scope, datasetType: { $in: Object.values(STATE_TYPE) } } },
    { $group: { _id: { projectId: '$projectId', part: '$part', variant: '$variant' } } },
  ]);

  const report = [];
  const totals = { scansRemoved: 0, rowsDeleted: 0, stateSnapshotsDeleted: 0, orphanRowsDeleted: 0, ledgerRowsDeleted: 0 };
  const activeByProject = new Map();
  const activeIds = async (projectId) => {
    const key = String(projectId);
    if (!activeByProject.has(key)) {
      const runs = await SeoScanRun.find({ projectId, lockKey: { $type: 'string' } }).select('_id').lean();
      activeByProject.set(key, new Set(runs.map((r) => String(r._id))));
    }
    return activeByProject.get(key);
  };

  for (const { _id: g } of groups) {
    const kind = KIND_BY_PART[g.part];
    if (!kind) continue;
    const { model } = KINDS[kind];
    const active = await activeIds(g.projectId);
    const states = await SeoSnapshot.find({ projectId: g.projectId, datasetType: STATE_TYPE[kind], part: g.part, variant: g.variant }).sort({ capturedAt: -1 }).select('scanId capturedAt').lean();
    const { keep, remove } = chooseScans(states, { now, ...cfg, activeScanIds: active });
    const removeIds = remove.map((s) => s.scanId);
    const keepIds = new Set(states.map((s) => String(s.scanId)));
    for (const id of removeIds) keepIds.delete(String(id));

    let rowsDeleted = 0; let stateDeleted = 0; let orphanDeleted = 0;
    const statusFilter = g.variant ? { status: g.variant } : {};
    if (removeIds.length) {
      rowsDeleted = await deleteInBatches(model, { projectId: g.projectId, scanId: { $in: removeIds }, ...statusFilter }, cfg);
      stateDeleted = dryRun
        ? remove.length
        : (await SeoSnapshot.deleteMany({ projectId: g.projectId, datasetType: STATE_TYPE[kind], part: g.part, variant: g.variant, scanId: { $in: removeIds } })).deletedCount;
    }
    // Rows of scans that never completed: not a kept scan, not an active one, and old enough to be sure nothing is still writing them.
    const cutoff = new Date(now.getTime() - cfg.orphanHours * 3_600_000);
    const known = [...states.map((s) => s.scanId)];
    const candidates = await model.aggregate([
      { $match: { projectId: g.projectId, ...statusFilter, scanId: { $nin: known } } },
      { $group: { _id: '$scanId', newest: { $max: '$capturedAt' } } },
      { $match: { newest: { $lt: cutoff } } },
    ]);
    const orphanScans = candidates.map((c) => c._id).filter((id) => !active.has(String(id)));
    if (orphanScans.length) orphanDeleted = await deleteInBatches(model, { projectId: g.projectId, ...statusFilter, scanId: { $in: orphanScans } }, cfg);

    report.push({
      projectId: String(g.projectId), dataset: g.part, variant: g.variant || null, scansKept: keep.length, scansRemoved: remove.length, rowsDeleted, stateSnapshotsDeleted: stateDeleted, orphanScans: orphanScans.length, orphanRowsDeleted: orphanDeleted,
    });
    totals.scansRemoved += remove.length; totals.rowsDeleted += rowsDeleted; totals.stateSnapshotsDeleted += stateDeleted; totals.orphanRowsDeleted += orphanDeleted;
    if (remove.length || orphanScans.length) log('dataset cleaned', report.at(-1));
  }

  totals.ledgerRowsDeleted = await deleteInBatches(SeoProviderRequest, { ...scope, startedAt: { $lt: new Date(now.getTime() - cfg.ledgerDays * DAY) } }, cfg);
  log('finished', totals);
  return { dryRun, groups: report, totals };
}
