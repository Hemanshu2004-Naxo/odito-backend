/**
 * Rate limiting for the AI campaign generation endpoint (spec §26).
 *
 * Every generation call spends paid Claude tokens, so this endpoint is
 * rate-limited even though it is already authenticated. Mirrors the style of
 * modules/user/middleware/authRateLimiters.js:
 *   - express-rate-limit v8, in-process MemoryStore (single instance today —
 *     do NOT add Redis speculatively; swap the store here when multi-instance)
 *   - keyed by authenticated user id, with an IPv6-safe IP fallback
 *   - HTTP 429 + `{ success:false, code:'RATE_LIMITED' }` + Retry-After
 *   - env kill-switch + tunables (see generationConfig.RATE_LIMIT)
 *
 * WHERE HARDER LIMITS GO LATER (not in Phase 2): per-project generation
 * quotas, plan-based monthly caps, and token-budget accounting belong in a
 * billing/quota service checked here or in campaignGenerationService before
 * the Claude call. This limiter is only abuse protection, not metering.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RATE_LIMIT } from '../constants/generationConfig.js';
import { ASSISTANT_RATE_LIMIT } from '../constants/editingConfig.js';
import { OPTIMIZATION_RATE_LIMIT } from '../constants/optimizationConfig.js';

const ipKey = (req) => ipKeyGenerator(req.ip);

function userKey(req) {
  const uid = req.user?._id || req.user?.id || req.userId;
  return uid ? `u:${String(uid)}` : ipKey(req);
}

function makeLimiter(config, message) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKey,
    handler: (req, res) => {
      res.set('Retry-After', String(Math.ceil(config.windowMs / 1000)));
      return res.status(429).json({ success: false, message, code: 'RATE_LIMITED' });
    },
  });
}

const generationLimiter = makeLimiter(RATE_LIMIT, 'Too many campaign generation requests. Please wait and try again.');
// Phase 4 (spec §30): a separate, more generous budget for conversational
// editing turns — a single edit exchange is far cheaper than a full
// campaign generation, so reusing the generation limiter's tighter count
// would be wrong. Shares the same env kill switch.
const assistantLimiter = makeLimiter(ASSISTANT_RATE_LIMIT, "You've reached the AI editing limit. Please try again later.");
// Phase 7 (spec §26 analogue): analyze() calls Claude at most once per
// request (often zero — see optimizationConfig's AI cost control notes),
// so this can share the assistant-tier budget shape rather than the
// tighter generation-tier count.
const optimizationLimiter = makeLimiter(OPTIMIZATION_RATE_LIMIT, "You've reached the optimization analysis limit. Please try again later.");

/**
 * Express middleware. A no-op pass-through when
 * AI_CAMPAIGN_RATE_LIMIT_ENABLED=false (read per-request so it can be
 * toggled in tests around a single case).
 */
export function aiCampaignGenerationRateLimiter(req, res, next) {
  if (process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED === 'false') return next();
  return generationLimiter(req, res, next);
}

/** Rate limiter for POST .../drafts/:draftId/assistant (Phase 4). */
export function aiCampaignAssistantRateLimiter(req, res, next) {
  if (process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED === 'false') return next();
  return assistantLimiter(req, res, next);
}

/** Rate limiter for POST .../drafts/:draftId/optimization/analyze (Phase 7). */
export function aiCampaignOptimizationRateLimiter(req, res, next) {
  if (process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED === 'false') return next();
  return optimizationLimiter(req, res, next);
}

export default aiCampaignGenerationRateLimiter;
