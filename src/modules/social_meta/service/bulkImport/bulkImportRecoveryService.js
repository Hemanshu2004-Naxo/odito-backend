import SocialImportBatch from '../../model/SocialImportBatch.js';
import { emitBulkImportError } from './bulkImportEvents.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Bulk Upload — Phase 5 stale-import recovery.
 *
 * A bulk import runs synchronously inside the Express request handler
 * (bulkImportExecutor). If that Node process dies mid-import (deploy,
 * OOM, kill), the batch is left in `status: 'importing'` forever — the
 * one-active-import-per-project unique index then blocks every future
 * upload for that project, and the wizard shows a spinner that never
 * resolves.
 *
 * This sweeper flips a *genuinely* abandoned `importing` batch back to
 * `failed` (which the executor's claim filter treats as re-claimable —
 * see SocialImportBatch STATUS_TRANSITIONS `failed -> importing`), so the
 * user can simply retry. It:
 *
 *   - only considers batches with NO heartbeat for `staleThresholdMs`
 *     (default 10 min) — far longer than a real import's sub-second run;
 *   - CANNOT race a slow-but-alive worker: the recovery write is
 *     conditioned on the exact `importClaimId` it observed AND the
 *     heartbeat still being old, so a worker that heartbeats (or
 *     completes) between the sweeper's read and its write makes the
 *     write a no-op;
 *   - NEVER touches SocialPublication — no deletes, no creates;
 *   - records `recoveredAt` + `recoveryReason`;
 *   - is safe to run repeatedly (a recovered batch is no longer
 *     `importing`, so the next sweep skips it).
 */

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 50; // defensive cap — recovering one batch is a couple of indexed ops

/**
 * @param {{ staleThresholdMs?: number }} [opts]
 * @returns {Promise<{ checked: number, recovered: number, skipped: number }>}
 */
export async function recoverStaleImportingBatches({ staleThresholdMs = DEFAULT_STALE_MS } = {}) {
  const threshold = new Date(Date.now() - staleThresholdMs);

  // A batch is a candidate when it is still `importing` and either its
  // heartbeat is older than the threshold, or (a pre-Phase-5 / never-
  // heartbeated batch) its `updatedAt` is. Ordered oldest-first.
  const candidateFilter = {
    status: 'importing',
    $or: [
      { importHeartbeatAt: { $lte: threshold } },
      { importHeartbeatAt: null, updatedAt: { $lte: threshold } },
    ],
  };

  const candidates = await SocialImportBatch.find(candidateFilter)
    .select('_id project_id importClaimId importHeartbeatAt importStartedAt updatedAt')
    .sort({ importHeartbeatAt: 1, updatedAt: 1 })
    .limit(MAX_PER_RUN)
    .lean();

  let recovered = 0;
  let skipped = 0;

  for (const c of candidates) {
    const res = await SocialImportBatch.updateOne(
      {
        _id: c._id,
        status: 'importing',
        // Same execution we observed — a fresh re-claim mints a new id
        // and a new heartbeat, so both guards below would fail for it.
        importClaimId: c.importClaimId ?? null,
        $or: [
          { importHeartbeatAt: { $lte: threshold } },
          { importHeartbeatAt: null, updatedAt: { $lte: threshold } },
        ],
      },
      {
        $set: {
          status: 'failed',
          importClaimId: null,
          recoveredAt: new Date(),
          recoveryReason: 'stale_importing_no_heartbeat',
          errorSummary: 'This import was interrupted and did not finish. It is safe to retry.',
        },
      },
    );

    if (res.modifiedCount === 1) {
      recovered += 1;
      const lastBeat = c.importHeartbeatAt || c.updatedAt;
      const staleForMs = lastBeat ? Date.now() - new Date(lastBeat).getTime() : null;
      LoggerUtil.service('BulkImportRecovery', 'recover', 'completed', {
        projectId: c.project_id ? String(c.project_id) : null,
        batchId: String(c._id),
        importClaimId: c.importClaimId || null,
        staleForMs,
        recoveryReason: 'stale_importing_no_heartbeat',
      });
      // Nudge any listening wizard into its recoverable/retry state. The
      // batch GET is still the authoritative source; this just avoids a
      // stuck spinner.
      if (c.project_id) {
        emitBulkImportError({
          projectId: c.project_id,
          batchId: c._id,
          code: 'IMPORT_INTERRUPTED',
          message: 'This import was interrupted and did not finish. It is safe to retry.',
        });
      }
    } else {
      // The worker heartbeated / completed, or a re-claim happened,
      // between our read and this write — correctly left alone.
      skipped += 1;
    }
  }

  return { checked: candidates.length, recovered, skipped };
}

export default { recoverStaleImportingBatches };
