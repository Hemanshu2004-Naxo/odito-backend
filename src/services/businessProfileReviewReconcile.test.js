import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileReviewIds } from './businessProfileReviewReconcile.js';

const ids = (n, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe('reconcileReviewIds - names the exact review behind a one-review gap', () => {
  test('everything agrees -> no gap, plain verdict', () => {
    const all = ids(5);
    const r = reconcileReviewIds({ googleIds: all, googleTotal: 5, storedLiveIds: all });
    assert.equal(r.counts.differenceLiveVsGoogleReported, 0);
    assert.deepEqual(r.verdict, ['Odito shows exactly the reviews Google returns and reports']);
  });

  test('Google returns a review that was soft-deleted by an earlier sync -> that id is named', () => {
    const all = ids(5);
    const r = reconcileReviewIds({ googleIds: all, googleTotal: 5, storedLiveIds: all.slice(0, 4), storedDeletedIds: ['r5'] });
    assert.equal(r.counts.differenceLiveVsGoogleReported, -1);
    assert.deepEqual(r.returnedButNotShown.softDeleted, ['r5']);
    assert.match(r.verdict[0], /soft-deleted/);
  });

  test('a review that was never stored (missed by a sync) is named', () => {
    const all = ids(5);
    const r = reconcileReviewIds({ googleIds: all, googleTotal: 5, storedLiveIds: all.slice(0, 4) });
    assert.deepEqual(r.returnedButNotShown.neverStored, ['r5']);
    assert.match(r.verdict[0], /never stored/);
  });

  test('a review stored under another location is named', () => {
    const all = ids(3);
    const r = reconcileReviewIds({ googleIds: all, googleTotal: 3, storedLiveIds: ['r1', 'r2'], storedOtherLocationIds: ['r3'] });
    assert.deepEqual(r.returnedButNotShown.storedForAnotherLocation, ['r3']);
  });

  test('Google reports one more than it ever returns -> not a storage problem, and says so', () => {
    const all = ids(4);
    const r = reconcileReviewIds({ googleIds: all, googleTotal: 5, storedLiveIds: all });
    assert.equal(r.counts.googleReportedMinusReturned, 1);
    assert.equal(r.counts.differenceLiveVsGoogleReturned, 0);
    assert.deepEqual(r.returnedButNotShown, { softDeleted: [], storedForAnotherLocation: [], neverStored: [] });
    assert.match(r.verdict[0], /Google reports 1 more review\(s\) than it returns/);
  });

  test('a stored review Google no longer returns is listed', () => {
    const r = reconcileReviewIds({ googleIds: ids(3), googleTotal: 3, storedLiveIds: [...ids(3), 'gone'] });
    assert.deepEqual(r.shownButNotReturned, ['gone']);
    assert.equal(r.counts.differenceLiveVsGoogleReported, 1);
  });

  test('duplicate ids in the Google response are counted once and reported', () => {
    const r = reconcileReviewIds({ googleIds: ['r1', 'r2', 'r2', 'r3'], googleTotal: 3, storedLiveIds: ids(3) });
    assert.equal(r.counts.googleRecordsReturned, 4);
    assert.equal(r.counts.googleUniqueIds, 3);
    assert.equal(r.counts.googleDuplicateRecords, 1);
    assert.equal(r.counts.differenceLiveVsGoogleReturned, 0);
  });

  test('no Google total available: differences against it are null, not 0', () => {
    const r = reconcileReviewIds({ googleIds: ids(2), storedLiveIds: ids(2) });
    assert.equal(r.counts.differenceLiveVsGoogleReported, null);
    assert.equal(r.counts.googleReportedMinusReturned, null);
  });

  test('the production symptom: stored 1,062 vs Google 1,063 - each possible cause gives a different, specific answer', () => {
    const google = ids(1063);
    const stored = google.slice(0, 1062);
    // (a) the 1,063rd review exists on Google but was never stored
    assert.deepEqual(reconcileReviewIds({ googleIds: google, googleTotal: 1063, storedLiveIds: stored }).returnedButNotShown.neverStored, ['r1063']);
    // (b) ...or it is stored but hidden
    assert.deepEqual(reconcileReviewIds({ googleIds: google, googleTotal: 1063, storedLiveIds: stored, storedDeletedIds: ['r1063'] }).returnedButNotShown.softDeleted, ['r1063']);
    // (c) ...or Google only ever returns 1,062 of the 1,063 it reports
    const c = reconcileReviewIds({ googleIds: stored, googleTotal: 1063, storedLiveIds: stored });
    assert.equal(c.counts.googleReportedMinusReturned, 1);
    assert.equal(c.returnedButNotShown.neverStored.length, 0);
  });
});
