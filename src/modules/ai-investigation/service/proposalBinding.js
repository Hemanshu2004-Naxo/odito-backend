/**
 * proposalBinding — ties a proposal to the exact (investigation, project, issue, page) it was made for.
 *
 * The fingerprint covers the identity AND the content of the proposal (changes + code). Approval is given to a fingerprint and an apply
 * only proceeds if the fingerprint it finds today is the one that was approved, so anything that changes the proposal changes the
 * fingerprint and silently invalidates the approval. Deterministic (key-sorted JSON), so the same proposal always yields the same value.
 */
import { createHash } from 'node:crypto';

const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};

export function proposalFingerprint({ investigationId, projectId, issueId, pageUrl, result }) {
  const body = canonical({
    v: 1,
    investigationId: String(investigationId), projectId: String(projectId), issueId: String(issueId), pageUrl: String(pageUrl),
    changes: (result.proposedChanges || []).map((c) => ({ changeType: c.changeType, target: c.target, before: c.before, after: c.after })),
    code: (result.codeOrConfiguration || []).map((c) => ({ language: c.language, content: c.content })),
    // What the proposal was built FROM: changing the confirmed address, the entity or the website changes the fingerprint and voids approvals.
    bindings: result.proposalState?.bindings || {},
    state: result.proposalState?.status || null,
  });
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** @returns {{ fingerprint: string, hasProposal: boolean, boundTo: { investigationId: string, projectId: string, issueId: string, pageUrl: string } }} */
export function bindProposal({ investigationId, projectId, issueId, pageUrl, result }) {
  return {
    fingerprint: proposalFingerprint({ investigationId, projectId, issueId, pageUrl, result }),
    // A proposal exists only when it is PUBLISHABLE: blocked / awaiting-information results carry explanations, not a change.
    hasProposal: (result.proposalState?.status ? result.proposalState.status === 'publishable' : (result.proposedChanges?.length || 0) + (result.codeOrConfiguration?.length || 0) > 0),
    status: result.proposalState?.status || null,
    blockerCodes: result.proposalState?.blockerCodes || [],
    bindings: result.proposalState?.bindings || {},
    boundTo: { investigationId: String(investigationId), projectId: String(projectId), issueId: String(issueId), pageUrl: String(pageUrl) },
  };
}

/** True if the stored proposal still hashes to its recorded fingerprint (detects tampering with the stored result). */
export function proposalIntact(investigation) {
  const p = investigation?.result?.proposal;
  if (!p?.fingerprint) return false;
  return proposalFingerprint({ investigationId: investigation._id, projectId: investigation.projectId, issueId: investigation.issueId, pageUrl: investigation.pageUrl, result: investigation.result }) === p.fingerprint;
}

export default { proposalFingerprint, bindProposal, proposalIntact };
