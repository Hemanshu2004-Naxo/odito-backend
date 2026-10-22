/**
 * lifecycleService — the honest "proposed -> applied -> verified" state of an investigation's fix.
 *
 * A model can only ever PROPOSE. This module derives the later states from records that other trusted code writes:
 *   - applied   <- the Task's latest fix attempt has an `externalWrite` Odito itself performed through an adapter
 *                  (a user clicking "Mark as implemented" is reported separately and is NOT treated as applied)
 *   - verified  <- the Task's verification pass (re-crawl + detector re-run, done by TaskVerificationService) said so
 *
 * It also starts that verification through the EXISTING url-verification pipeline (re-fetch + re-run detectors);
 * it does not mark anything fixed itself.
 */

import Task from '../../tasks/model/Task.js';
import { startUrlVerification } from '../../verification/service/urlVerificationService.js';

/** Epoch ms from a Date or an ISO string. (Date.parse(Date) goes through toString() and silently drops the milliseconds.) */
const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(v ?? ''));

/** Pure: the base lifecycle flags from a task document (or null). `deriveLifecycle` adds the explicit stage model on top. */
function deriveBase({ investigation, task }) {
  const proposed = !!investigation?.result?.lifecycle?.fixProposed;
  const base = {
    recommendationGenerated: !!investigation?.result,
    fixProposed: proposed,
    fixApplied: false, appliedBy: null, userReportedImplemented: false,
    fixVerified: false,
    // A verification the user started is "pending" until the task's own re-crawl result says passed/failed (never assumed passed).
    verificationStatus: investigation?.lifecycle?.verificationStatus === 'pending' && investigation?.lifecycle?.verificationRunId ? 'pending' : 'not_started',
    verificationRunId: investigation?.lifecycle?.verificationRunId || null,
    verificationCheckedAt: null, taskStatus: task?.status || null,
    approval: investigation?.approval?.fingerprint
      ? { approved: !investigation.approval.invalidatedAt, invalidated: !!investigation.approval.invalidatedAt, consumed: !!investigation.approval.consumedAt, approvedAt: investigation.approval.approvedAt || null }
      : { approved: false, invalidated: false, consumed: false, approvedAt: null },
  };
  if (!task) return base;
  // A task prepared for a DIFFERENT investigation or proposal says nothing about this one: its writes and verifications are not inherited.
  const bound = task.investigationBinding;
  if (bound?.investigationId && (String(bound.investigationId) !== String(investigation?._id) || (investigation?.result?.proposal?.fingerprint && bound.fingerprint !== investigation.result.proposal.fingerprint))) {
    return { ...base, attemptsConsidered: 0, taskBoundToOtherProposal: true };
  }

  // Only attempts made AFTER this investigation count: an older fix (or an older "verified") says nothing about the state this
  // investigation just found. Without a start time (legacy/test rows) every attempt counts.
  // The lower bound for "after this investigation" is the later of its start and (when an approval was consumed) the moment it was consumed:
  // a write that happened before the approval was claimed was not made under this proposal.
  const since = Math.max(ms(investigation?.createdAt) || 0, ms(investigation?.approval?.consumedAt) || 0) || NaN;
  const when = (a) => ms(a?.fixApplied?.externalWrite?.writtenAt || a?.implementedAt || a?.fixApplied?.capturedAt);
  const attempts = (Array.isArray(task.fixHistory) ? task.fixHistory : []).filter((a) => !Number.isFinite(since) || !Number.isFinite(when(a)) || when(a) >= since);
  const latest = attempts[attempts.length - 1] || null;
  base.attemptsConsidered = attempts.length;
  if (!latest) return base;
  const write = latest?.fixApplied?.externalWrite;
  if (write?.system && write?.writtenAt) { base.fixApplied = true; base.appliedBy = `${write.system}:${write.field || 'unknown'}`; }
  else if (task.status === 'implemented' || latest) base.userReportedImplemented = task.status !== 'task_created';

  const v = latest?.verification;
  // A verification only counts if it happened after the write it is supposed to verify.
  const verifiedAfterWrite = !write?.writtenAt || !v?.verifiedAt || ms(v.verifiedAt) >= ms(write.writtenAt);
  if (!verifiedAfterWrite) {
    // stale verification from before this write: ignored
  } else if (task.status === 'verified_fixed' && v?.result === 'verified_fixed' && v?.verifiedAt) {
    base.fixVerified = true; base.verificationStatus = 'passed'; base.verificationCheckedAt = new Date(v.verifiedAt).toISOString();
  } else if (task.status === 'reopened' && v?.result === 'reopened') {
    base.verificationStatus = 'failed'; base.verificationCheckedAt = v.verifiedAt ? new Date(v.verifiedAt).toISOString() : null;
  } else if (task.status === 'implemented' && (base.fixApplied || base.userReportedImplemented)) {
    base.verificationStatus = base.verificationRunId ? 'pending' : 'not_started';
  }
  return base;
}

export function createLifecycleService({ store, loadTask, startVerification }) {
  return {
    async get({ investigationId, projectId }) {
      const investigation = await store.findById(investigationId, projectId);
      if (!investigation) return null;
      const task = await loadTask(projectId, investigation.issueId, investigation.pageUrl);
      return { investigation, lifecycle: deriveLifecycle({ investigation, task }) };
    },

    /** Starts the existing re-fetch + detector re-run. Reports the pipeline's answer; marks nothing verified. */
    async requestVerification({ investigationId, projectId, userId }) {
      const investigation = await store.findById(investigationId, projectId);
      if (!investigation) return null;
      // Only the LATEST investigation for this issue+page may start (and later own) a verification; an older one is stale.
      const latest = await store.findLatestByKey(projectId, investigation.requestKey);
      if (latest && String(latest._id) !== String(investigation._id)) return { started: false, code: 'STALE_INVESTIGATION', message: 'A newer investigation exists for this page. Verify from that one.' };
      if (investigation.status !== 'completed') return { started: false, code: 'INVESTIGATION_NOT_COMPLETE', message: 'The investigation has not finished.' };
      // There must be a recorded change to verify, and the verification must target the investigation's own issue and URL.
      const task = await loadTask(projectId, investigation.issueId, investigation.pageUrl);
      const state = deriveLifecycle({ investigation, task });
      if (!state.fixApplied && !state.userReportedImplemented) return { started: false, code: 'NOTHING_TO_VERIFY', message: 'No change has been applied for this investigation yet, so there is nothing to verify.' };
      // One verification at a time per investigation: a repeated click must not queue a second run.
      if (investigation.lifecycle?.verificationStatus === 'pending' && investigation.lifecycle?.verificationRunId) {
        return { started: false, code: 'ALREADY_RUNNING', message: 'A verification is already running for this page.' };
      }
      const outcome = await startVerification(projectId, investigation.pageUrl, { requestingUserId: userId });
      const runId = outcome?.data?.verificationRunId || null;
      if (outcome?.success && runId) {
        await store.update(investigationId, projectId, { lifecycle: { ...(investigation.lifecycle || {}), verificationStatus: 'pending', verificationRunId: runId, verificationCheckedAt: null } });
      }
      return { started: !!outcome?.success, code: outcome?.code || 'UNKNOWN', message: outcome?.message || null, verificationRunId: runId };
    },
  };
}

export const defaultLifecycleService = (store) => createLifecycleService({
  store,
  loadTask: (projectId, issueKey, pageUrl) => Task.findOne({ projectId, issueKey, pageUrl, isDeleted: { $ne: true } }).lean(),
  startVerification: startUrlVerification,
});

export default { deriveLifecycle, createLifecycleService, defaultLifecycleService };


/**
 * The explicit stage model the UI shows. Every state comes from persisted backend records (the investigation, its approval, the Task's attempts and
 * verification) — never from model text, and never "applied"/"verified" merely because something was generated or proposed.
 *
 *   recommendation  not_generated | generated
 *   proposal        none | available | blocked | awaiting_information
 *   approval        not_required | blocked | awaiting | approved | invalidated | used
 *   application     not_started | applied | failed
 *   verification    not_started | pending | verified | failed
 */
export function deriveLifecycle({ investigation, task }) {
  const base = deriveBase({ investigation, task });
  const r = investigation?.result || null;
  const ps = r ? (r.proposalState?.status ?? (r.lifecycle?.fixProposed ? 'publishable' : 'none')) : null;
  const a = investigation?.approval || {};
  const blockers = (r?.blockers || []).slice(0, 8).map((b) => ({ code: b.code, message: b.message, action: b.action || null, category: b.category || null }));

  const proposal = !r ? 'none' : ps === 'publishable' ? 'available' : ps === 'awaiting_information' ? 'awaiting_information' : ps === 'blocked' ? 'blocked' : 'none';
  const approval = proposal === 'available'
    ? (a.consumedAt ? 'used' : a.invalidatedAt ? 'invalidated' : a.fingerprint ? 'approved' : 'awaiting')
    : proposal === 'none' ? 'not_required' : 'blocked';
  const application = base.fixApplied ? 'applied' : (a.lastFailure && !a.consumedAt) ? 'failed' : 'not_started';
  const verification = base.fixVerified ? 'verified' : base.verificationStatus === 'pending' ? 'pending' : base.verificationStatus === 'failed' ? 'failed' : 'not_started';

  return {
    ...base,
    fixProposed: proposal === 'available',
    stages: {
      recommendation: { state: r ? 'generated' : 'not_generated' },
      proposal: { state: proposal, blockers: proposal === 'available' ? [] : blockers },
      approval: { state: approval },
      application: { state: application, appliedBy: base.appliedBy || null, userReportedImplemented: !!base.userReportedImplemented, failure: application === 'failed' ? { code: a.lastFailure?.code || null, message: a.lastFailure?.message || null, at: a.lastFailure?.at || null } : null },
      verification: { state: verification, runId: base.verificationRunId || null, checkedAt: base.verificationCheckedAt || null },
    },
  };
}
