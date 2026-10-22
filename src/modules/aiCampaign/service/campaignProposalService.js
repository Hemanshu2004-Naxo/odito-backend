/**
 * campaignProposalService — orchestrates conversational campaign editing
 * (Phase 4, spec §2 / §11 / §17(analogue) / §48).
 *
 *   generateProposal:  instruction → Claude → validate → persist (ready)
 *   acceptProposal:    revision check → apply in memory → re-validate →
 *                       atomic persist (optimistic concurrency) → accepted
 *   rejectProposal:    mark rejected, draft untouched
 *
 * CORE RULE (spec §2): "Claude proposes. Odito validates. The user
 * approves. Odito persists." Claude's output is NEVER written to
 * AiCampaignDraft directly — generateProposal only ever writes to
 * AiCampaignChangeProposal. Only acceptProposal touches the draft, and only
 * through campaignDraftService.applyValidatedChanges (the sole, atomic,
 * version-guarded write path).
 *
 * The controller stays thin — auth + response shaping only. Prompt
 * construction, the Claude call, proposal validation, applying changes,
 * full-campaign re-validation, and every MongoDB write live below or in
 * the collaborators (campaignEditingContextBuilder, proposalValidator,
 * campaignProposalApplier, campaignDraftService).
 */

import { randomUUID } from 'node:crypto';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ValidationError, NotFoundError, ConflictError } from '../../../utils/ErrorUtil.js';

import AiCampaignChangeProposal from '../model/AiCampaignChangeProposal.js';
import campaignDraftService from './campaignDraftService.js';
import { buildEditingContext } from './campaignEditingContextBuilder.js';
import { validateProposedChanges } from './proposalValidator.js';
import { applyProposedChanges } from './campaignProposalApplier.js';
import { validateCampaignDraftStructure } from '../validator/campaignStructureValidator.js';
import { buildEditSystemPrompt, buildEditUserPrompt, PROMPT_VERSION } from '../prompts/editCampaignPrompt.js';
import realEditProvider from '../providers/claudeCampaignEditProvider.js';
import { INSTRUCTION_MAX_LENGTH, INSTRUCTION_MAX_BYTES, PROPOSAL_EXPIRY_MS } from '../constants/editingConfig.js';
import { EDITABLE_DRAFT_STATUSES } from '../constants/editableStatuses.js';
import { canTransitionProposalStatus } from '../constants/proposalEnums.js';

const OPERATION_TO_CHANGE_ACTION = { add: 'CREATE', remove: 'DELETE', replace: 'UPDATE' };

// ── provider seam (mirrors campaignGenerationService.js) ──────────────────
let _providerOverride = null;
export function setProviderOverride(provider) { _providerOverride = provider || null; }
export function resetProviderOverride() { _providerOverride = null; }

export class CampaignProposalError extends Error {
  constructor(code, httpStatus, message, details = null) {
    super(message);
    this.name = 'CampaignProposalError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.type = 'CAMPAIGN_PROPOSAL_ERROR';
    if (details) this.details = details;
  }
}

function classifyProviderError(error) {
  const code = error?.code || error?.message;
  switch (code) {
    case 'CLAUDE_NOT_CONFIGURED':
      return new CampaignProposalError('AI_UNAVAILABLE', 503, 'AI campaign editing is not configured on this server.');
    case 'CLAUDE_TIMEOUT':
      return new CampaignProposalError('AI_TIMEOUT', 504, 'That took too long. Your campaign hasn\'t been changed — please try again.');
    case 'CLAUDE_RATE_LIMITED': {
      const e = new CampaignProposalError('AI_RATE_LIMITED', 503, 'AI editing is busy. Please retry shortly.');
      if (error.retryAfter) e.retryAfter = error.retryAfter;
      return e;
    }
    case 'CLAUDE_OVERLOADED':
      return new CampaignProposalError('AI_OVERLOADED', 503, 'The AI provider is temporarily overloaded. Please retry shortly.');
    case 'CLAUDE_AUTH':
      return new CampaignProposalError('AI_PROVIDER_ERROR', 502, 'The AI provider rejected the request.');
    case 'CLAUDE_BAD_OUTPUT':
      return new CampaignProposalError('AI_BAD_OUTPUT', 502, 'The AI returned an unusable response. Please try again.');
    case 'CLAUDE_NETWORK_ERROR':
      return new CampaignProposalError('AI_PROVIDER_ERROR', 502, 'Could not reach the AI provider. Please try again.');
    default:
      if (typeof code === 'string' && code.startsWith('CLAUDE_HTTP_')) {
        return new CampaignProposalError('AI_PROVIDER_ERROR', 502, 'The AI provider returned an error.');
      }
      return new CampaignProposalError('PROPOSAL_FAILED', 500, 'AI editing failed. Please try again.');
  }
}

function validateInstruction(instruction) {
  const value = typeof instruction === 'string' ? instruction.trim() : '';
  if (!value) throw new ValidationError('instruction is required');
  if (value.length > INSTRUCTION_MAX_LENGTH) {
    throw new ValidationError(`instruction must be at most ${INSTRUCTION_MAX_LENGTH} characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > INSTRUCTION_MAX_BYTES) {
    throw new ValidationError('instruction is too large');
  }
  return value;
}

/** Load a proposal and confirm it actually belongs to this draft — never leak a different draft's proposal via 403/wrong-data; a mismatch is a plain 404. */
async function loadOwnedProposal(proposalId, draftId) {
  const proposal = await AiCampaignChangeProposal.findById(proposalId);
  if (!proposal || proposal.draftId.toString() !== String(draftId)) {
    throw new NotFoundError('Change proposal not found');
  }
  return proposal;
}

function isExpired(proposal) {
  return proposal.expiresAt instanceof Date && proposal.expiresAt.getTime() < Date.now();
}

/**
 * Move a proposal to `next`, enforcing PROPOSAL_STATUS_TRANSITIONS. Throws
 * (fails closed) rather than silently allowing an illegal jump — mirrors
 * campaignDraftService.transitionStatus's guard for AiCampaignDraft.
 */
function setProposalStatus(proposal, next) {
  if (!canTransitionProposalStatus(proposal.status, next)) {
    throw new Error(`Invalid proposal status transition: ${proposal.status} → ${next}`);
  }
  proposal.status = next;
}

/**
 * Generate a change proposal for a draft from a conversational instruction.
 *
 * @param {object} args
 * @param {string} args.draftId
 * @param {string} args.userId
 * @param {string} args.instruction
 * @param {object} [args.provider]
 * @returns {Promise<{ proposal: object, generationId: string }>}
 */
export async function generateProposal({ draftId, userId, instruction, provider = null }) {
  const activeProvider = provider || _providerOverride || realEditProvider;

  // ── 1. Validate the instruction (no Claude call if this throws) ───────
  const cleanInstruction = validateInstruction(instruction);

  // ── 2. Load the draft; it must be in an editable state ────────────────
  const draft = await campaignDraftService.getDraft(draftId);
  if (!EDITABLE_DRAFT_STATUSES.includes(draft.status)) {
    throw new ValidationError(`A campaign in status "${draft.status}" cannot be edited by AI right now.`);
  }

  // ── 3. Fail fast on a misconfigured server ─────────────────────────────
  if (!activeProvider.isAvailable()) {
    throw new CampaignProposalError('AI_UNAVAILABLE', 503, 'AI campaign editing is not configured on this server.');
  }

  // ── 4. Create the proposal record (status: generating) ────────────────
  const generationId = `edit-${randomUUID()}`;
  let proposal = await AiCampaignChangeProposal.create({
    projectId: draft.projectId,
    draftId: draft._id,
    createdBy: userId,
    instruction: cleanInstruction,
    baseVersion: draft.version,
    status: 'generating',
    expiresAt: new Date(Date.now() + PROPOSAL_EXPIRY_MS),
    aiMetadata: {},
  });

  const startedAt = Date.now();
  LoggerUtil.info('AI campaign edit proposal generation started', {
    generationId,
    draftId: draft._id.toString(),
    proposalId: proposal._id.toString(),
    baseVersion: draft.version,
    promptVersion: PROMPT_VERSION,
  });

  try {
    // ── 5. Build safe context + prompts, call Claude ────────────────────
    const context = buildEditingContext(draft);
    const system = buildEditSystemPrompt();
    const user = buildEditUserPrompt({ context, instruction: cleanInstruction });
    const providerResult = await activeProvider.proposeChanges({ system, user, generationId });

    // ── 6. Validate every proposed change against the SAME draft snapshot
    const draftPlain = draft.toObject();
    const validation = validateProposedChanges(providerResult.parsed, draftPlain);
    if (!validation.valid) {
      throw new CampaignProposalError(
        'PROPOSAL_INVALID',
        422,
        'The AI suggestion couldn\'t be safely applied. Please try rephrasing your request.',
        validation.errors,
      );
    }

    // ── 7. Eagerly prove the FULL resulting campaign would still be valid
    //      (spec §12) — a proposal a user could never actually accept is
    //      never shown as "ready" in the first place.
    const applied = applyProposedChanges(draftPlain, validation.normalizedChanges);
    const normalizedForCheck = {
      campaign: campaignDraftService._internals.normalizeCampaignInput(applied.campaign),
      adGroups: campaignDraftService._internals.normalizeAdGroups(applied.adGroups) ?? [],
    };
    const structResult = validateCampaignDraftStructure(normalizedForCheck, { requireAdGroups: true, strictRsa: true });
    if (!structResult.valid) {
      throw new CampaignProposalError(
        'PROPOSAL_INVALID',
        422,
        'This change would leave the campaign in an invalid state. Please try a different request.',
        structResult.errors,
      );
    }

    // ── 8. Persist the validated proposal → ready ───────────────────────
    proposal.changes = validation.normalizedChanges;
    proposal.summary = { explanation: validation.explanation };
    proposal.aiMetadata = {
      provider: 'CLAUDE',
      model: providerResult.model,
      promptVersion: PROMPT_VERSION,
      generationId,
      generatedAt: new Date(),
      usage: providerResult.usage,
      generationDurationMs: providerResult.durationMs ?? (Date.now() - startedAt),
    };
    setProposalStatus(proposal, 'ready');
    await proposal.save();

    LoggerUtil.info('AI campaign edit proposal ready', {
      generationId,
      draftId: draft._id.toString(),
      proposalId: proposal._id.toString(),
      changeCount: proposal.changes.length,
      durationMs: Date.now() - startedAt,
    });

    return { proposal, generationId };
  } catch (rawError) {
    const failure = rawError instanceof CampaignProposalError
      ? rawError
      : (rawError?.type === 'VALIDATION_ERROR' ? rawError : classifyProviderError(rawError));

    setProposalStatus(proposal, 'failed');
    proposal.lastError = {
      code: failure.code || failure.type || 'PROPOSAL_FAILED',
      message: String(failure.message || '').slice(0, 300),
      at: new Date(),
    };
    await proposal.save().catch((e) => {
      LoggerUtil.error('Failed to mark proposal failed', e, { proposalId: proposal._id.toString(), generationId });
    });

    LoggerUtil.error('AI campaign edit proposal generation failed', rawError, {
      generationId,
      draftId: draft._id.toString(),
      proposalId: proposal._id.toString(),
      code: failure.code || 'PROPOSAL_FAILED',
      durationMs: Date.now() - startedAt,
    });

    failure.proposalId = proposal._id.toString();
    failure.generationId = generationId;
    throw failure;
  }
}

/**
 * Accept a ready proposal — atomic, revision-checked, fully re-validated.
 * Idempotent: accepting an already-accepted proposal returns the current
 * draft without reapplying anything.
 */
export async function acceptProposal({ proposalId, draftId, userId }) {
  const proposal = await loadOwnedProposal(proposalId, draftId);

  if (proposal.status === 'accepted') {
    const draft = await campaignDraftService.getDraft(draftId);
    return { draft, proposal, alreadyApplied: true };
  }
  if (proposal.status !== 'ready') {
    throw new ConflictError(`This suggestion is ${proposal.status === 'rejected' ? 'rejected' : proposal.status} and can no longer be accepted.`);
  }
  if (isExpired(proposal)) {
    setProposalStatus(proposal, 'expired');
    await proposal.save();
    throw new CampaignProposalError('PROPOSAL_EXPIRED', 409, 'This suggestion has expired. Please generate a new one.');
  }

  const draft = await campaignDraftService.getDraft(draftId);
  if (draft.version !== proposal.baseVersion) {
    setProposalStatus(proposal, 'stale');
    await proposal.save();
    throw new CampaignProposalError(
      'PROPOSAL_STALE',
      409,
      'This suggestion was created from an older version of your campaign. Please generate a new suggestion.',
    );
  }

  // ── Apply in memory + re-validate the COMPLETE resulting campaign ─────
  const draftPlain = draft.toObject();
  const applied = applyProposedChanges(draftPlain, proposal.changes.map((c) => c.toObject?.() ?? c));
  const normalizedCampaign = campaignDraftService._internals.normalizeCampaignInput(applied.campaign);
  const normalizedAdGroups = campaignDraftService._internals.normalizeAdGroups(applied.adGroups) ?? [];
  const structResult = validateCampaignDraftStructure(
    { campaign: normalizedCampaign, adGroups: normalizedAdGroups },
    { requireAdGroups: true, strictRsa: true },
  );
  if (!structResult.valid) {
    // Should not happen (already proven at generation time) unless
    // something inconsistent slipped through — fail closed, apply nothing.
    setProposalStatus(proposal, 'failed');
    proposal.lastError = { code: 'PROPOSAL_INVALID', message: 'Resulting campaign failed final validation.', at: new Date() };
    await proposal.save();
    throw new CampaignProposalError(
      'PROPOSAL_INVALID',
      422,
      'This suggestion could not be safely applied to your campaign.',
      structResult.errors,
    );
  }

  const changeLogEntries = proposal.changes.map((c) => ({
    id: c.id,
    source: 'AI',
    action: OPERATION_TO_CHANGE_ACTION[c.operation] || 'UPDATE',
    path: c.path || c.target,
    before: c.before ?? null,
    after: c.after ?? null,
    createdBy: userId,
    createdAt: new Date(),
  }));

  let updatedDraft;
  try {
    updatedDraft = await campaignDraftService.applyValidatedChanges(draftId, {
      campaign: normalizedCampaign,
      adGroups: normalizedAdGroups,
      expectedVersion: proposal.baseVersion,
      userId,
      changeLogEntries,
    });
  } catch (err) {
    if (err.type === 'CONFLICT') {
      setProposalStatus(proposal, 'stale');
      await proposal.save();
      throw new CampaignProposalError('PROPOSAL_STALE', 409, 'This suggestion was created from an older version of your campaign. Please generate a new suggestion.');
    }
    throw err;
  }

  setProposalStatus(proposal, 'accepted');
  proposal.acceptedAt = new Date();
  proposal.resultingVersion = updatedDraft.version;
  await proposal.save();

  LoggerUtil.info('AI campaign edit proposal accepted', {
    draftId: draftId.toString?.() || String(draftId),
    proposalId: proposal._id.toString(),
    changeCount: proposal.changes.length,
    resultingVersion: updatedDraft.version,
  });

  return { draft: updatedDraft, proposal, alreadyApplied: false };
}

/** Reject a ready proposal. Idempotent on an already-rejected proposal. Draft is never touched. */
export async function rejectProposal({ proposalId, draftId }) {
  const proposal = await loadOwnedProposal(proposalId, draftId);
  if (proposal.status === 'rejected') return { proposal };
  if (proposal.status !== 'ready') {
    throw new ConflictError(`This suggestion is ${proposal.status} and can no longer be rejected.`);
  }
  setProposalStatus(proposal, 'rejected');
  proposal.rejectedAt = new Date();
  await proposal.save();
  return { proposal };
}

/** One proposal, with freshness (stale/expired) refreshed opportunistically. */
export async function getProposal(proposalId, draftId) {
  const proposal = await loadOwnedProposal(proposalId, draftId);
  if (proposal.status === 'ready') {
    if (isExpired(proposal)) {
      setProposalStatus(proposal, 'expired');
      await proposal.save();
    } else {
      const draft = await campaignDraftService.getDraft(draftId);
      if (draft.version !== proposal.baseVersion) {
        setProposalStatus(proposal, 'stale');
        await proposal.save();
      }
    }
  }
  return proposal;
}

/** Recent proposals for a draft, newest first. Small, non-paginated-by-default list — a draft's conversation history is expected to be short (spec §53). */
export async function listProposals(draftId, { limit = 20 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  return AiCampaignChangeProposal.find({ draftId }).sort({ createdAt: -1 }).limit(safeLimit).lean();
}

export default {
  generateProposal,
  acceptProposal,
  rejectProposal,
  getProposal,
  listProposals,
  CampaignProposalError,
  setProviderOverride,
  resetProviderOverride,
};
