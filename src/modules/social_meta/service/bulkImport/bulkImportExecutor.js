import mongoose from 'mongoose';
import crypto from 'crypto';
import SocialImportBatch, { IMPORT_MODES, canTransitionBatchStatus } from '../../model/SocialImportBatch.js';
import SocialImportRow from '../../model/SocialImportRow.js';
import SocialPublication from '../../model/SocialPublication.js';
import { isPublishingReady } from '../../model/SocialAccount.js';
import { createPublication } from '../socialPublishingService.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../facebookAccountService.js';
import { isOwnedUrl } from '../media/mediaStorageService.js';
import { SUPPORTED_PLATFORMS, BULK_ERROR } from './bulkImportConstants.js';
import {
  emitBulkImportStarted, emitBulkImportProgress, emitBulkImportCompleted, emitBulkImportError,
} from './bulkImportEvents.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Bulk Upload — Phase 3 executor: turn a READY import batch's validated
 * rows into real SocialPublication records.
 *
 * Hard rules (enforced structurally here):
 *   - Reuses the EXISTING createPublication() for every record — no
 *     second publishing/validation path, no direct SocialPublication
 *     writes for the row content.
 *   - NEVER calls publishNow()/Meta inside this request. `action=publish`
 *     rows are created as an immediately-due `scheduled` publication; the
 *     existing socialSchedulerService cron does the real, irreversible
 *     post.
 *   - Only `status: 'valid'` rows are ever imported (both modes). Invalid
 *     rows are never silently turned into drafts.
 *   - Fully idempotent: an atomic batch claim, a per-row publication link
 *     + a lookup by {importBatchId, importRowNumber}, and E11000 recovery
 *     mean a retried / concurrent / replayed import never double-creates.
 */

const IN_PROGRESS_OFFSET_MS = 1000; // `publish` rows: "immediately due" without being exactly now

// The executor writes a heartbeat (and live counts) to the batch every
// this-many rows. With a 200-row cap and no Meta calls in the loop, an
// import normally finishes in well under a second — a heartbeat this
// often means the stale sweeper's threshold (minutes) can only ever fire
// on a genuinely dead process, never a slow-but-alive one.
const HEARTBEAT_EVERY_ROWS = 25;

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/** Recompute imported/failed/drafts/scheduled from ACTUAL state — stable across replays. */
async function computeImportCounts(batchOid) {
  const [rowAgg, pubAgg] = await Promise.all([
    SocialImportRow.aggregate([
      { $match: { batch_id: batchOid } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SocialPublication.aggregate([
      { $match: { importBatchId: batchOid } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ]);
  const rowByStatus = Object.fromEntries(rowAgg.map((r) => [r._id, r.n]));
  const pubTotal = pubAgg.reduce((a, r) => a + r.n, 0);
  const drafts = pubAgg.find((r) => r._id === 'draft')?.n || 0;
  return {
    imported: rowByStatus.imported || 0,
    failed: rowByStatus.failed || 0,
    drafts,
    // Anything that isn't a draft was created as `scheduled` (the cron
    // may since have moved it to publishing/published/failed — it still
    // counts as "created scheduled").
    scheduled: pubTotal - drafts,
  };
}

/** Safe, sensitive-data-free result envelope — also used for the completed replay. */
async function buildImportResult(batchDoc) {
  const rows = await SocialImportRow.find({ batch_id: batchDoc._id })
    .sort({ rowNumber: 1 })
    .select('rowNumber status publication_id errors')
    .lean();
  const pubs = await SocialPublication.find({ importBatchId: batchDoc._id }).select('status').lean();

  const imported = rows.filter((r) => r.status === 'imported').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const attempted = imported + failed;
  const drafts = pubs.filter((p) => p.status === 'draft').length;
  const scheduled = pubs.length - drafts;

  const schedulerEnabled = process.env.SOCIAL_SCHEDULER_ENABLED === 'true';
  const warnings = [];
  if (!schedulerEnabled && scheduled > 0) {
    warnings.push("Scheduled publishing is disabled on this environment (SOCIAL_SCHEDULER_ENABLED is not 'true'); scheduled and publish-now rows were imported as scheduled but will not go out automatically until it is enabled.");
  }

  const c = batchDoc.counts || {};
  return {
    batch: {
      id: batchDoc._id.toString(),
      status: batchDoc.status,
      importMode: batchDoc.importMode || null,
      counts: {
        total: c.total ?? 0,
        valid: c.valid ?? 0,
        invalid: c.invalid ?? 0,
        imported: c.imported ?? 0,
        failed: c.failed ?? 0,
        drafts: c.drafts ?? 0,
        scheduled: c.scheduled ?? 0,
      },
    },
    result: { attempted, imported, failed, drafts, scheduled },
    schedulerEnabled,
    warnings,
    rows: rows.map((r) => ({
      rowNumber: r.rowNumber,
      status: r.status,
      publicationId: r.publication_id ? r.publication_id.toString() : null,
      errors: Array.isArray(r.errors) ? r.errors.map((e) => ({ field: e.field ?? null, code: e.code, message: e.message })) : [],
    })),
  };
}

/**
 * Revalidate one row's mutable state, then create its publication via the
 * existing createPublication(). Returns `{ success, publicationId, kind }`
 * (kind: 'draft' | 'scheduled') or
 * `{ success: false, error: { field, code, message } }`.
 */
async function importOneRow({ row, projectId, userId, batchOid, mode, resolveAccount }) {
  const n = row.normalized || {};
  const platform = n.platform;

  if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
    return { success: false, error: { field: 'platform', code: BULK_ERROR.UNSUPPORTED_PLATFORM, message: `Platform "${platform || ''}" is not supported.` } };
  }

  // ── account: still exists / this project / this platform / active ──
  const account = await resolveAccount(platform);
  if (!account
    || account.status !== 'active'
    || account.platform !== platform
    || account.project_id?.toString() !== String(projectId)) {
    return {
      success: false,
      error: { field: 'socialAccountId', code: BULK_ERROR.ACCOUNT_NO_LONGER_AVAILABLE, message: `The connected ${platform} account is no longer available for this project.` },
    };
  }

  // `all-as-draft` forces every valid row to a draft, ignoring its action.
  const effectiveAction = mode === 'all-as-draft' ? 'draft' : (n.action || 'draft');

  if ((effectiveAction === 'schedule' || effectiveAction === 'publish') && !isPublishingReady(account)) {
    return { success: false, error: { field: 'platform', code: BULK_ERROR.ACCOUNT_NOT_PUBLISH_READY, message: `The connected ${platform} account is missing publishing permission.` } };
  }

  // ── media policy v1: MUST be an Odito-hosted URL (the existing
  //    validateMedia() contract — never weakened for bulk). No fetch. ──
  const media = Array.isArray(n.media) ? n.media : [];
  for (const m of media) {
    if (!m || typeof m.url !== 'string' || !isOwnedUrl(m.url)) {
      return {
        success: false,
        error: { field: 'media_urls', code: BULK_ERROR.MEDIA_NOT_OWNED, message: 'Bulk import media must use an Odito-hosted media URL (upload the file through Odito first).' },
      };
    }
  }

  // ── schedule handling ──
  let scheduledAtIso;
  let timezone = null;
  if (effectiveAction === 'schedule') {
    const when = n.scheduledAt ? new Date(n.scheduledAt) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return { success: false, error: { field: 'scheduled_at', code: BULK_ERROR.INVALID_SCHEDULE, message: 'This row has no valid scheduled time.' } };
    }
    if (when.getTime() <= Date.now()) {
      return { success: false, error: { field: 'scheduled_at', code: BULK_ERROR.PAST_SCHEDULE, message: `The scheduled time (${when.toISOString()}) is now in the past.` } };
    }
    scheduledAtIso = when.toISOString();
    timezone = n.timezone || null;
  } else if (effectiveAction === 'publish') {
    // Immediately-due scheduled publication — the existing scheduler does
    // the real Meta post. No Meta call here.
    scheduledAtIso = new Date(Date.now() + IN_PROGRESS_OFFSET_MS).toISOString();
  }

  const kind = effectiveAction === 'draft' ? 'draft' : 'scheduled';

  let created;
  try {
    created = await createPublication(String(projectId), userId, {
      platform,
      socialAccountId: account._id.toString(),
      content: n.content || '',
      media,
      scheduledAt: scheduledAtIso || undefined,
      timezone,
      importBatchId: batchOid,
      importRowNumber: row.rowNumber,
      // `publish` rows are stamped now+1s so the scheduler picks them up on
      // its next tick; by the time createPublication validates that instant
      // it may already be past, which must not reject them. (`schedule` rows
      // were already required to be in the future above, and still are.)
      allowPastSchedule: effectiveAction === 'publish',
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Duplicate-key on {importBatchId, importRowNumber}: a concurrent /
      // retried / crashed-then-resumed run already created this row's
      // publication. Recover it — never a user-visible failure, never a
      // second publication.
      const existing = await SocialPublication.findOne({ importBatchId: batchOid, importRowNumber: row.rowNumber }).select('_id status');
      if (existing) {
        LoggerUtil.service('BulkImport', 'row', 'duplicate_key_recovered', { batchId: String(batchOid), rowNumber: row.rowNumber });
        return { success: true, publicationId: existing._id.toString(), kind: existing.status === 'draft' ? 'draft' : 'scheduled', recovered: true };
      }
    }
    LoggerUtil.error('[BULK_IMPORT] createPublication threw', { message: err?.message }, { batchId: String(batchOid), rowNumber: row.rowNumber });
    return { success: false, error: { field: null, code: BULK_ERROR.ROW_IMPORT_FAILED, message: 'This row could not be imported. Please try again.' } };
  }

  if (!created.success) {
    const e = created.error || {};
    const field = e.code === 'INVALID_MEDIA'
      ? 'media_urls'
      : (e.code === 'ACCOUNT_NOT_FOUND' || e.code === 'ACCOUNT_NOT_CONNECTED' ? 'socialAccountId' : null);
    return { success: false, error: { field, code: e.code || BULK_ERROR.ROW_IMPORT_FAILED, message: e.message || 'This row could not be imported.' } };
  }

  return { success: true, publicationId: created.publication.id, kind };
}

/**
 * Import a READY (or resumable failed-mid-import) batch.
 *
 * @param {object} args { projectId, userId, batchId, mode }
 * @returns {Promise<
 *   | { success: true, replay?: boolean, batch, result, schedulerEnabled, warnings, rows }
 *   | { success: false, error: { code, message }, batchId?: string }
 * >}
 */
export async function importValidatedBatch({ projectId, userId, batchId, mode }) {
  if (!IMPORT_MODES.includes(mode)) {
    return { success: false, error: { code: BULK_ERROR.INVALID_MODE, message: `mode must be one of: ${IMPORT_MODES.join(', ')}.` } };
  }
  if (!batchId || !mongoose.Types.ObjectId.isValid(batchId)) {
    return { success: false, error: { code: 'INVALID_BATCH_ID', message: 'That import batch id is not valid.' } };
  }

  const pid = toObjectId(projectId);
  const claimId = crypto.randomUUID();
  const startedAtMs = Date.now();

  // ── atomic claim: ready -> importing (or a failed-mid-import batch,
  //    which has importMode set, back to importing for a safe resume).
  //    `importClaimId` is what lets the stale sweeper act on THIS
  //    execution without racing it. ──
  const now = new Date();
  const claimed = await SocialImportBatch.findOneAndUpdate(
    {
      _id: batchId,
      project_id: pid,
      $or: [
        { status: 'ready' },
        { status: 'failed', importMode: { $in: IMPORT_MODES } },
      ],
    },
    {
      $set: {
        status: 'importing',
        importMode: mode,
        importClaimId: claimId,
        importStartedAt: now,
        importHeartbeatAt: now,
        recoveredAt: null,
        recoveryReason: null,
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await SocialImportBatch.findOne({ _id: batchId, project_id: pid });
    if (!current) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'That import batch was not found for this project.' } };
    }
    if (current.status === 'completed') {
      const replayResult = await buildImportResult(current);
      emitBulkImportCompleted({
        projectId: pid, batchId: current._id, total: replayResult.result.attempted,
        result: replayResult.result, replay: true,
      });
      return { success: true, replay: true, ...replayResult };
    }
    const byStatus = {
      importing: { code: BULK_ERROR.IMPORT_ALREADY_IN_PROGRESS, message: 'An import for this batch is already in progress.' },
      failed: { code: BULK_ERROR.IMPORT_BATCH_FAILED, message: 'This batch failed to parse and cannot be imported. Upload a corrected file.' },
      expired: { code: BULK_ERROR.IMPORT_BATCH_EXPIRED, message: 'This import batch has expired.' },
      parsing: { code: BULK_ERROR.IMPORT_BATCH_NOT_READY, message: 'This import batch is still being processed.' },
      validating: { code: BULK_ERROR.IMPORT_BATCH_NOT_READY, message: 'This import batch is still being validated.' },
    };
    return { success: false, error: byStatus[current.status] || { code: BULK_ERROR.IMPORT_BATCH_NOT_READY, message: 'This import batch is not ready to import.' } };
  }

  // ── liveness heartbeat: bump importHeartbeatAt (+ live counts) only
  //    while WE still own the claim. matchedCount 0 => the claim was
  //    taken from us (sweeper recovered a "stale" batch, or another
  //    execution re-claimed) — stop touching the batch. ──
  async function heartbeat(counts) {
    const res = await SocialImportBatch.updateOne(
      { _id: claimed._id, status: 'importing', importClaimId: claimId },
      {
        $set: {
          importHeartbeatAt: new Date(),
          'counts.imported': counts.imported,
          'counts.failed': counts.failed,
          'counts.drafts': counts.drafts,
          'counts.scheduled': counts.scheduled,
        },
      },
    );
    return res.matchedCount === 1;
  }

  function claimLostResult() {
    LoggerUtil.service('BulkImport', 'import', 'claim_lost', {
      projectId: String(projectId), batchId: claimed._id.toString(), importClaimId: claimId,
      durationMs: Date.now() - startedAtMs,
    });
    return {
      success: false,
      error: { code: BULK_ERROR.IMPORT_FAILED, message: 'The import was interrupted and can be retried.' },
      batchId: claimed._id.toString(),
    };
  }

  try {
    // Only `valid` rows — both modes. Invalid rows are never imported.
    const rows = await SocialImportRow.find({ batch_id: claimed._id, status: 'valid' }).sort({ rowNumber: 1 });
    const total = rows.length;

    LoggerUtil.service('BulkImport', 'import', 'started', {
      projectId: String(projectId), batchId: claimed._id.toString(), mode, total, importClaimId: claimId,
    });
    emitBulkImportStarted({ projectId: pid, batchId: claimed._id, total, mode });

    const accountCache = new Map();
    const resolveAccount = async (platform) => {
      if (accountCache.has(platform)) return accountCache.get(platform);
      let acc = null;
      if (platform === 'facebook') acc = await getActiveFacebookAccount(pid);
      else if (platform === 'instagram') acc = await getActiveInstagramAccount(pid);
      accountCache.set(platform, acc);
      return acc;
    };

    // Running tallies for progress events + live heartbeat counts. The
    // FINAL counts are always recomputed authoritatively below.
    const tally = { processed: 0, attempted: 0, imported: 0, failed: 0, drafts: 0, scheduled: 0 };

    for (const row of rows) {
      tally.processed += 1;

      // ── idempotency: already linked, or a publication already exists
      //    for this (importBatchId, importRowNumber) ──
      if (row.publication_id) {
        if (row.status !== 'imported') { row.status = 'imported'; await row.save(); }
        tally.imported += 1;
      } else {
        const existing = await SocialPublication.findOne({ importBatchId: claimed._id, importRowNumber: row.rowNumber }).select('_id status');
        if (existing) {
          // CRASH-SAFETY: a publication exists but its row was never
          // marked imported (process died between create and row.save).
          // Detect it, link it, mark imported — never create another.
          row.publication_id = existing._id;
          row.status = 'imported';
          row.errors = [];
          await row.save();
          tally.imported += 1;
          if (existing.status === 'draft') tally.drafts += 1; else tally.scheduled += 1;
        } else {
          tally.attempted += 1;
          const outcome = await importOneRow({ row, projectId: pid, userId, batchOid: claimed._id, mode, resolveAccount });
          if (outcome.success) {
            row.publication_id = outcome.publicationId;
            row.status = 'imported';
            row.errors = [];
            tally.imported += 1;
            if (outcome.kind === 'draft') tally.drafts += 1; else tally.scheduled += 1;
          } else {
            row.status = 'failed';
            row.errors = [outcome.error];
            tally.failed += 1;
          }
          await row.save();
        }
      }

      emitBulkImportProgress({
        projectId: pid, batchId: claimed._id, total,
        processed: tally.processed, attempted: tally.attempted, imported: tally.imported,
        failed: tally.failed, drafts: tally.drafts, scheduled: tally.scheduled,
        currentRowNumber: row.rowNumber,
      });

      if (tally.processed % HEARTBEAT_EVERY_ROWS === 0) {
        const stillOurs = await heartbeat(tally);
        if (!stillOurs) return claimLostResult();
        LoggerUtil.service('BulkImport', 'import', 'progress', {
          projectId: String(projectId), batchId: claimed._id.toString(),
          processed: tally.processed, total, imported: tally.imported, failed: tally.failed,
        });
      }
    }

    // ── completion: claim-conditional. If the sweeper (or a re-claim)
    //    took the batch while we ran, don't stomp its state — report an
    //    interruption; the (idempotent) retry finishes instantly. ──
    const counts = await computeImportCounts(claimed._id);
    const done = await SocialImportBatch.updateOne(
      { _id: claimed._id, status: 'importing', importClaimId: claimId },
      {
        $set: {
          status: 'completed',
          importClaimId: null,
          importHeartbeatAt: new Date(),
          'counts.imported': counts.imported,
          'counts.failed': counts.failed,
          'counts.drafts': counts.drafts,
          'counts.scheduled': counts.scheduled,
        },
      },
    );
    if (done.matchedCount !== 1) return claimLostResult();

    const fresh = await SocialImportBatch.findById(claimed._id);
    const result = await buildImportResult(fresh);
    const durationMs = Date.now() - startedAtMs;
    LoggerUtil.service('BulkImport', 'import', result.result.failed > 0 ? 'partial' : 'completed', {
      projectId: String(projectId), batchId: claimed._id.toString(),
      attempted: tally.attempted, imported: result.result.imported, failed: result.result.failed, durationMs,
    });
    emitBulkImportCompleted({
      projectId: pid, batchId: claimed._id, total, result: result.result, replay: false,
    });
    return { success: true, ...result };
  } catch (err) {
    LoggerUtil.error('[BULK_IMPORT] import failed unexpectedly', { message: err?.message }, {
      projectId: String(projectId), batchId: claimed._id.toString(), durationMs: Date.now() - startedAtMs,
    });
    // Mark failed — but ONLY if we still own the claim (a sweeper may
    // have already recovered it). importMode stays set -> re-claimable.
    // Any rows already created are recovered on the retry via the
    // idempotency checks above; no duplicate publishing.
    let ownedOnFailure = false;
    if (canTransitionBatchStatus('importing', 'failed')) {
      const res = await SocialImportBatch.updateOne(
        { _id: claimed._id, status: 'importing', importClaimId: claimId },
        {
          $set: {
            status: 'failed',
            importClaimId: null,
            errorSummary: 'A previous import attempt was interrupted before finishing. It is safe to retry.',
          },
        },
      );
      ownedOnFailure = res.matchedCount === 1;
    }
    if (ownedOnFailure) {
      emitBulkImportError({
        projectId: pid, batchId: claimed._id,
        code: BULK_ERROR.IMPORT_FAILED,
        message: 'The import could not be completed. It is safe to retry.',
      });
    }
    return { success: false, error: { code: BULK_ERROR.IMPORT_FAILED, message: 'The import could not be completed. It is safe to retry.' }, batchId: claimed._id.toString() };
  }
}

export default { importValidatedBatch };
