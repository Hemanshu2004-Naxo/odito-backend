/**
 * Central subscription plan configuration.
 *
 * This is the single source of truth for plan pricing, quota limits, and
 * feature availability. Nothing outside this file should hardcode a plan
 * id string, a credit count, a page count, a price, or a feature list —
 * every consumer (schema defaults, controllers, APIs) must go through the
 * accessor functions below instead.
 *
 * Adding Pro/Premium later is a config-only change: add an entry to PLANS
 * and extend the `subscription.plan` enum in User.js. No other code change
 * is required — every controller/API in this codebase reads plan data
 * exclusively through getPlan()/getPlanLimits()/getPlanFeatures()/
 * getActivePlans()/isValidPlan(), never PLANS directly.
 */

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'For individuals and small sites launching their first SEO audit.',
    price: 25,
    currency: 'usd',
    billingInterval: 'month',
    credits: 1,
    pages: 100,
    // Manual Recrawls per billing period (a user-level pool, like credits/pages;
    // resets on renewal via allocateQuotaFromPlan()). Weekly Rechecks and a
    // project's first audit never consume it. Starter 3 / Pro 10 / Premium 30 —
    // edit here only; nothing else hardcodes them.
    recrawls: 3,
    // Max keywords a single project may track at once (SeoRankingCurrent.keywords[]
    // length). null would mean unlimited — see getKeywordLimit() below. This is a
    // per-project cap, not account-wide: matches how the Keywords page itself is
    // already scoped to one project at a time.
    keywords: 5,
    features: {
      aiSeoAudit: true,
      aiVisibilityAudit: true,
      technicalSeoAudit: true,
      accessibilityAudit: true,
      performanceAudit: true,
      urlSelection: true,
      failedUrlRetry: true,
      pdfReport: true,
      weeklyRecheck: false,
      teamMembers: 1,
      apiAccess: false,
      whiteLabel: false,
    },
    active: true,
    // Name of the env var holding this plan's Stripe Price ID — not the
    // value itself. The value is resolved lazily by getStripePriceId(),
    // never read at module load time, so this file's import order relative
    // to dotenv.config() never matters.
    stripePriceEnvVar: 'STRIPE_STARTER_PRICE_ID',
    // Social Media AI: calendar posts the AI may plan per UTC month for this plan (see getSocialAiAllowance()).
    //   number      = the allowance
    //   'unlimited' = deliberately unlimited (a decision, written here)
    //   null        = NOT DECIDED YET. The allowance is then read from SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH; if that is unset too,
    //                 production refuses calendar generation (fail closed) instead of allowing unlimited use.
    socialAi: { calendarPostsPerMonth: null },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For growing teams running audits across more sites.',
    price: 99,
    currency: 'usd',
    billingInterval: 'month',
    credits: 5,
    pages: 250,
    recrawls: 10,
    keywords: 15,
    // Same feature set as Starter — Phase 1 is quota/pricing scaffolding only;
    // feature-gating differentiation across tiers is explicitly out of scope
    // here and was not part of this phase's spec.
    features: {
      aiSeoAudit: true,
      aiVisibilityAudit: true,
      technicalSeoAudit: true,
      accessibilityAudit: true,
      performanceAudit: true,
      urlSelection: true,
      failedUrlRetry: true,
      pdfReport: true,
      weeklyRecheck: false,
      teamMembers: 1,
      apiAccess: false,
      whiteLabel: false,
    },
    active: true,
    stripePriceEnvVar: 'STRIPE_PRO_PRICE_ID',
    // Social Media AI: calendar posts the AI may plan per UTC month for this plan (see getSocialAiAllowance()).
    //   number      = the allowance
    //   'unlimited' = deliberately unlimited (a decision, written here)
    //   null        = NOT DECIDED YET. The allowance is then read from SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH; if that is unset too,
    //                 production refuses calendar generation (fail closed) instead of allowing unlimited use.
    socialAi: { calendarPostsPerMonth: null },
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    description: 'For agencies and larger sites needing the most headroom.',
    price: 179,
    currency: 'usd',
    billingInterval: 'month',
    credits: 10,
    pages: 500,
    recrawls: 30,
    keywords: 30,
    // Same feature set as Starter/Pro — see the note on `pro.features` above.
    features: {
      aiSeoAudit: true,
      aiVisibilityAudit: true,
      technicalSeoAudit: true,
      accessibilityAudit: true,
      performanceAudit: true,
      urlSelection: true,
      failedUrlRetry: true,
      pdfReport: true,
      weeklyRecheck: false,
      teamMembers: 1,
      apiAccess: false,
      whiteLabel: false,
    },
    active: true,
    stripePriceEnvVar: 'STRIPE_PREMIUM_PRICE_ID',
    // Social Media AI: calendar posts the AI may plan per UTC month for this plan (see getSocialAiAllowance()).
    //   number      = the allowance
    //   'unlimited' = deliberately unlimited (a decision, written here)
    //   null        = NOT DECIDED YET. The allowance is then read from SOCIAL_AI_PREMIUM_CALENDAR_POSTS_PER_MONTH; if that is unset too,
    //                 production refuses calendar generation (fail closed) instead of allowing unlimited use.
    socialAi: { calendarPostsPerMonth: null },
  },
};

export const DEFAULT_PLAN_ID = 'starter';

/**
 * @param {string} planId
 * @returns {object} the full plan definition
 * @throws if planId is not a known plan
 */
export function getPlan(planId) {
  const plan = PLANS[planId];
  if (!plan) {
    throw new Error(`Unknown plan: ${planId}`);
  }
  return plan;
}

/**
 * @param {string} planId
 * @returns {{credits:number, pages:number, recrawls:number}}
 */
export function getPlanLimits(planId) {
  const { credits, pages, recrawls } = getPlan(planId);
  return { credits, pages, recrawls: recrawls ?? 0 };
}

/**
 * Separate accessor from getPlanLimits() deliberately — credits/pages are
 * user-level quotas with a `used` counter that resets on renewal
 * (allocateQuotaFromPlan()); the keyword limit is a per-project cap read
 * fresh against a live array length (SeoRankingCurrent.keywords.length),
 * nothing to reset. Mixing it into getPlanLimits() would misleadingly imply
 * the same reset-on-renewal semantics apply.
 * @param {string} planId
 * @returns {number|null} max keywords per project, or null for unlimited
 */
export function getKeywordLimit(planId) {
  const { keywords } = getPlan(planId);
  return keywords ?? null;
}

/**
 * @param {string} planId
 * @returns {object} the plan's features object (booleans + numeric limits
 *   like teamMembers) — a shallow copy, so callers can't mutate the config.
 */
export function getPlanFeatures(planId) {
  return { ...getPlan(planId).features };
}

/**
 * @param {string} planId
 * @param {string} featureKey - one of the keys under PLANS[planId].features
 * @returns {boolean}
 */
export function hasFeature(planId, featureKey) {
  const plan = getPlan(planId);
  return Boolean(plan.features[featureKey]);
}

/**
 * @returns {object[]} every plan with `active: true`, in PLANS declaration
 *   order. Inactive plans (retired/beta) are never returned — this is the
 *   only function GET /plans should use.
 */
export function getActivePlans() {
  return Object.values(PLANS).filter((plan) => plan.active);
}

/**
 * @param {string} planId
 * @returns {boolean} true if planId is a known plan (active or not)
 */
export function isValidPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/**
 * Resolves a plan's Stripe Price ID from its configured env var, at call
 * time (never at module load — see the comment on `stripePriceEnvVar`
 * above). This is the only function that should ever produce a Stripe
 * Price ID; nothing else in the codebase should read a
 * STRIPE_*_PRICE_ID env var directly.
 * @param {string} planId
 * @returns {string} the Stripe Price ID for this plan
 * @throws if the plan is unknown, or its env var is unset
 */
export function getStripePriceId(planId) {
  const plan = getPlan(planId);
  const priceId = process.env[plan.stripePriceEnvVar];
  if (!priceId) {
    throw new Error(
      `Stripe is not configured for plan "${planId}": environment variable ${plan.stripePriceEnvVar} is not set.`
    );
  }
  return priceId;
}

/**
 * Reverse of getStripePriceId() — resolves a Stripe Price ID (read off a
 * webhook payload's subscription.items) back to the Odito plan id it
 * belongs to. Used exclusively by the plan-change webhook sync (Phase 15)
 * to detect "the user's Stripe subscription now points at a different
 * plan's price" without hardcoding a second id-to-plan map anywhere.
 *
 * Only checks active plans, matching getActivePlans() — a price pointing at
 * a retired/inactive plan should not silently re-activate it locally.
 * Plans whose Stripe env var isn't configured are skipped rather than
 * thrown from, so one missing price id never breaks lookups for the rest.
 * @param {string} priceId
 * @returns {string|null} the matching plan id, or null if none matched
 */
export function getPlanIdByStripePriceId(priceId) {
  for (const plan of getActivePlans()) {
    try {
      if (getStripePriceId(plan.id) === priceId) {
        return plan.id;
      }
    } catch {
      // This plan's Stripe price env var isn't configured — not a match,
      // not an error worth surfacing here.
    }
  }
  return null;
}
