import mongoose from 'mongoose';
import { startScan, ScanConflict, toPublicRun } from '../service/seoScanService.js';
import { mongoRunStore } from '../service/scanRunStore.js';
import { listSnapshots, compareToPrevious, DATASET_TYPES, DATASET_ALIASES, COMPARISON_PERIODS, SNAPSHOT_RULES } from '../service/snapshotService.js';
import { sendError } from '../../domain_overview/controller/domainOverviewController.js';
import { ValidationFailure } from '../../shared/targetDomain.js';

/**
 * Runs AFTER auth + validateProjectAccess(): `req.project` is a project the authenticated user owns. The domain and market come from the
 * project, never from the request. None of these handlers can reach the provider except POST /seo-scans (an explicit scan).
 */

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** POST /projects/:projectId/seo-scans  { scope, datasets?, force?, retryOf? } -> 202 */
export async function postScan(req, res) {
  try {
    const { scope, datasets, force, retryOf } = req.body ?? {};
    if (typeof scope !== 'string' && !retryOf) throw new ValidationFailure('scope', 'scope is required');
    if (force !== undefined && typeof force !== 'boolean') throw new ValidationFailure('force', 'force must be true or false');
    if (retryOf !== undefined && !mongoose.isValidObjectId(retryOf)) throw new ValidationFailure('retryOf', 'retryOf must be a scan id');
    const { run, deduped } = await startScan({
      project: req.project, userId: String(req.user?._id || ''), scope, datasets, force: force === true, retryOf: retryOf ?? null,
    });
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ success: true, data: { scan: toPublicRun(run), deduped } });
  } catch (err) {
    if (err instanceof ScanConflict) {
      return res.status(409).json({ success: false, code: err.code, message: err.message, data: { scan: toPublicRun(err.active) } });
    }
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-scans' });
  }
}

/** GET /projects/:projectId/seo-scans/latest -> the newest scan (any status) or null. A scan whose worker died is reported (and freed) here. */
export async function getLatestScan(req, res) {
  try {
    const run = await mongoRunStore.latest(req.project._id);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { scan: toPublicRun(run) } });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-scans/latest' });
  }
}

/** GET /projects/:projectId/seo-scans -> recent scans, newest first (max 20). */
export async function listScans(req, res) {
  try {
    const limit = Number.parseInt(one(req.query.limit), 10);
    const runs = await mongoRunStore.list(req.project._id, Number.isInteger(limit) ? limit : 10);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { scans: runs.map((r) => toPublicRun(r)) } });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-scans' });
  }
}

/** GET /projects/:projectId/seo-scans/:scanId (scoped to the project: another project's scan id is a 404). */
export async function getScan(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.scanId)) throw new ValidationFailure('scanId', 'A valid scanId is required');
    const run = await mongoRunStore.get(req.project._id, req.params.scanId);
    if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Scan not found.' });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { scan: toPublicRun(run) } });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-scans/:id' });
  }
}

function parseDate(name, raw) {
  if (raw === undefined) return null;
  const d = new Date(String(one(raw)));
  if (Number.isNaN(d.getTime())) throw new ValidationFailure(name, `${name} must be an ISO date`);
  return d;
}

function parseDatasetType(raw) {
  const type = one(raw);
  if (typeof type !== 'string' || !(DATASET_TYPES.includes(type) || Object.hasOwn(DATASET_ALIASES, type))) {
    throw new ValidationFailure('datasetType', `datasetType must be one of ${[...DATASET_TYPES, ...Object.keys(DATASET_ALIASES)].join(', ')}`);
  }
  return type;
}

const parsePart = (raw, type) => {
  const part = one(raw);
  if (part === undefined) return null;
  const allowed = Object.entries(SNAPSHOT_RULES).filter(([, r]) => r.datasetType === (DATASET_ALIASES[type] ?? type)).map(([s]) => s);
  if (typeof part !== 'string' || !allowed.includes(part)) throw new ValidationFailure('part', `part must be one of ${allowed.join(', ')}`);
  return part;
};

/** GET /projects/:projectId/seo-snapshots?datasetType&part&from&to&limit -> stored history (MongoDB only). */
export async function getSnapshots(req, res) {
  try {
    const datasetType = parseDatasetType(req.query.datasetType);
    const part = parsePart(req.query.part, datasetType);
    const limit = Number.parseInt(one(req.query.limit), 10);
    const rows = await listSnapshots({
      projectId: req.project._id, datasetType, part, from: parseDate('from', req.query.from), to: parseDate('to', req.query.to), limit: Number.isInteger(limit) ? limit : 50,
    });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { snapshots: rows.map(toPublicSnapshot) } });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-snapshots' });
  }
}

/** GET /projects/:projectId/seo-snapshots/comparison?datasetType&part&period=week|month -> { latest, previous } (previous null = not enough history). */
export async function getComparison(req, res) {
  try {
    const datasetType = parseDatasetType(req.query.datasetType);
    const part = parsePart(req.query.part, datasetType);
    if (!part) throw new ValidationFailure('part', 'part is required');
    const period = one(req.query.period);
    if (!COMPARISON_PERIODS.includes(period)) throw new ValidationFailure('period', `period must be one of ${COMPARISON_PERIODS.join(', ')}`);
    const { latest, previous } = await compareToPrevious({ projectId: req.project._id, datasetType, part, period });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { period, latest: latest && toPublicSnapshot(latest), previous: previous && toPublicSnapshot(previous) } });
  } catch (err) {
    return sendError(res, err, { projectId: String(req.project?._id || ''), route: 'seo-snapshots/comparison' });
  }
}

const toPublicSnapshot = (s) => ({ id: String(s._id), datasetType: s.datasetType, part: s.part, variant: s.variant, capturedAt: s.capturedAt, scanId: s.scanId ? String(s.scanId) : null, data: s.data });
