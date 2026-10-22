/**
 * Review count reconciliation - PURE (no DB, no Google). Compares the review ids
 * Google returned with the ids Odito has stored for ONE location and names the
 * exact reviews behind any difference. Used by the read-only diagnostic script
 * (src/modules/app_user/scripts/diagnoseReviewCount.js) and covered by tests.
 *
 * @param {object} p
 * @param {string[]} p.googleIds              ids Google returned (duplicates allowed)
 * @param {number|null} p.googleTotal         Google's own totalReviewCount
 * @param {string[]} p.storedLiveIds          stored, is_deleted:false, this location (what the dashboard counts)
 * @param {string[]} [p.storedDeletedIds]     stored, is_deleted:true, this location
 * @param {string[]} [p.storedOtherLocationIds] stored for the same project but ANOTHER location
 */
export function reconcileReviewIds({ googleIds, googleTotal = null, storedLiveIds, storedDeletedIds = [], storedOtherLocationIds = [] }) {
  const google = new Set(googleIds);
  const live = new Set(storedLiveIds);
  const deleted = new Set(storedDeletedIds);
  const other = new Set(storedOtherLocationIds);

  const missingFromStore = [...google].filter((id) => !live.has(id));
  const report = {
    counts: {
      googleReportedTotal: googleTotal,
      googleRecordsReturned: googleIds.length,
      googleUniqueIds: google.size,
      googleDuplicateRecords: googleIds.length - google.size,
      storedLive: live.size,
      storedSoftDeleted: deleted.size,
      differenceLiveVsGoogleReported: typeof googleTotal === 'number' ? live.size - googleTotal : null,
      differenceLiveVsGoogleReturned: live.size - google.size,
      googleReportedMinusReturned: typeof googleTotal === 'number' ? googleTotal - google.size : null,
    },
    // Google returned it, Odito shows it nowhere:
    returnedButNotShown: {
      softDeleted: missingFromStore.filter((id) => deleted.has(id)), // hidden by an earlier stale-marking
      storedForAnotherLocation: missingFromStore.filter((id) => !deleted.has(id) && other.has(id)),
      neverStored: missingFromStore.filter((id) => !deleted.has(id) && !other.has(id)),
    },
    // Odito shows it, Google no longer returns it:
    shownButNotReturned: [...live].filter((id) => !google.has(id)),
  };

  const unreturned = typeof googleTotal === 'number' ? Math.max(0, googleTotal - google.size) : 0;
  report.verdict = verdictFor(report, unreturned);
  return report;
}

function verdictFor(report, unreturned) {
  const { softDeleted, storedForAnotherLocation, neverStored } = report.returnedButNotShown;
  const reasons = [];
  if (softDeleted.length) reasons.push(`${softDeleted.length} review(s) Google still returns are soft-deleted in Odito (hidden by an earlier sync)`);
  if (storedForAnotherLocation.length) reasons.push(`${storedForAnotherLocation.length} review(s) are stored under a different location id`);
  if (neverStored.length) reasons.push(`${neverStored.length} review(s) Google returns were never stored (a sync missed them or failed to write them)`);
  if (report.shownButNotReturned.length) reasons.push(`${report.shownButNotReturned.length} stored review(s) are no longer returned by Google (removed since the last complete sync)`);
  if (unreturned > 0) reasons.push(`Google reports ${unreturned} more review(s) than it returns across all pages - not recoverable from the list API`);
  return reasons.length ? reasons : ['Odito shows exactly the reviews Google returns and reports'];
}
