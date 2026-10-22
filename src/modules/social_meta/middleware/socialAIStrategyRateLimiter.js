import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RATE_LIMIT } from '../service/aiStrategy/strategyConfig.js';
import { CONTENT_RATE_LIMIT } from '../service/aiContent/contentConfig.js';
import { DESIGN_RATE_LIMIT } from '../service/aiDesign/designConfig.js';
import { CALENDAR_RATE_LIMIT } from '../service/calendar/calendarConfig.js';

/**
 * Abuse protection for the Social Media AI generation endpoints (AI Strategy,
 * single-post AI content and AI design) - every accepted call spends paid AI tokens.
 * ONE implementation for both, same approach as the AI Campaign limiter:
 * in-process store keyed by the authenticated user (IPv6-safe IP fallback),
 * HTTP 429 with a `RATE_LIMITED` code and Retry-After, an env kill switch per
 * endpoint and tunables (SOCIAL_AI_STRATEGY_RATE_* / SOCIAL_AI_CONTENT_RATE_*).
 * Metering / plan quotas would belong elsewhere.
 */
const userKey = (req) => {
  const uid = req.user?._id || req.user?.id || req.userId;
  return uid ? `u:${String(uid)}` : ipKeyGenerator(req.ip);
};

function makeLimiter(config, message) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKey,
    handler: (req, res) => {
      res.set('Retry-After', String(Math.ceil(config.windowMs / 1000)));
      return res.status(429).json({ success: false, message, details: { code: 'RATE_LIMITED' } });
    },
  });
}

/** Wraps a limiter so its kill switch (an env var read per request) can turn it into a pass-through. */
const switchable = (envName, limiter) => (req, res, next) => (process.env[envName] === 'false' ? next() : limiter(req, res, next));

const strategyLimiter = makeLimiter(RATE_LIMIT, 'Too many strategy generation requests. Please wait and try again.');
const contentLimiter = makeLimiter(CONTENT_RATE_LIMIT, 'Too many post generation requests. Please wait and try again.');
const designLimiter = makeLimiter(DESIGN_RATE_LIMIT, 'Too many design generation requests. Please wait and try again.');
const calendarLimiter = makeLimiter(CALENDAR_RATE_LIMIT, 'Too many content calendar requests. Please wait and try again.');

export const socialAIStrategyGenerateRateLimiter = switchable('SOCIAL_AI_STRATEGY_RATE_LIMIT_ENABLED', strategyLimiter);
export const socialAIContentGenerateRateLimiter = switchable('SOCIAL_AI_CONTENT_RATE_LIMIT_ENABLED', contentLimiter);
// Image generation costs far more than text, so it has its own (tighter) budget: SOCIAL_AI_DESIGN_RATE_* / SOCIAL_AI_DESIGN_RATE_LIMIT_ENABLED.
export const socialAIDesignGenerateRateLimiter = switchable('SOCIAL_AI_DESIGN_RATE_LIMIT_ENABLED', designLimiter);

// A calendar is several planning calls, so it has its own budget: SOCIAL_AI_CALENDAR_RATE_* / SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED.
export const socialAICalendarGenerateRateLimiter = switchable('SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED', calendarLimiter);
// Re-planning one item and starting a post from one item each spend AI tokens (one call, like a single post): SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED, tuned with the single-post budget.
const calendarItemLimiter = makeLimiter(CONTENT_RATE_LIMIT, 'Too many requests for this calendar item. Please wait and try again.');
export const socialAICalendarItemAIRateLimiter = switchable('SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED', calendarItemLimiter);

export default socialAIStrategyGenerateRateLimiter;
