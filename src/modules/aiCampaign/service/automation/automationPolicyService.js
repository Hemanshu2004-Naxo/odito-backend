import mongoose from 'mongoose';
import AiCampaignAutomationPolicy from '../../model/AiCampaignAutomationPolicy.js';
import campaignDraftService from '../campaignDraftService.js';
import { AuthUtil } from '../../../../utils/AuthUtil.js';
import { NotFoundError, ValidationError } from '../../../../utils/ErrorUtil.js';
import {
  AUTOMATION_MODES, AUTOMATION_OPERATIONS, AUTOMATION_DEFAULT_OPERATIONS,
  RULE_METRICS, RULE_OPERATORS, AUTOMATION_FREQUENCIES,
} from '../../constants/automationEnums.js';
import {
  USER_LIMIT_CEILING, DEFAULT_MAX_ACTIONS_PER_RUN, DEFAULT_COOLDOWN_HOURS, DEFAULT_MAX_BUDGET_CHANGE_PERCENT,
  MIN_ALLOWED_RULE_MINIMUM_CLICKS, DEFAULT_RULE_MINIMUM_CLICKS, MAX_RULES_PER_POLICY,
} from '../../constants/automationConfig.js';
import { computeNextRunAt, isValidTimezone } from './automationScheduleCalculator.js';

/**
 * automationPolicyService — Phase 8. CRUD + authorization for
 * AiCampaignAutomationPolicy. Every write goes through an explicit
 * field-by-field normalizer (never a raw spread of client input into a
 * document/`$set` — same mass-assignment discipline as
 * campaignDraftService.js) and every enum/allow-list check is an
 * `Array.includes()` on the raw value BEFORE it is ever used to index an
 * object (the Phase 4 lesson, re-applied here for `operation`/`metric`/
 * `operator`/`frequency`).
 *
 * `enabled` and `mode` only ever change via `setEnabled`/`setMode` — both
 * require an explicit, separate user action; a structural `updatePolicy`
 * call never implicitly re-enables a disabled policy or changes its mode.
 */

function normalizeRules(rawRules, allowedOperations) {
  if (rawRules === undefined) return [];
  if (!Array.isArray(rawRules)) throw new ValidationError('rules must be an array.');
  if (rawRules.length > MAX_RULES_PER_POLICY) throw new ValidationError(`A policy may define at most ${MAX_RULES_PER_POLICY} rules.`);

  return rawRules.map((r, i) => {
    const operation = r?.operation;
    if (!AUTOMATION_OPERATIONS.includes(operation)) throw new ValidationError(`Rule ${i + 1}: unknown operation.`);
    if (!allowedOperations.includes(operation)) throw new ValidationError(`Rule ${i + 1}: operation "${operation}" is not in this policy's allowedOperations.`);

    const metric = r?.metric;
    if (!RULE_METRICS.includes(metric)) throw new ValidationError(`Rule ${i + 1}: unknown metric.`);

    const operator = r?.operator;
    if (!RULE_OPERATORS.includes(operator)) throw new ValidationError(`Rule ${i + 1}: unknown operator.`);

    const threshold = Number(r?.threshold);
    if (!Number.isFinite(threshold)) throw new ValidationError(`Rule ${i + 1}: threshold must be a number.`);

    const rawMinClicks = Number(r?.minimumClicks);
    const minimumClicks = Math.max(Number.isFinite(rawMinClicks) && rawMinClicks > 0 ? rawMinClicks : DEFAULT_RULE_MINIMUM_CLICKS, MIN_ALLOWED_RULE_MINIMUM_CLICKS);

    const rawPriority = Number(r?.priority);
    const priority = Number.isFinite(rawPriority) ? rawPriority : 0;

    return { operation, metric, operator, threshold, minimumClicks, priority };
  });
}

function normalizeAllowedOperations(raw) {
  if (raw === undefined) return [...AUTOMATION_DEFAULT_OPERATIONS];
  if (!Array.isArray(raw)) throw new ValidationError('allowedOperations must be an array.');
  const deduped = [...new Set(raw)];
  for (const op of deduped) {
    if (!AUTOMATION_OPERATIONS.includes(op)) throw new ValidationError(`Unknown operation "${op}" in allowedOperations.`);
  }
  return deduped.length > 0 ? deduped : [...AUTOMATION_DEFAULT_OPERATIONS];
}

function normalizeLimits(raw) {
  const clamp = (v, dflt, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return dflt;
    return Math.min(n, max);
  };
  return {
    maxActionsPerRun: clamp(raw?.maxActionsPerRun, DEFAULT_MAX_ACTIONS_PER_RUN, USER_LIMIT_CEILING.maxActionsPerRun),
    cooldownHours: clamp(raw?.cooldownHours, DEFAULT_COOLDOWN_HOURS, USER_LIMIT_CEILING.cooldownHours),
    maxBudgetChangePercent: clamp(raw?.maxBudgetChangePercent, DEFAULT_MAX_BUDGET_CHANGE_PERCENT, USER_LIMIT_CEILING.maxBudgetChangePercent),
  };
}

function normalizeSchedule(raw) {
  const frequency = raw?.frequency;
  if (!AUTOMATION_FREQUENCIES.includes(frequency)) throw new ValidationError('schedule.frequency is invalid.');

  const timezone = typeof raw?.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : 'UTC';
  if (!isValidTimezone(timezone)) throw new ValidationError(`"${timezone}" is not a recognized timezone.`);

  const rawHour = Number(raw?.hourOfDay);
  const hourOfDay = Number.isInteger(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9;

  const rawDay = Number(raw?.dayOfWeek);
  const dayOfWeek = Number.isInteger(rawDay) ? Math.min(6, Math.max(0, rawDay)) : 1;

  return { frequency, timezone, hourOfDay, dayOfWeek };
}

async function loadOwnedDraft(userId, draftId) {
  const draft = await campaignDraftService.getDraft(draftId);
  await AuthUtil.validateProjectAccess(userId, draft.projectId);
  return draft;
}

async function getPolicyDocOrThrow(policyId) {
  if (!mongoose.isValidObjectId(policyId)) throw new NotFoundError('Automation policy not found.');
  const policy = await AiCampaignAutomationPolicy.findById(policyId);
  if (!policy) throw new NotFoundError('Automation policy not found.');
  return policy;
}

export async function createPolicy({
  userId, draftId, name, rules, allowedOperations, highRiskOperationsEnabled, limits, schedule, dateRangePreset,
}) {
  const draft = await loadOwnedDraft(userId, draftId);
  if (draft.status !== 'published' || !draft.googleAdsCampaignId) {
    throw new ValidationError('Automation can only be configured for a campaign Odito has published.');
  }

  const normalizedAllowed = normalizeAllowedOperations(allowedOperations);
  const normalizedRules = normalizeRules(rules, normalizedAllowed);
  const normalizedLimits = normalizeLimits(limits);
  const normalizedSchedule = normalizeSchedule(schedule);

  const policy = new AiCampaignAutomationPolicy({
    projectId: draft.projectId,
    draftId: draft._id,
    createdBy: userId,
    name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 150) : 'Untitled automation policy',
    enabled: false,
    mode: 'observe',
    rules: normalizedRules,
    allowedOperations: normalizedAllowed,
    highRiskOperationsEnabled: Boolean(highRiskOperationsEnabled),
    limits: normalizedLimits,
    schedule: normalizedSchedule,
    dateRangePreset: typeof dateRangePreset === 'string' ? dateRangePreset.slice(0, 20) : '30d',
    nextRunAt: null,
    version: 1,
  });

  await policy.save();
  return policy.toObject();
}

export async function updatePolicy({ userId, policyId, patch = {} }) {
  const policy = await getPolicyDocOrThrow(policyId);
  await AuthUtil.validateProjectAccess(userId, policy.projectId);

  const normalizedAllowed = patch.allowedOperations !== undefined ? normalizeAllowedOperations(patch.allowedOperations) : policy.allowedOperations;
  const normalizedRules = patch.rules !== undefined ? normalizeRules(patch.rules, normalizedAllowed) : policy.rules;

  if (patch.name !== undefined) policy.name = (typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim().slice(0, 150) : policy.name;
  policy.rules = normalizedRules;
  policy.allowedOperations = normalizedAllowed;
  if (patch.highRiskOperationsEnabled !== undefined) policy.highRiskOperationsEnabled = Boolean(patch.highRiskOperationsEnabled);
  if (patch.limits !== undefined) policy.limits = normalizeLimits(patch.limits);
  if (patch.schedule !== undefined) policy.schedule = normalizeSchedule(patch.schedule);
  if (patch.dateRangePreset !== undefined) policy.dateRangePreset = String(patch.dateRangePreset).slice(0, 20);

  policy.version += 1;
  if (policy.enabled) policy.nextRunAt = computeNextRunAt(policy.schedule, new Date());

  await policy.save();
  return policy.toObject();
}

/** enable/disable is a distinct, explicit action from a structural edit (spec: enable/execute-mode changes get their own confirmation). */
export async function setEnabled({ userId, policyId, enabled }) {
  const policy = await getPolicyDocOrThrow(policyId);
  await AuthUtil.validateProjectAccess(userId, policy.projectId);

  policy.enabled = Boolean(enabled);
  policy.nextRunAt = policy.enabled ? computeNextRunAt(policy.schedule, new Date()) : null;
  await policy.save();
  return policy.toObject();
}

/** Mode is NEVER changed anywhere else in this codebase — the scheduler/orchestrator only ever reads it. */
export async function setMode({ userId, policyId, mode }) {
  if (!AUTOMATION_MODES.includes(mode)) throw new ValidationError('Invalid automation mode.');
  const policy = await getPolicyDocOrThrow(policyId);
  await AuthUtil.validateProjectAccess(userId, policy.projectId);

  policy.mode = mode;
  await policy.save();
  return policy.toObject();
}

export async function getPolicy({ userId, policyId }) {
  const policy = await getPolicyDocOrThrow(policyId);
  await AuthUtil.validateProjectAccess(userId, policy.projectId);
  return policy.toObject();
}

export async function listPolicies({ userId, draftId }) {
  const draft = await loadOwnedDraft(userId, draftId);
  return AiCampaignAutomationPolicy.find({ projectId: draft.projectId, draftId: draft._id }).sort({ createdAt: -1 }).lean();
}

export async function deletePolicy({ userId, policyId }) {
  const policy = await getPolicyDocOrThrow(policyId);
  await AuthUtil.validateProjectAccess(userId, policy.projectId);
  await AiCampaignAutomationPolicy.deleteOne({ _id: policy._id });
  return { deleted: true };
}

export default {
  createPolicy, updatePolicy, setEnabled, setMode, getPolicy, listPolicies, deletePolicy,
};
