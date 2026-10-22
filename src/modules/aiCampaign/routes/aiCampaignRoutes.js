import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  createDraftValidator,
  listDraftsValidator,
  updateDraftValidator,
  draftIdParamValidator,
  generateCampaignValidator,
} from '../validator/campaignDraftValidator.js';
import {
  createDraft,
  listDrafts,
  getDraft,
  updateDraft,
  deleteDraft,
} from '../controller/campaignDraftController.js';
import { generateCampaign } from '../controller/campaignGenerationController.js';
import { aiCampaignGenerationRateLimiter, aiCampaignAssistantRateLimiter, aiCampaignOptimizationRateLimiter } from '../middleware/aiCampaignRateLimiter.js';
import {
  draftIdParamValidator as proposalDraftIdParamValidator,
  proposalIdParamValidator,
  generateProposalValidator,
} from '../validator/campaignProposalValidator.js';
import {
  generateProposal,
  listProposals,
  getProposal,
  acceptProposal,
  rejectProposal,
} from '../controller/campaignProposalController.js';
import { draftIdParamValidator as validationDraftIdParamValidator } from '../validator/campaignValidationValidator.js';
import { runValidation, getValidation } from '../controller/campaignValidationController.js';
import { draftIdParamValidator as publishDraftIdParamValidator } from '../validator/campaignPublishValidator.js';
import { publishDraft, getPublishStatus } from '../controller/campaignPublishController.js';
import {
  draftIdParamValidator as optimizationDraftIdParamValidator,
  recommendationIdParamValidator,
  analyzeValidator,
} from '../validator/campaignOptimizationValidator.js';
import {
  analyze, getAnalysis, approve, reject, getHistory,
} from '../controller/campaignOptimizationController.js';
import {
  draftIdParamValidator as automationDraftIdParamValidator,
  policyIdParamValidator as automationPolicyIdParamValidator,
  createPolicyValidator,
  updatePolicyValidator,
  setEnabledValidator,
  setModeValidator,
} from '../validator/campaignAutomationValidator.js';
import {
  createPolicy, listPolicies, getPolicy, updatePolicy, deletePolicy, setEnabled, setMode, previewPolicy, getPolicyHistory, getDraftHistory,
} from '../controller/campaignAutomationController.js';

/**
 * AI Campaign Builder — Draft routes (PHASE 1 foundation).
 *
 * Mounted at '/google-ads/ai-campaigns' in src/routes/index.js, so the full
 * paths are:
 *   POST   /api/google-ads/ai-campaigns/drafts
 *   GET    /api/google-ads/ai-campaigns/drafts
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId
 *   PATCH  /api/google-ads/ai-campaigns/drafts/:draftId
 *   DELETE /api/google-ads/ai-campaigns/drafts/:draftId
 *   POST   /api/google-ads/ai-campaigns/generate          (Phase 2 — Claude generation)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/assistant                    (Phase 4 — propose changes)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/proposals                    (Phase 4 — list proposals)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId        (Phase 4)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId/accept (Phase 4)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId/reject (Phase 4)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/validate                     (Phase 5 — run readiness validation)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/validation                   (Phase 5 — latest validation result)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/publish                      (Phase 6 — publish to Google Ads)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/publish                      (Phase 6 — latest publish attempt status)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/optimization/analyze         (Phase 7 — read performance, detect opportunities, generate AI recommendations)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/optimization/analysis        (Phase 7 — latest persisted analysis)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/optimization/recommendations/:recommendationId/approve (Phase 7 — approve + execute)
 *   POST   /api/google-ads/ai-campaigns/drafts/:draftId/optimization/recommendations/:recommendationId/reject  (Phase 7)
 *   GET    /api/google-ads/ai-campaigns/drafts/:draftId/optimization/history         (Phase 7 — executed optimization audit trail)
 *
 * Auth convention follows modules/lead/routes/leadRoutes.js (the repo's
 * most recent project-scoped CRUD module):
 *   - `router.use(auth)` — every route requires a valid bearer JWT.
 *   - create/list carry projectId in body/query, so ownership is checked
 *     up-front by the shared validateProjectAccess() middleware.
 *   - :draftId routes carry no projectId; ownership is resolved from the
 *     loaded draft's own projectId inside the controller
 *     (assertDraftOwnership → AuthUtil.validateProjectAccess).
 *
 * This module deliberately does NOT touch the existing Google Ads routes
 * (mounted at '/projects/:projectId/google-ads/...') — it is an additive
 * sibling namespace.
 */

const router = express.Router();

router.use(auth);

// Phase 2 — Claude AI campaign generation. projectId travels in the body,
// so ownership is checked up-front by validateProjectAccess(). Rate-limited
// (paid Claude tokens) before the project lookup / generation run.
router.post(
  '/generate',
  aiCampaignGenerationRateLimiter,
  generateCampaignValidator,
  validateProjectAccess(),
  generateCampaign,
);

router.post('/drafts', createDraftValidator, validateProjectAccess(), createDraft);
router.get('/drafts', listDraftsValidator, validateProjectAccess(), listDrafts);

router.get('/drafts/:draftId', draftIdParamValidator, getDraft);
router.patch('/drafts/:draftId', updateDraftValidator, updateDraft);
router.delete('/drafts/:draftId', draftIdParamValidator, deleteDraft);

// ── Phase 4 — conversational AI editing ───────────────────────────────────
// Nested under /drafts/:draftId, same as the routes above: no projectId on
// the request, ownership resolved from the loaded draft's own projectId
// inside the controller. Rate-limited separately from /generate (spec §30
// — an editing turn is much cheaper than a full generation).
router.post(
  '/drafts/:draftId/assistant',
  aiCampaignAssistantRateLimiter,
  generateProposalValidator,
  generateProposal,
);
router.get('/drafts/:draftId/proposals', proposalDraftIdParamValidator, listProposals);
router.get('/drafts/:draftId/proposals/:proposalId', proposalIdParamValidator, getProposal);
router.post('/drafts/:draftId/proposals/:proposalId/accept', proposalIdParamValidator, acceptProposal);
router.post('/drafts/:draftId/proposals/:proposalId/reject', proposalIdParamValidator, rejectProposal);

// ── Phase 5 — production campaign validation / pre-publish readiness ──────
// Read-only (validate computes + persists a result; it never mutates Google
// Ads — see campaignValidationService.js). No rate limiter: unlike
// /generate and /assistant this makes no Claude call, so it carries no
// external cost — same convention as the plain draft CRUD routes above.
router.post('/drafts/:draftId/validate', validationDraftIdParamValidator, runValidation);
router.get('/drafts/:draftId/validation', validationDraftIdParamValidator, getValidation);

// ── Phase 6 — Google Ads publish pipeline ─────────────────────────────────
// No rate limiter here either — same reasoning as /validate (no Claude call,
// no external cost this codebase needs to protect against). Concurrency
// protection is handled at the database layer (publishAttemptService's
// atomic lock claim), not by rate limiting.
router.post('/drafts/:draftId/publish', publishDraftIdParamValidator, publishDraft);
router.get('/drafts/:draftId/publish', publishDraftIdParamValidator, getPublishStatus);

// ── Phase 7 — performance + AI optimization ───────────────────────────────
// Only /analyze calls Claude (and only when deterministic detection finds
// something worth asking about — spec §40), so only it is rate-limited.
// Approve/reject/history are read/mutation endpoints against Odito's own
// already-generated recommendations — no external AI cost to protect.
router.post(
  '/drafts/:draftId/optimization/analyze',
  aiCampaignOptimizationRateLimiter,
  analyzeValidator,
  analyze,
);
router.get('/drafts/:draftId/optimization/analysis', optimizationDraftIdParamValidator, getAnalysis);
router.post('/drafts/:draftId/optimization/recommendations/:recommendationId/approve', recommendationIdParamValidator, approve);
router.post('/drafts/:draftId/optimization/recommendations/:recommendationId/reject', recommendationIdParamValidator, reject);
router.get('/drafts/:draftId/optimization/history', optimizationDraftIdParamValidator, getHistory);

// ── Phase 8 — automation & autonomous optimization controls ──────────────
// No Claude call anywhere in this feature's request path (automation rules
// are fully deterministic — see automationOrchestrator.js), so no rate
// limiter here, same reasoning as /validate and /publish above. Every
// mutation a policy can ever cause goes through Phase 7's own
// approveRecommendation — nothing here talks to Google Ads directly.
router.post('/drafts/:draftId/automation/policies', createPolicyValidator, createPolicy);
router.get('/drafts/:draftId/automation/policies', automationDraftIdParamValidator, listPolicies);
router.get('/drafts/:draftId/automation/policies/:policyId', automationPolicyIdParamValidator, getPolicy);
router.patch('/drafts/:draftId/automation/policies/:policyId', updatePolicyValidator, updatePolicy);
router.delete('/drafts/:draftId/automation/policies/:policyId', automationPolicyIdParamValidator, deletePolicy);
router.post('/drafts/:draftId/automation/policies/:policyId/enable', setEnabledValidator, setEnabled);
router.post('/drafts/:draftId/automation/policies/:policyId/mode', setModeValidator, setMode);
router.post('/drafts/:draftId/automation/policies/:policyId/preview', automationPolicyIdParamValidator, previewPolicy);
router.get('/drafts/:draftId/automation/policies/:policyId/history', automationPolicyIdParamValidator, getPolicyHistory);
router.get('/drafts/:draftId/automation/history', automationDraftIdParamValidator, getDraftHistory);

export default router;
