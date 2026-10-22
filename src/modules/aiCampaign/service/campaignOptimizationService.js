/**
 * campaignOptimizationService — Phase 7: Performance + AI Optimization
 * orchestrator (spec §1-§4, §50).
 *
 *   analyzeOptimization: read performance (reused, already-synced Google
 *     Ads data) → deterministic opportunity detection → persist
 *     opportunities → (only if any exist) Claude drafts recommendations →
 *     validate → persist recommendations
 *   approveRecommendation: re-validate current live Google Ads state
 *     (Layer 2) → atomic execution lock → mutate through the existing
 *     Google Ads mutation boundary → persist the durable execution record
 *   rejectRecommendation: mark rejected, nothing executes
 *
 * CORE RULE (spec §1): AI recommends. Odito validates. User approves.
 * Odito executes. This file is the ONLY code path allowed to reach a
 * Google Ads optimization mutation — Claude never receives OAuth
 * credentials and never calls Google Ads; the browser never constructs a
 * mutation payload (the approve/reject requests carry no body, same
 * convention as Phase 6's publish endpoint).
 *
 * DOMAIN RULE (spec §49): every operation here is scoped to
 * `AiCampaignDraft.googleAdsCustomerId` + `.googleAdsCampaignId` — the
 * trusted Odito-project → Odito-draft → persisted-Google-resource mapping
 * Phase 6 already established. A client-supplied Google campaign id is
 * never trusted as authoritative anywhere in this file.
 */

import { randomUUID } from 'node:crypto';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

import campaignDraftService from './campaignDraftService.js';
import AiCampaignOptimizationOpportunity from '../model/AiCampaignOptimizationOpportunity.js';
import AiCampaignOptimizationRecommendation from '../model/AiCampaignOptimizationRecommendation.js';
import AiCampaignPublishAttempt from '../model/AiCampaignPublishAttempt.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';

import * as performanceDataService from './optimization/performanceDataService.js';
import { detectOpportunities } from './optimization/opportunityDetector.js';
import { validateAndBuildRecommendations } from './optimization/recommendationValidator.js';
import { buildOptimizationSystemPrompt, buildOptimizationUserPrompt, PROMPT_VERSION } from '../prompts/generateOptimizationPrompt.js';
import realClaudeProvider from '../providers/claudeCampaignOptimizationProvider.js';
import realGoogleProvider from '../providers/googleAdsOptimizationProvider.js';
import { executeOptimization, OptimizationExecutionError } from './optimization/optimizationExecutor.js';
import * as executionRecordService from './optimization/executionRecordService.js';
import { MIN_OPPORTUNITIES_FOR_AI_CALL, MAX_OPPORTUNITIES_PER_AI_CALL, RECOMMENDATION_STALE_MS } from '../constants/optimizationConfig.js';

const GOOGLE_ADS_PURPOSE = 'google_ads';
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

export class CampaignOptimizationError extends Error {
  constructor(code, httpStatus, message, details = null) {
    super(message);
    this.name = 'CampaignOptimizationError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.type = 'CAMPAIGN_OPTIMIZATION_ERROR';
    if (details) this.details = details;
  }
}

// ── provider seams (mirrors campaignPublishService.js) ───────────────────
let _claudeOverride = null;
export function setClaudeProviderOverride(provider) { _claudeOverride = provider || null; }
export function resetClaudeProviderOverride() { _claudeOverride = null; }
function getClaudeProvider() { return _claudeOverride || realClaudeProvider; }

let _googleOverride = null;
export function setGoogleProviderOverride(provider) { _googleOverride = provider || null; }
export function resetGoogleProviderOverride() { _googleOverride = null; }
function getGoogleProvider() { return _googleOverride || realGoogleProvider; }

// Exported additively for Phase 8 (automationOrchestrator.js): the
// scheduler needs the exact same "is this campaign even eligible" and
// "which connected Google Ads account owns it" checks a manual analyze/
// approve call already makes — reused directly rather than re-derived.
export function assertDraftOptimizable(draft) {
  // spec §48/§49 — only a campaign Odito itself published (and can
  // therefore securely associate with a real Google Ads campaign) is
  // eligible. A draft that never published, or whose publish never
  // completed, has no trusted campaign id to scope anything to.
  if (draft.status !== 'published' || !draft.googleAdsCampaignId) {
    throw new CampaignOptimizationError('DRAFT_NOT_PUBLISHED', 400, 'Only a published campaign can be analyzed or optimized.');
  }
}

export async function resolveAccount({ userId, projectId, draft }) {
  const connection = await GoogleConnection.findActiveConnection(userId, projectId, GOOGLE_ADS_PURPOSE);
  if (!connection || !connection.google_ads_customer_id) {
    throw new CampaignOptimizationError('ACCOUNT_UNAVAILABLE', 400, 'No connected Google Ads account is available for this project.');
  }
  if (connection.google_ads_customer_id !== draft.googleAdsCustomerId) {
    throw new CampaignOptimizationError('ACCOUNT_UNAVAILABLE', 409, 'The connected Google Ads account has changed since this campaign was published.');
  }
  return connection;
}

async function upsertOpportunity({ projectId, draftId, campaignResourceId, opportunity }) {
  const doc = await AiCampaignOptimizationOpportunity.findOneAndUpdate(
    {
      draftId, entityType: opportunity.entityType, entityId: opportunity.entityId,
      opportunityType: opportunity.opportunityType, dateRangeKey: opportunity.dateRangeKey,
    },
    {
      $set: {
        projectId, campaignResourceId,
        entityLabel: opportunity.entityLabel, severity: opportunity.severity, confidence: opportunity.confidence,
        metrics: opportunity.metrics, baseline: opportunity.baseline, message: opportunity.message,
        dateRangeStart: opportunity.dateRangeStart, dateRangeEnd: opportunity.dateRangeEnd, detectedAt: new Date(),
      },
      $setOnInsert: { status: 'open' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
  return doc.toObject();
}

/** Mark any pending recommendation older than RECOMMENDATION_STALE_MS as stale (spec §32) — proactive, not just checked lazily on approve. */
async function markStaleRecommendations(draftId) {
  const cutoff = new Date(Date.now() - RECOMMENDATION_STALE_MS);
  await AiCampaignOptimizationRecommendation.updateMany(
    { draftId, status: 'pending', createdAt: { $lt: cutoff } },
    { $set: { status: 'stale' } },
  );
}

/**
 * AI cost control (spec §40): Claude is only called when deterministic
 * detection found at least MIN_OPPORTUNITIES_FOR_AI_CALL opportunities, and
 * only the MAX_OPPORTUNITIES_PER_AI_CALL most severe are ever sent. A
 * Claude failure never fails the whole analysis — the deterministic
 * opportunities are already persisted and useful on their own.
 */
async function generateRecommendations({ draft, projectId, opportunities, dateRange, targets }) {
  if (opportunities.length < MIN_OPPORTUNITIES_FOR_AI_CALL) return [];

  const existingPending = await AiCampaignOptimizationRecommendation.find({ draftId: draft._id, status: { $in: ['pending', 'approved'] } }, { target: 1, targetEntityId: 1 }).lean();
  const entitiesWithOpen = new Set(existingPending.map((r) => `${r.target}:${r.targetEntityId}`));

  const capped = [...opportunities]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3))
    .slice(0, MAX_OPPORTUNITIES_PER_AI_CALL);

  const provider = getClaudeProvider();
  if (!provider.isAvailable()) {
    LoggerUtil.warn('AI optimization provider not configured — skipping recommendation generation', { draftId: String(draft._id) });
    return [];
  }

  const campaignSummary = {
    name: draft.campaign.name,
    objective: draft.campaign.objective,
    currency: draft.campaign.currency,
    dailyBudget: draft.campaign.dailyBudget,
    dateRangeStart: dateRange.startDate.toISOString().slice(0, 10),
    dateRangeEnd: dateRange.endDate.toISOString().slice(0, 10),
  };
  const generationId = randomUUID();
  const system = buildOptimizationSystemPrompt();
  const user = buildOptimizationUserPrompt({ opportunities: capped, campaignSummary, businessContext: targets });

  let result;
  try {
    result = await provider.generateRecommendations({ system, user, generationId });
  } catch (err) {
    LoggerUtil.error('AI optimization recommendation generation failed — opportunities remain available without AI recommendations', err, { draftId: String(draft._id) });
    return [];
  }

  const { recommendations: built } = validateAndBuildRecommendations({
    rawRecommendations: result.parsed?.recommendations,
    opportunities: capped,
    campaign: {
      campaignResourceId: draft.googleAdsCampaignId,
      dailyBudgetMicros: draft.campaign.dailyBudgetMicros,
      currency: draft.campaign.currency,
      dateRangeStart: dateRange.startDate,
      dateRangeEnd: dateRange.endDate,
    },
  });

  const fresh = built.filter((r) => !entitiesWithOpen.has(`${r.target}:${r.targetEntityId}`));
  if (fresh.length === 0) return [];

  const created = await AiCampaignOptimizationRecommendation.insertMany(fresh.map((r) => ({
    projectId, draftId: draft._id, campaignResourceId: draft.googleAdsCampaignId,
    ...r,
    aiMetadata: {
      provider: 'CLAUDE', model: result.model, promptVersion: PROMPT_VERSION,
      generationId, generatedAt: new Date(), usage: result.usage,
    },
  })));

  LoggerUtil.info('recommendations_generated', { draftId: String(draft._id), count: created.length, generationId });
  return created.map((d) => d.toObject());
}

/**
 * @param {object} args
 * @param {string} args.draftId
 * @param {string} args.userId
 * @param {string} args.projectId
 * @param {Date} args.startDate
 * @param {Date} args.endDate
 * @param {object} [args.targets] - explicitly-supplied business targets (spec §11), never assumed
 */
export async function analyzeOptimization({ draftId, userId, projectId, startDate, endDate, targets = {} }) {
  const draft = await campaignDraftService.getDraft(draftId);
  assertDraftOptimizable(draft);
  await resolveAccount({ userId, projectId, draft });

  LoggerUtil.info('performance_requested', { draftId: String(draftId), startDate, endDate });

  const snapshot = await performanceDataService.getFullPerformanceSnapshot({
    projectId, customerId: draft.googleAdsCustomerId, campaignId: draft.googleAdsCampaignId, startDate, endDate,
  });

  if (!snapshot.dataAvailable) {
    throw new CampaignOptimizationError('PERFORMANCE_UNAVAILABLE', 400, 'No performance data is available yet for this campaign. Sync your Google Ads dashboard, then try again.');
  }
  LoggerUtil.info('performance_loaded', { draftId: String(draftId), keywordCount: snapshot.keywords.length, adCount: snapshot.ads.length });

  const rawOpportunities = detectOpportunities(snapshot, targets);
  const opportunities = await Promise.all(
    rawOpportunities.map((o) => upsertOpportunity({ projectId, draftId, campaignResourceId: draft.googleAdsCampaignId, opportunity: o })),
  );
  LoggerUtil.info('opportunities_detected', { draftId: String(draftId), count: opportunities.length });

  const recommendations = await generateRecommendations({ draft, projectId, opportunities, dateRange: snapshot.dateRange, targets });

  return { performance: snapshot, opportunities, recommendations };
}

export async function getLatestAnalysis({ draftId, projectId }) {
  const draft = await campaignDraftService.getDraft(draftId);
  await markStaleRecommendations(draftId);

  const [opportunities, recommendations] = await Promise.all([
    AiCampaignOptimizationOpportunity.find({ projectId, draftId, status: 'open' }).sort({ createdAt: -1 }).limit(200).lean(),
    AiCampaignOptimizationRecommendation.find({ projectId, draftId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);

  return { draft: draft.toObject(), opportunities, recommendations };
}

function mapExecutionCodeToHttpStatus(code) {
  switch (code) {
    case 'TARGET_NOT_FOUND': return 404;
    case 'TARGET_STATE_CHANGED': return 409;
    case 'GOOGLE_QUOTA': return 429;
    case 'GOOGLE_AUTHORIZATION_FAILED': return 403;
    case 'GOOGLE_VALIDATION_FAILED': return 400;
    default: return 502;
  }
}

/**
 * The single authoritative approve-and-execute flow (spec §18-§23). Every
 * mutation this codebase can make for an optimization goes through here.
 */
export async function approveRecommendation({ draftId, recommendationId, userId, projectId }) {
  const draft = await campaignDraftService.getDraft(draftId);
  assertDraftOptimizable(draft);
  await markStaleRecommendations(draftId);

  const recommendation = await AiCampaignOptimizationRecommendation.findOne({ _id: recommendationId, draftId, projectId });
  if (!recommendation) throw new CampaignOptimizationError('TARGET_NOT_FOUND', 404, 'Recommendation not found.');

  if (recommendation.status === 'executed') {
    const existing = await executionRecordService.getExecutionForRecommendation(recommendation._id);
    return { recommendation: recommendation.toObject(), execution: existing, alreadyExecuted: true };
  }
  if (recommendation.status === 'rejected' || recommendation.status === 'stale') {
    throw new CampaignOptimizationError('RECOMMENDATION_STALE', 409, `This recommendation is ${recommendation.status} and can no longer be approved.`);
  }
  if (!['pending', 'approved'].includes(recommendation.status)) {
    throw new CampaignOptimizationError('RECOMMENDATION_ALREADY_DECIDED', 409, `This recommendation has already been ${recommendation.status}.`);
  }
  if (!recommendation.executable) {
    throw new CampaignOptimizationError('OPTIMIZATION_NOT_ALLOWED', 400, 'This recommendation is informational only and cannot be executed automatically.');
  }

  const connection = await resolveAccount({ userId, projectId, draft });

  let execution = await executionRecordService.findOrCreateExecution({
    projectId, draftId, recommendationId: recommendation._id, campaignResourceId: draft.googleAdsCampaignId,
    operation: recommendation.operation, target: recommendation.target, targetEntityId: recommendation.targetEntityId, executedBy: userId,
  });
  if (execution.status === 'executed') {
    return { recommendation: recommendation.toObject(), execution: execution.toObject ? execution.toObject() : execution, alreadyExecuted: true };
  }

  const claimed = await executionRecordService.claimExecutionLock(execution._id);
  if (!claimed) {
    throw new CampaignOptimizationError('OPTIMIZATION_ALREADY_IN_PROGRESS', 409, 'This optimization is already being executed.');
  }
  execution = claimed;

  // Only flip to 'approved' once we actually hold the execution lock — a
  // failed claim (genuine concurrent in-progress execution) must never
  // leave the recommendation stuck in 'approved' with nothing to retry it.
  recommendation.status = 'approved';
  recommendation.decidedBy = userId;
  recommendation.decidedAt = new Date();
  await recommendation.save();

  LoggerUtil.info('optimization_started', { executionId: String(execution._id), draftId: String(draftId), recommendationId: String(recommendationId), operation: recommendation.operation });

  let context = { customerId: draft.googleAdsCustomerId };
  if (recommendation.target === 'CAMPAIGN') {
    const publishAttempt = await AiCampaignPublishAttempt.findOne({ draftId, status: 'published' }).lean();
    const budgetEntry = publishAttempt?.resources?.find((r) => r.type === 'CAMPAIGN_BUDGET');
    context = { ...context, campaignBudgetResourceName: budgetEntry?.googleResourceName || null };
  }

  const provider = getGoogleProvider();
  try {
    const customer = await provider.buildOptimizationCustomer(connection, { customerId: draft.googleAdsCustomerId, loginCustomerId: connection.google_ads_login_customer_id });
    const result = await executeOptimization({ provider, customer, recommendation: recommendation.toObject(), context });

    await executionRecordService.markExecuted(execution._id, {
      googleResourceName: result.googleResourceName,
      beforeState: recommendation.expectedCurrentValue,
      afterState: result.afterState,
    });
    recommendation.status = 'executed';
    await recommendation.save();

    const finalExecution = await executionRecordService.getExecutionForRecommendation(recommendation._id);
    LoggerUtil.info('optimization_completed', { executionId: String(execution._id), draftId: String(draftId), recommendationId: String(recommendationId), operation: recommendation.operation });
    return { recommendation: recommendation.toObject(), execution: finalExecution };
  } catch (err) {
    const isExecError = err instanceof OptimizationExecutionError;
    const code = isExecError ? err.code : 'GOOGLE_UNKNOWN';
    await executionRecordService.markFailed(execution._id, { code, message: err.message });
    recommendation.status = 'failed';
    await recommendation.save();
    LoggerUtil.error('optimization_failed', err, { executionId: String(execution._id), draftId: String(draftId), recommendationId: String(recommendationId), code });
    throw new CampaignOptimizationError(code, mapExecutionCodeToHttpStatus(code), err.message || 'Failed to execute this optimization.');
  }
}

export async function rejectRecommendation({ draftId, recommendationId, projectId, userId }) {
  await markStaleRecommendations(draftId);
  const recommendation = await AiCampaignOptimizationRecommendation.findOneAndUpdate(
    { _id: recommendationId, draftId, projectId, status: 'pending' },
    { $set: { status: 'rejected', decidedBy: userId, decidedAt: new Date() } },
    { new: true },
  );
  if (!recommendation) {
    const existing = await AiCampaignOptimizationRecommendation.findOne({ _id: recommendationId, draftId, projectId }).lean();
    if (!existing) throw new CampaignOptimizationError('TARGET_NOT_FOUND', 404, 'Recommendation not found.');
    throw new CampaignOptimizationError('RECOMMENDATION_ALREADY_DECIDED', 409, `This recommendation has already been ${existing.status}.`);
  }
  LoggerUtil.info('recommendation_rejected', { draftId: String(draftId), recommendationId: String(recommendationId) });
  return recommendation.toObject();
}

export async function getOptimizationHistory({ draftId, projectId, limit = 50 }) {
  const draft = await campaignDraftService.getDraft(draftId);
  const history = await executionRecordService.getHistory({ projectId: draft.projectId, draftId, limit });
  return history;
}

export default {
  analyzeOptimization, getLatestAnalysis, approveRecommendation, rejectRecommendation, getOptimizationHistory,
  setClaudeProviderOverride, resetClaudeProviderOverride, setGoogleProviderOverride, resetGoogleProviderOverride,
  assertDraftOptimizable, resolveAccount,
  CampaignOptimizationError,
};
