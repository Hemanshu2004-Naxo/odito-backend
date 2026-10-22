import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { NotFoundError } from '../../../utils/ErrorUtil.js';
import automationPolicyService from '../service/automation/automationPolicyService.js';
import automationPreviewService from '../service/automation/automationPreviewService.js';
import * as automationRunService from '../service/automation/automationRunService.js';

/**
 * AI Campaign Automation controller (Phase 8) — THIN, same discipline as
 * every prior phase's controller: auth + ownership + request-shape gate +
 * response shaping only. All policy validation/normalization, rule
 * evaluation, guardrails, and execution live in
 * service/automation/*.js.
 *
 * Every `:policyId` route also carries `:draftId` and cross-checks the
 * loaded policy's own `draftId` matches it — a policy id alone is never
 * trusted to imply access to the right campaign (same discipline
 * campaignOptimizationController.js applies to `:recommendationId`).
 */

function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') return res.status(404).json(ResponseUtil.notFound(error.message));
  if (error.type === 'ACCESS_DENIED') return res.status(403).json(ResponseUtil.accessDenied(error.message));
  if (error.type === 'VALIDATION_ERROR') return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  if (error.type === 'CONFLICT') return res.status(409).json(ResponseUtil.conflict(error.message));
  LoggerUtil.error(`[AI_CAMPAIGN_AUTOMATION] ${fallbackMessage}`, error, { message: error.message });
  return res.status(error.statusCode || 500).json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

async function loadOwnedPolicy(req) {
  const policy = await automationPolicyService.getPolicy({ userId: req.user._id, policyId: req.params.policyId });
  if (String(policy.draftId) !== String(req.params.draftId)) {
    throw new NotFoundError('Automation policy not found.');
  }
  return policy;
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies
export async function createPolicy(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    const policy = await automationPolicyService.createPolicy({
      userId: req.user._id, draftId: req.params.draftId, ...req.body,
    });
    return res.status(201).json(ResponseUtil.created(policy, 'Automation policy created'));
  } catch (error) {
    return handleError(res, error, 'Failed to create automation policy');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies
export async function listPolicies(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    const policies = await automationPolicyService.listPolicies({ userId: req.user._id, draftId: req.params.draftId });
    return res.status(200).json(ResponseUtil.success(policies, 'Automation policies retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch automation policies');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId
export async function getPolicy(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    const policy = await loadOwnedPolicy(req);
    return res.status(200).json(ResponseUtil.success(policy, 'Automation policy retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch automation policy');
  }
}

// PATCH /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId
export async function updatePolicy(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    await loadOwnedPolicy(req);
    const policy = await automationPolicyService.updatePolicy({
      userId: req.user._id, policyId: req.params.policyId, patch: req.body,
    });
    return res.status(200).json(ResponseUtil.updated(policy, 'Automation policy updated'));
  } catch (error) {
    return handleError(res, error, 'Failed to update automation policy');
  }
}

// DELETE /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId
export async function deletePolicy(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    await loadOwnedPolicy(req);
    await automationPolicyService.deletePolicy({ userId: req.user._id, policyId: req.params.policyId });
    return res.status(200).json(ResponseUtil.deleted('Automation policy deleted'));
  } catch (error) {
    return handleError(res, error, 'Failed to delete automation policy');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId/enable
export async function setEnabled(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    await loadOwnedPolicy(req);
    const policy = await automationPolicyService.setEnabled({
      userId: req.user._id, policyId: req.params.policyId, enabled: req.body.enabled,
    });
    return res.status(200).json(ResponseUtil.updated(policy, policy.enabled ? 'Automation policy enabled' : 'Automation policy disabled'));
  } catch (error) {
    return handleError(res, error, 'Failed to change automation policy status');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId/mode
export async function setMode(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    await loadOwnedPolicy(req);
    const policy = await automationPolicyService.setMode({
      userId: req.user._id, policyId: req.params.policyId, mode: req.body.mode,
    });
    return res.status(200).json(ResponseUtil.updated(policy, `Automation mode set to ${policy.mode}`));
  } catch (error) {
    return handleError(res, error, 'Failed to change automation mode');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId/preview
export async function previewPolicy(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    await loadOwnedPolicy(req);
    const preview = await automationPreviewService.previewPolicy({ userId: req.user._id, policyId: req.params.policyId });
    return res.status(200).json(ResponseUtil.success(preview, 'Automation preview generated'));
  } catch (error) {
    return handleError(res, error, 'Failed to preview automation policy');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/automation/policies/:policyId/history
export async function getPolicyHistory(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    const policy = await loadOwnedPolicy(req);
    const history = await automationRunService.getHistory({ projectId: policy.projectId, draftId: policy.draftId, policyId: policy._id });
    return res.status(200).json(ResponseUtil.success(history, 'Automation run history retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch automation run history');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/automation/history
export async function getDraftHistory(req, res) {
  try {
    if (firstValidationError(req, res)) return;
    const policies = await automationPolicyService.listPolicies({ userId: req.user._id, draftId: req.params.draftId });
    if (policies.length === 0) return res.status(200).json(ResponseUtil.success([], 'Automation run history retrieved'));
    const history = await automationRunService.getHistory({ projectId: policies[0].projectId, draftId: req.params.draftId });
    return res.status(200).json(ResponseUtil.success(history, 'Automation run history retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch automation run history');
  }
}

export default {
  createPolicy, listPolicies, getPolicy, updatePolicy, deletePolicy, setEnabled, setMode, previewPolicy, getPolicyHistory, getDraftHistory,
};
