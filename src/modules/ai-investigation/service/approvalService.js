/**
 * approvalService — approval of ONE exact proposal, enforced by the backend at the moment of applying.
 *
 *   approve()         records an approval of a proposal fingerprint (never of "this issue" in general)
 *   claimForApply()   called by the existing apply-wordpress route for tasks that came from an investigation. Everything is re-checked NOW:
 *                     same project / issue / page, still the latest investigation, proposal unchanged, same linked recommendation,
 *                     Odito can still apply it, an unconsumed un-invalidated approval of exactly this fingerprint exists —
 *                     and the approval is consumed with ONE compare-and-set, so a duplicate request cannot write twice.
 *                     If the write then fails, the claim is released so the person can retry.
 *
 * Tasks without an investigation binding (the pre-existing flow) are untouched.
 */
import { ELIGIBILITY } from '../capabilities/fixCapabilities.js';
import { proposalIntact } from './proposalBinding.js';

export class ApprovalError extends Error {
  constructor(code, message, statusCode = 409, details = null) { super(message); this.name = 'ApprovalError'; this.code = code; this.statusCode = statusCode; this.details = details; }
}

export function createApprovalService({ store, resolveCapabilities, loadConfirmedAddress = async () => null, now = () => Date.now(), log = () => {} }) {
  const stamp = () => new Date(now());

  async function eligibleNow(investigation, projectId) {
    const caps = await resolveCapabilities({ issueId: investigation.issueId, projectId, operation: investigation.result?.proposalState?.operation || undefined });
    if (!investigation.result?.automaticFixEligibility?.eligible || caps.eligibility !== ELIGIBILITY.ELIGIBLE) {
      throw new ApprovalError('NOT_ELIGIBLE', caps.eligibility === ELIGIBILITY.ELIGIBLE ? 'This proposal did not pass every safety check.' : caps.reason, 422);
    }
    return caps;
  }

  /**
   * A proposal built from a USER-confirmed address is only valid while that confirmation is still what it was built from: same address
   * (hash), still bound to the same website. Re-checked when approving, when preparing, and again at the moment of applying.
   */
  async function assertBindingsCurrent(investigation, projectId) {
    const b = investigation.result?.proposal?.bindings || {};
    if (b.addressStatus !== 'confirmed_by_owner') return;
    const confirmed = await loadConfirmedAddress(projectId).catch(() => null);
    if (!confirmed) throw new ApprovalError('ADDRESS_CONFIRMATION_MISSING', 'The address this proposal was built from is no longer confirmed. Confirm it again and re-run the investigation.');
    if (confirmed.addressHash !== b.addressHash) throw new ApprovalError('ADDRESS_CHANGED', 'The confirmed address changed after this proposal was built. Re-run the investigation to build the change from the current address.');
    if (confirmed.website && b.website) {
      const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
      if (host(confirmed.website) !== host(b.website)) throw new ApprovalError('CONFIRMATION_FOR_OTHER_WEBSITE', 'The address confirmation belongs to a different website.');
    }
  }

  async function assertCurrent(investigation, projectId) {
    const latest = await store.findLatestByKey(projectId, investigation.requestKey);
    if (latest && String(latest._id) !== String(investigation._id)) throw new ApprovalError('STALE_INVESTIGATION', 'A newer investigation exists for this page; this approval no longer applies.');
    if (investigation.status !== 'completed' || !investigation.result?.proposal) throw new ApprovalError('INVESTIGATION_NOT_COMPLETE', 'The investigation has not finished.');
    if (!proposalIntact(investigation)) throw new ApprovalError('PROPOSAL_CHANGED', 'The stored proposal no longer matches its fingerprint.');
    await assertBindingsCurrent(investigation, projectId);
  }

  return {
    /** Approve exactly `fingerprint` for this investigation. The Task must already be prepared and bound to it. */
    async approve({ investigationId, projectId, userId, fingerprint, loadTask }) {
      const inv = await store.findById(investigationId, projectId);
      if (!inv) return null;
      await assertCurrent(inv, projectId);
      if (!inv.result.proposal.hasProposal) {
        const blockers = inv.result.blockers || [];
        throw new ApprovalError('NOTHING_TO_APPROVE', blockers.length ? `There is no publishable change to approve yet: ${blockers.map((b) => b.code).join(', ')}.` : 'This investigation proposes no change.', 422);
      }
      if (typeof fingerprint !== 'string' || fingerprint !== inv.result.proposal.fingerprint) {
        throw new ApprovalError('PROPOSAL_CHANGED', 'The proposal you reviewed is not the current one. Reload and review it again.');
      }
      await eligibleNow(inv, projectId);
      const task = await loadTask(projectId, inv.issueId, inv.pageUrl);
      if (!task?.investigationBinding || String(task.investigationBinding.investigationId) !== String(inv._id) || task.investigationBinding.fingerprint !== fingerprint) {
        throw new ApprovalError('FIX_NOT_PREPARED', 'Prepare the fix for this investigation before approving it.', 409);
      }
      const saved = await store.setApproval(inv._id, projectId, { fingerprint, userId: String(userId), approvedAt: stamp(), consumedAt: null, consumedByTaskId: null, invalidatedAt: null });
      if (!saved) throw new ApprovalError('APPROVAL_NOT_ALLOWED', 'This proposal was already applied; a new investigation is needed.', 409);
      log('info', 'approval_recorded', { investigationId: String(inv._id), projectId: String(projectId), userId: String(userId), fingerprint: fingerprint.slice(0, 12) });
      return { fingerprint, approvedAt: saved.approval.approvedAt };
    },

    /**
     * @param {object} task a Task document (plain or hydrated) about to be applied
     * @returns {Promise<{ legacy: true } | { legacy: false, release: () => Promise<void>, investigationId: string }>}
     */
    async claimForApply(task) {
      const binding = task?.investigationBinding;
      if (!binding?.investigationId) return { legacy: true };
      const projectId = String(task.projectId);
      const inv = await store.findById(binding.investigationId, projectId);
      if (!inv) throw new ApprovalError('BINDING_MISMATCH', 'The investigation this task was prepared from no longer exists.');
      if (String(inv.projectId) !== projectId || inv.issueId !== task.issueKey || inv.pageUrl !== task.pageUrl) {
        throw new ApprovalError('BINDING_MISMATCH', 'This task does not match the investigation it was prepared from.');
      }
      await assertCurrent(inv, projectId);
      if (inv.result.proposal.fingerprint !== binding.fingerprint) throw new ApprovalError('PROPOSAL_CHANGED', 'The proposal changed after this task was prepared. Prepare and approve it again.');
      if (String(task.recommendationId || '') !== String(binding.recommendationId || '')) throw new ApprovalError('RECOMMENDATION_CHANGED', 'The recommendation linked to this task changed after it was prepared and approved.');
      await eligibleNow(inv, projectId);

      const a = inv.approval;
      if (!a?.fingerprint) throw new ApprovalError('APPROVAL_REQUIRED', 'Approve the exact proposed change before applying it.', 409);
      if (a.invalidatedAt) throw new ApprovalError('APPROVAL_INVALIDATED', 'This approval was invalidated because the situation changed. Review and approve again.');
      if (a.fingerprint !== binding.fingerprint) throw new ApprovalError('APPROVAL_REQUIRED', 'The approval does not cover the current proposal.', 409);
      if (a.consumedAt) throw new ApprovalError('APPROVAL_ALREADY_USED', 'This approval was already used to apply the change.', 409);

      const claimed = await store.claimApproval(inv._id, projectId, binding.fingerprint, String(task._id), stamp());
      if (!claimed) throw new ApprovalError('APPROVAL_ALREADY_USED', 'This approval was already used (or was just invalidated).', 409);
      log('info', 'approval_claimed', { investigationId: String(inv._id), taskId: String(task._id), projectId });
      return {
        legacy: false, investigationId: String(inv._id),
        release: async (failure = null) => { await store.releaseApproval(inv._id, projectId, binding.fingerprint, String(task._id), failure); log('warn', 'approval_released', { investigationId: String(inv._id), taskId: String(task._id), failure: failure?.code || null }); },
      };
    },
  };
}

export default { createApprovalService, ApprovalError };
