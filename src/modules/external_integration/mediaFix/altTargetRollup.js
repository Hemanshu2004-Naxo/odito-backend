/**
 * altTargetRollup — one status per image (target), and an honest task-level summary derived from them. Pure.
 *
 * A task is per PAGE and a fix is per IMAGE, so "the fix worked" can be true for one image and false for another. Nothing here is
 * stored: the summary is always derived from the per-target ledger records, so it can never disagree with them.
 *
 * Target statuses
 *   not_started                 no fix attempted for this image
 *   in_progress                 a write is running right now
 *   needs_reconcile             a write was sent and its outcome is not known (timeout / crash): recoverable — re-check, never re-send blindly
 *   applied_pending_verification  WordPress holds the text; the rendered page has not been confirmed yet (no post-write crawl, or cannot be checked)
 *   verified                    WordPress holds the text AND the recrawled page shows it on the same image
 *   verification_failed         WordPress holds the text but the page does not show it / WordPress no longer holds it: needs a person
 *   failed                      the write did not happen (rejected, permission, conflict): retryable after review
 *   rolled_back                 restored to the previous alt (rollback verified or at least applied)
 *   rollback_incomplete         a rollback was requested/partially done: resumable
 *
 * Task-level `overall` is NEVER "verified" unless every target Odito changed is verified.
 */

import { STALE_APPLYING_MS } from '../ledger/fixLedger.js';

export const TARGET_STATUSES = Object.freeze([
  'not_started', 'in_progress', 'needs_reconcile', 'applied_pending_verification', 'verified',
  'verification_failed', 'failed', 'rolled_back', 'rollback_incomplete',
]);

const FAILED_RECORD_STATUSES = new Set(['apply_failed', 'permission_denied', 'conflict_detected', 'validation_failed', 'unsupported']);

/** @param {object|null} record a WordPressFixRecord (or its plain object) @param {Date} [now] */
export function deriveTargetStatus(record, now = new Date()) {
  if (!record) return 'not_started';
  const rb = record.rollback?.status;
  if (record.status === 'rolled_back' || ['applied', 'verified', 'rolled_back'].includes(rb)) {
    return rb === 'requested' || rb === 'partial_conflict' ? 'rollback_incomplete' : 'rolled_back';
  }
  if (['requested', 'partial_conflict'].includes(rb)) return 'rollback_incomplete';
  if (record.status === 'apply_uncertain') return 'needs_reconcile';
  if (record.status === 'applying') {
    const touched = record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
    return now.getTime() - touched >= STALE_APPLYING_MS ? 'needs_reconcile' : 'in_progress';
  }
  if (record.status === 'verified') return 'verified';
  if (record.status === 'verification_failed') return 'verification_failed';
  if (['applied', 'verifying'].includes(record.status)) return 'applied_pending_verification';
  if (FAILED_RECORD_STATUSES.has(record.status)) return 'failed';
  return 'not_started';
}

/** Whether another attempt on this image is sensible: a failure to review and retry, or an unknown outcome to reconcile. */
export function retryability(targetStatus) {
  return {
    retryable: targetStatus === 'failed',
    recoverable: targetStatus === 'needs_reconcile' || targetStatus === 'rollback_incomplete',
  };
}

/**
 * @param {{src: string, targetStatus: string}[]} items  one per image (latest record), incl. images with no record yet
 * @returns {{targets: number, byStatus: object, overall: string, retryable: string[], recoverable: string[], remainingOpenImages: number}}
 */
export function summarizeTargets(items) {
  const byStatus = Object.fromEntries(TARGET_STATUSES.map((s) => [s, 0]));
  for (const i of items) byStatus[i.targetStatus] = (byStatus[i.targetStatus] || 0) + 1;

  const touched = items.filter((i) => i.targetStatus !== 'not_started');
  const remainingOpenImages = items.filter((i) => i.targetStatus === 'not_started' && i.inFindings !== false).length;
  const n = (s) => byStatus[s] || 0;

  const bad = n('failed') + n('needs_reconcile') + n('verification_failed') + n('rollback_incomplete');
  const good = n('verified') + n('applied_pending_verification');
  let overall;
  if (!touched.length) overall = 'not_started';
  else if (n('in_progress')) overall = 'in_progress';
  else if (bad && good) overall = 'partially_applied';
  else if (bad) overall = n('verification_failed') && !n('failed') && !n('needs_reconcile') && !n('rollback_incomplete') ? 'needs_attention' : 'failed';
  else if (n('applied_pending_verification') && n('verified')) overall = 'partially_verified';
  else if (n('applied_pending_verification')) overall = 'applied_pending_verification';
  else if (n('verified')) overall = remainingOpenImages ? 'verified_images_remaining' : 'verified';
  else overall = 'rolled_back';

  return {
    targets: touched.length,
    byStatus,
    overall,
    retryable: items.filter((i) => i.retryable).map((i) => i.src),
    recoverable: items.filter((i) => i.recoverable).map((i) => i.src),
    remainingOpenImages,
  };
}

export default { TARGET_STATUSES, deriveTargetStatus, retryability, summarizeTargets };
