import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

/**
 * Bulk Upload — Phase 5. Recovery scheduler gating + runOnce plumbing.
 * The schedulers read their env config at module-top-level (matching
 * staleLockScheduler / verificationBatchRecoveryScheduler), so each test
 * re-imports the module with a cache-busting query string.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

async function freshImport(env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import(`./bulkImportRecoveryScheduler.js?t=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  delete process.env.BULK_IMPORT_RECOVERY_ENABLED;
  delete process.env.BULK_IMPORT_RECOVERY_CRON;
  delete process.env.BULK_IMPORT_STALE_THRESHOLD_MS;
});

describe('bulkImportRecoveryScheduler', () => {
  test('disabled via BULK_IMPORT_RECOVERY_ENABLED=false → start() returns null, no task', async () => {
    const mod = await freshImport({ BULK_IMPORT_RECOVERY_ENABLED: 'false' });
    assert.equal(mod.startBulkImportRecoveryScheduler(), null);
    assert.equal(mod.getSchedulerHealth().enabled, false);
    assert.equal(mod.getSchedulerHealth().running, false);
  });

  test('enabled by default → start() registers a cron task, stop() clears it, double-start is a no-op', async () => {
    const mod = await freshImport({ BULK_IMPORT_RECOVERY_ENABLED: undefined });
    const t1 = mod.startBulkImportRecoveryScheduler();
    assert.ok(t1);
    assert.equal(mod.getSchedulerHealth().running, true);
    const t2 = mod.startBulkImportRecoveryScheduler();
    assert.equal(t2, t1, 'second start returns the same task');
    mod.stopBulkImportRecoveryScheduler();
    assert.equal(mod.getSchedulerHealth().running, false);
  });

  test('the cron expression and threshold are env-overridable', async () => {
    const mod = await freshImport({ BULK_IMPORT_RECOVERY_CRON: '*/7 * * * *', BULK_IMPORT_STALE_THRESHOLD_MS: '123000' });
    const h = mod.getSchedulerHealth();
    assert.equal(h.cronExpression, '*/7 * * * *');
    assert.equal(h.staleThresholdMs, 123000);
  });

  test('runOnce() performs a real (empty) sweep and records lastRun', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const mod = await freshImport();
    const res = await mod.runOnce();
    assert.ok(res && typeof res.recovered === 'number' && typeof res.checked === 'number');
    const h = mod.getSchedulerHealth();
    assert.ok(h.lastRun);
    assert.ok(h.lastRun.at instanceof Date);
    assert.equal(typeof h.lastRun.durationMs, 'number');
  });
});
