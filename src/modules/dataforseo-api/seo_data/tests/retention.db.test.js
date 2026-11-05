import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoScanRun from '../model/SeoScanRun.js';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoBacklink from '../model/SeoBacklink.js';
import SeoProviderRequest from '../model/SeoProviderRequest.js';
import { runRetention, chooseScans } from '../service/retentionService.js';
import { STATE_PART, STATE_TYPE } from '../datasets/definitions.js';

/**
 * Retention against a real MongoDB. Every document is created under throwaway project ids and removed in after().
 */

let mongoAvailable = false;
const DAY = 86_400_000;
const NOW = new Date('2026-11-05T12:00:00Z');
const oid = () => new mongoose.Types.ObjectId();
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const projects = [];
const newProject = () => { const id = oid(); projects.push(id); return id; };
const opts = (projectId, over = {}) => ({ projectId, now: NOW, keepScans: 2, maxAgeDays: 10, orphanHours: 48, ledgerDays: 400, batchSize: 10, pauseMs: 0, ...over });

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { /* skipped below */ }
});

after(async () => {
  if (mongoAvailable) {
    await Promise.all([SeoSnapshot, SeoScanRun, SeoKeywordRanking, SeoBacklink, SeoProviderRequest].map((m) => m.deleteMany({ projectId: { $in: projects } })));
    await mongoose.connection.close();
  }
});

async function seedKeywordScan(projectId, ageDays, { rows = 3, state = true } = {}) {
  const scanId = oid();
  await SeoKeywordRanking.insertMany(Array.from({ length: rows }, (_, i) => ({
    projectId, domain: 'retention.example.com', scanId, nk: `${scanId}-${i}`, keyword: `k${i}`, normalizedKeyword: `k${i}`, row: { keyword: `k${i}` }, capturedAt: ago(ageDays),
  })));
  if (state) {
    await SeoSnapshot.create({
      projectId, domain: 'retention.example.com', scanId, datasetType: STATE_TYPE.keywords, part: STATE_PART.keywords, variant: '', data: { scanId: String(scanId), rows }, capturedAt: ago(ageDays), source: 'scan',
    });
  }
  return scanId;
}
const rowsOf = (projectId) => SeoKeywordRanking.distinct('scanId', { projectId }).then((ids) => ids.map(String));
const statesOf = (projectId) => SeoSnapshot.distinct('scanId', { projectId, part: STATE_PART.keywords }).then((ids) => ids.map(String));

describe('chooseScans (pure)', () => {
  const s = (age) => ({ scanId: `s${age}`, capturedAt: ago(age) });
  test('keeps the newest always, the newest N, and anything inside the age window; removes the rest', () => {
    const states = [s(1), s(5), s(30), s(60), s(90)];
    const r = chooseScans(states, { now: NOW, keepScans: 2, maxAgeDays: 10 });
    assert.deepEqual(r.keep.map((x) => x.scanId), ['s1', 's5']);
    assert.deepEqual(r.remove.map((x) => x.scanId), ['s30', 's60', 's90']);
  });
  test('the newest scan survives even when it is older than the window, and an active scan is never removed', () => {
    const old = [s(100), s(200), s(300)];
    assert.deepEqual(chooseScans(old, { now: NOW, keepScans: 1, maxAgeDays: 10 }).keep.map((x) => x.scanId), ['s100']);
    assert.deepEqual(chooseScans(old, { now: NOW, keepScans: 1, maxAgeDays: 10, activeScanIds: new Set(['s300']) }).keep.map((x) => x.scanId), ['s100', 's300']);
  });
});

describe('runRetention (real MongoDB)', () => {
  test('a dry run reports exactly what would go and changes nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject();
    const [a, b, c, d] = [await seedKeywordScan(p, 1), await seedKeywordScan(p, 5), await seedKeywordScan(p, 40, { rows: 5 }), await seedKeywordScan(p, 90, { rows: 7 })];
    const out = await runRetention(opts(p, { dryRun: true }));
    assert.equal(out.dryRun, true);
    assert.deepEqual([out.totals.scansRemoved, out.totals.rowsDeleted, out.totals.stateSnapshotsDeleted], [2, 12, 2]);
    assert.deepEqual((await rowsOf(p)).sort(), [a, b, c, d].map(String).sort());
    assert.equal((await statesOf(p)).length, 4);
  });

  test('apply removes old scans (rows AND state together) in batches, keeps the newest ones, and a second run finds nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject();
    const [a, b, c, d] = [await seedKeywordScan(p, 1), await seedKeywordScan(p, 5), await seedKeywordScan(p, 40, { rows: 25 }), await seedKeywordScan(p, 90, { rows: 7 })];
    const out = await runRetention(opts(p, { dryRun: false, batchSize: 10 }));
    assert.deepEqual([out.totals.scansRemoved, out.totals.rowsDeleted, out.totals.stateSnapshotsDeleted], [2, 32, 2]);
    assert.deepEqual((await rowsOf(p)).sort(), [a, b].map(String).sort());
    assert.deepEqual((await statesOf(p)).sort(), [a, b].map(String).sort(), 'no state points at a scan whose rows are gone');
    const again = await runRetention(opts(p, { dryRun: false }));
    assert.deepEqual([again.totals.scansRemoved, again.totals.rowsDeleted, again.totals.orphanRowsDeleted], [0, 0, 0]);
  });

  test('the newest scan is kept even when it is older than the window; an active scan\'s rows are never touched', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject();
    const only = await seedKeywordScan(p, 300);
    const oldActive = await seedKeywordScan(p, 200, { state: true });
    // the second scan is still ACTIVE (queued): it must survive although it is far outside the window
    await SeoScanRun.collection.insertOne({ _id: oldActive, projectId: p, domain: 'retention.example.com', scope: 'dataset', status: 'queued', lockKey: String(p), datasets: [], createdAt: new Date(), updatedAt: new Date() });
    await runRetention(opts(p, { dryRun: false, keepScans: 1 }));
    const kept = await rowsOf(p);
    assert.ok(kept.includes(String(oldActive)), 'active scan data is never deleted');
    // `only` is OLDER than the active one, so with keepScans=1 the newest (by capture time) is the active one and this old one may go
    assert.ok((await statesOf(p)).includes(String(oldActive)));
  });

  test('rows of a scan that never completed are removed only once old enough, and only when no scan is active for them', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject();
    const kept = await seedKeywordScan(p, 1);
    const staleOrphan = await seedKeywordScan(p, 10, { state: false, rows: 4 }); // a collection that failed halfway 10 days ago
    const freshOrphan = await seedKeywordScan(p, 0.2, { state: false, rows: 4 }); // a collection that may still be running
    const out = await runRetention(opts(p, { dryRun: false }));
    assert.equal(out.totals.orphanRowsDeleted, 4);
    const left = await rowsOf(p);
    assert.ok(left.includes(String(kept)) && left.includes(String(freshOrphan)));
    assert.ok(!left.includes(String(staleOrphan)));
  });

  test('another project is never touched, and status-specific datasets only lose their own status', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject(); const other = newProject();
    await seedKeywordScan(other, 100); await seedKeywordScan(other, 200);
    // one backlinks scan with a live and a lost state
    const scanId = oid();
    const mk = (status) => ({ projectId: p, domain: 'retention.example.com', scanId, status, nk: `${status}-1`, row: {}, capturedAt: ago(60) });
    await SeoBacklink.insertMany([mk('live'), mk('lost')]);
    const state = (variant, age) => ({ projectId: p, domain: 'retention.example.com', scanId: variant === 'live' ? scanId : scanId, datasetType: STATE_TYPE.backlinks, part: STATE_PART.backlinks, variant, data: { rows: 1 }, capturedAt: ago(age), source: 'scan' });
    const newer = oid();
    await SeoBacklink.insertMany([{ ...mk('live'), scanId: newer, nk: 'n-live', capturedAt: ago(1) }, { ...mk('live'), scanId: newer, nk: 'n-live2', capturedAt: ago(1) }]);
    await SeoSnapshot.create([state('live', 60), state('lost', 60), { ...state('live', 1), scanId: newer }]);
    const before = await SeoKeywordRanking.countDocuments({ projectId: other });
    const out = await runRetention(opts(p, { dryRun: false, keepScans: 1 }));
    assert.equal(await SeoKeywordRanking.countDocuments({ projectId: other }), before, 'untouched');
    assert.equal(out.totals.scansRemoved, 1, 'only the old LIVE scan; the lost dataset has just one scan, which is its newest');
    assert.equal(await SeoBacklink.countDocuments({ projectId: p, scanId, status: 'live' }), 0);
    assert.equal(await SeoBacklink.countDocuments({ projectId: p, scanId, status: 'lost' }), 1);
  });

  test('old ledger rows are removed, recent ones kept', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const p = newProject();
    const base = { projectId: p, trigger: 'scan', dataset: 'history', endpoint: 'x', target: 'retention.example.com', success: true };
    await SeoProviderRequest.insertMany([{ ...base, startedAt: ago(500) }, { ...base, startedAt: ago(2) }]);
    const out = await runRetention(opts(p, { dryRun: false }));
    assert.equal(out.totals.ledgerRowsDeleted, 1);
    assert.equal(await SeoProviderRequest.countDocuments({ projectId: p }), 1);
  });
});
