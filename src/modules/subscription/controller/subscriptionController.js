import { getPlan, getActivePlans, isValidPlan, getStripePriceId } from '../../../config/plans.js';
import { summarizeQuota } from '../../../utils/creditService.js';
import {
  createCheckoutSession as createStripeCheckoutSession,
  createBillingPortalSession as createStripeBillingPortalSession,
  updateSubscriptionPrice,
  verifyWebhookSignature,
} from '../../../services/stripeService.js';
import { processStripeEvent } from '../service/subscriptionWebhookService.js';
import { canChangePlan } from '../service/subscriptionLifecycle.js';
import { submitCustomPlanRequest, getLatestCustomPlanRequest } from '../service/customPlanRequestService.js';
import { validateCustomPlanRequestInput } from '../../../utils/customPlanRequestValidation.js';
import Transaction from '../model/Transaction.js';
import PagePurchase from '../../page_purchase/model/PagePurchase.js';
import CreditPurchase from '../../credit_purchase/model/CreditPurchase.js';
import { getServiceUrls } from '../../../config/env.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Single serialization for a plan, used identically by both endpoints below
 * — the only place that decides which plan fields are public-response
 * shaped. `limits` is the plan's static definition (what Starter/Pro/
 * Premium each grant); it is distinct from a specific user's live quota
 * (limit/used/remaining), which only GET /subscription returns, via
 * summarizeQuota().
 *
 * `limits.keywords` mirrors getKeywordLimit()'s own `?? null` semantics
 * (null = unlimited) rather than calling that function separately — `plan`
 * here is already the resolved object getKeywordLimit() would look up
 * internally, so reading `plan.keywords` directly avoids a redundant
 * second lookup of the same config/plans.js entry.
 * @param {object} plan - a plan object from config/plans.js
 */
function serializePlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price: plan.price,
    currency: plan.currency,
    billingInterval: plan.billingInterval,
    limits: {
      credits: plan.credits,
      pages: plan.pages,
      recrawls: plan.recrawls ?? 0,
      keywords: plan.keywords ?? null,
    },
    features: plan.features,
  };
}

/**
 * GET /subscription (auth required)
 * Returns the authenticated user's plan metadata, status, and live
 * credits/pages quota. Every value is derived from config/plans.js and
 * creditService.js — nothing here hardcodes a plan id, limit, or price.
 *
 * A never-subscribed (or fully-lapsed) user has `subscription.plan: null`
 * (Phase 15.6 — Starter is paid, not a free default) — `plan` in the
 * response is `null` in that case, never a fabricated/placeholder plan.
 * getPlan() is only ever called with a real, non-null plan id.
 */
export const getMySubscription = async (req, res) => {
  try {
    const { plan: planId, status, stripeCustomerId } = req.user.subscription;
    const plan = planId ? getPlan(planId) : null;
    const { credits, pages, recrawls } = summarizeQuota(req.user);

    return res.status(200).json(ResponseUtil.success({
      plan: plan ? serializePlan(plan) : null,
      status,
      credits,
      pages,
      // Manual Recrawl allowance (full audits started with "Start Recrawl").
      // Weekly Rechecks, Quick Rechecks and a project's first audit are free.
      recrawls,
      // hasBillingAccount only — never the raw Stripe id. The frontend uses
      // this single boolean to decide whether to show "Manage Subscription";
      // it never learns the actual stripeCustomerId/stripeSubscriptionId.
      billing: {
        hasBillingAccount: Boolean(stripeCustomerId),
      },
    }, 'Subscription retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting subscription', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to get subscription', 500));
  }
};

/**
 * GET /plans (public — no auth)
 * Returns every active plan. Inactive plans are never included, since
 * getActivePlans() already filters them at the config layer.
 */
export const getPlans = async (req, res) => {
  try {
    const plans = getActivePlans().map(serializePlan);
    return res.status(200).json(ResponseUtil.success(plans, 'Plans retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting plans', error);
    return res.status(500).json(ResponseUtil.error('Failed to get plans', 500));
  }
};

/**
 * POST /subscription/checkout (auth required)
 * Body: { plan: "starter" }
 *
 * Creates a Stripe Checkout Session and returns its URL. This is the ONLY
 * thing this endpoint does — no User document is read for writing, no
 * quota field is touched, no subscription field changes. Activation (what
 * happens after a successful payment) is deliberately not implemented
 * here; that requires the webhook this phase explicitly excludes.
 *
 * Security: the client sends only a plan id, never a price. The Price ID
 * that actually determines what Stripe charges comes exclusively from
 * getStripePriceId(planId) — config/plans.js resolved server-side — so a
 * tampered request body can change which (valid, active) plan is being
 * purchased, never what it costs.
 */
export const createCheckoutSession = async (req, res) => {
  try {
    const { plan: planId } = req.body;

    if (!planId || typeof planId !== 'string') {
      return res.status(400).json(ResponseUtil.error('plan is required', 400));
    }

    if (!isValidPlan(planId)) {
      return res.status(400).json(ResponseUtil.error(`Unknown plan: ${planId}`, 400));
    }

    const plan = getPlan(planId);
    if (!plan.active) {
      return res.status(400).json(ResponseUtil.error(`Plan "${planId}" is not currently available`, 400));
    }

    LoggerUtil.info('Checkout session requested', {
      userId: req.user._id,
      requestedPlan: planId,
      currentPlan: req.user.subscription.plan,
      currentStatus: req.user.subscription.status,
    });

    // Defense-in-depth against a duplicate Stripe Subscription. The Choose
    // Plan page's own branching (Phase 3) never sends a user with a live
    // Stripe subscription here — 'active' subscribers are routed through
    // POST /subscription/change-plan instead, and 'past_due'/'paused'
    // subscribers are routed to the Billing Portal — but this endpoint must
    // not trust the frontend alone to enforce that. 'canceled' (and
    // 'inactive', which never has a stripeSubscriptionId) are deliberately
    // NOT blocked here: a canceled subscription has no live Stripe object
    // left to protect, so a fresh checkout is the correct, only path back
    // to a paid plan for that user — exactly like a never-subscribed user.
    const { status, stripeSubscriptionId } = req.user.subscription;
    if (stripeSubscriptionId && status !== 'canceled') {
      // Raw JSON (not ResponseUtil.error(), which has no top-level `code`
      // field) — apiService.js's handleResponse() reads `data.code` at the
      // top level to let the frontend branch on a specific error, same
      // convention already used for e.g. DUPLICATE_KEYWORD.
      return res.status(409).json({
        success: false,
        code: 'ALREADY_SUBSCRIBED',
        message: status === 'active'
          ? 'You already have an active subscription. Use Change Plan to switch tiers instead of starting a new checkout.'
          : 'Your existing subscription needs attention before you can start a new one. Resolve it via the Billing Portal first.',
      });
    }

    let priceId;
    try {
      priceId = getStripePriceId(planId);
    } catch (configError) {
      LoggerUtil.error('Stripe not configured for requested plan', configError, { planId });
      return res.status(503).json(ResponseUtil.error('Checkout is not available right now. Please try again later.', 503));
    }

    const frontendUrl = getServiceUrls().frontend;
    const successUrl = `${frontendUrl}/settings/subscription?success=true`;
    const cancelUrl = `${frontendUrl}/settings/subscription?cancelled=true`;

    const session = await createStripeCheckoutSession({
      priceId,
      userId: req.user._id,
      planId,
      successUrl,
      cancelUrl,
      customerEmail: req.user.email,
    });

    return res.status(200).json(ResponseUtil.success({ checkoutUrl: session.url }, 'Checkout session created'));
  } catch (error) {
    LoggerUtil.error('Error creating checkout session', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to create checkout session', 500));
  }
};

/**
 * POST /subscription/portal (auth required)
 *
 * Creates a Stripe Billing Portal session and returns only its URL. No
 * user/quota mutation happens here — the Portal itself is where a user
 * updates payment methods/cancels/etc, and any resulting change flows back
 * through the existing webhook handlers exactly as it already does for
 * every other Stripe-initiated change (no new sync path is introduced).
 *
 * Validation order matches the approved audit exactly: authenticated user
 * (handled by the `auth` middleware before this ever runs) -> subscription
 * sub-document exists -> hasBillingAccount (derived from stripeCustomerId)
 * -> Stripe configured -> create session.
 */
export const createBillingPortalSession = async (req, res) => {
  try {
    const subscription = req.user.subscription;
    if (!subscription) {
      return res.status(404).json(ResponseUtil.error('No billing account found for this user', 404));
    }

    const hasBillingAccount = Boolean(subscription.stripeCustomerId);
    if (!hasBillingAccount) {
      return res.status(404).json(ResponseUtil.error('No Stripe customer found. Subscribe to a plan first.', 404));
    }

    const frontendUrl = getServiceUrls().frontend;
    const returnUrl = `${frontendUrl}/settings/subscription`;

    let portalUrl;
    try {
      const result = await createStripeBillingPortalSession({
        stripeCustomerId: subscription.stripeCustomerId,
        returnUrl,
      });
      portalUrl = result.portalUrl;
    } catch (stripeError) {
      // Covers both "Stripe not configured" (getStripeClient() throwing on a
      // missing STRIPE_SECRET_KEY) and a genuine Stripe API failure
      // (network, deleted customer, no default Billing Portal configuration
      // saved in the Stripe Dashboard) — both are 503s per the approved
      // error mapping, since neither is something the client did wrong.
      LoggerUtil.error('Failed to create Stripe Billing Portal session', stripeError, { userId: req.user._id });
      return res.status(503).json(ResponseUtil.error('Billing management is not available right now. Please try again later.', 503));
    }

    return res.status(200).json(ResponseUtil.success({ portalUrl }, 'Billing portal session created'));
  } catch (error) {
    LoggerUtil.error('Error creating billing portal session', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to create billing portal session', 500));
  }
};

/**
 * POST /subscription/change-plan (auth required)
 * Body: { plan: "starter" }
 *
 * Requests a plan change on the user's EXISTING Stripe subscription — the
 * upgrade/downgrade counterpart to POST /subscription/checkout (which only
 * ever creates a brand-new subscription). Deliberately mirrors checkout's
 * own structure: this endpoint only ever calls Stripe and returns a status;
 * it never writes `subscription.plan` or reallocates quota itself. Stripe
 * remains the single source of truth — the resulting
 * customer.subscription.updated webhook event is what actually syncs the
 * plan, reallocates quota (preserving usage), and records the timeline
 * entry. See handleSubscriptionUpdated() in subscriptionWebhookService.js.
 *
 * Validation order: plan present/known/active -> not a same-plan no-op ->
 * subscription.status allows a change (canChangePlan) -> a Stripe
 * subscription actually exists to modify -> Stripe is configured for the
 * target plan -> call Stripe.
 */
export const changePlan = async (req, res) => {
  try {
    const { plan: planId } = req.body;

    if (!planId || typeof planId !== 'string') {
      return res.status(400).json(ResponseUtil.error('plan is required', 400));
    }

    if (!isValidPlan(planId)) {
      return res.status(400).json(ResponseUtil.error(`Unknown plan: ${planId}`, 400));
    }

    const plan = getPlan(planId);
    if (!plan.active) {
      return res.status(400).json(ResponseUtil.error(`Plan "${planId}" is not currently available`, 400));
    }

    const subscription = req.user.subscription;

    // Same-plan requests are not an error — the user is already where they
    // asked to go. No Stripe call, no state change, just a clear message.
    if (subscription.plan === planId) {
      return res.status(200).json(ResponseUtil.success(
        { changed: false, plan: planId },
        `You are already on the ${plan.name} plan`
      ));
    }

    if (!canChangePlan(subscription.status)) {
      return res.status(409).json(ResponseUtil.error(
        `Cannot change plans while your subscription status is "${subscription.status}". Resolve that first via Billing Portal.`,
        409
      ));
    }

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json(ResponseUtil.error('No active subscription found. Subscribe to a plan first.', 404));
    }

    let newPriceId;
    try {
      newPriceId = getStripePriceId(planId);
    } catch (configError) {
      LoggerUtil.error('Stripe not configured for requested plan', configError, { planId });
      return res.status(503).json(ResponseUtil.error('Plan changes are not available right now. Please try again later.', 503));
    }

    try {
      await updateSubscriptionPrice({
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        newPriceId,
      });
    } catch (stripeError) {
      LoggerUtil.error('Failed to update Stripe subscription price', stripeError, {
        userId: req.user._id,
        fromPlan: subscription.plan,
        toPlan: planId,
      });
      return res.status(503).json(ResponseUtil.error('Failed to change plan right now. Please try again later.', 503));
    }

    LoggerUtil.info('Plan change requested', { userId: req.user._id, fromPlan: subscription.plan, toPlan: planId });

    return res.status(200).json(ResponseUtil.success(
      { changed: true, plan: planId },
      'Plan change requested. Your account will update once Stripe confirms the change.'
    ));
  } catch (error) {
    LoggerUtil.error('Error changing plan', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to change plan', 500));
  }
};

/**
 * POST /subscription/webhook (no auth — verified by Stripe signature instead)
 *
 * Deliberately thin, per this phase's architecture requirement: verify the
 * signature, hand the trusted event to subscriptionWebhookService, return a
 * response. All business logic (idempotency, event handling, quota
 * allocation) lives in that service, not here.
 *
 * req.body MUST be the raw, unparsed request buffer for signature
 * verification to work — this route is registered in server.js with its
 * own express.raw() middleware, before the global express.json()
 * middleware, specifically so it never gets JSON-parsed first.
 */
export const handleStripeWebhook = async (req, res) => {
  let event;
  try {
    event = verifyWebhookSignature(req.body, req.headers['stripe-signature']);
  } catch (signatureError) {
    LoggerUtil.warn('Stripe webhook signature verification failed', { error: signatureError.message });
    return res.status(400).send(`Webhook Error: ${signatureError.message}`);
  }

  try {
    const result = await processStripeEvent(event);
    return res.status(200).json({ received: true, ...result });
  } catch (processingError) {
    LoggerUtil.error('Error processing Stripe webhook', processingError, {
      eventId: event.id,
      eventType: event.type,
    });
    // 5xx (not 200) is intentional here — this is a genuine processing
    // failure, not a duplicate/ignored event, so Stripe should retry later.
    return res.status(500).json({ received: false, error: 'Webhook processing failed' });
  }
};

/**
 * Public shape for one billing-history row. Deliberately excludes every
 * Stripe id on the Transaction document (stripeEventId, stripeInvoiceId,
 * stripePaymentIntentId, stripeCheckoutSessionId, stripeSubscriptionId) —
 * none of them are needed to render a history row, and the backend stays
 * the only owner of Stripe identifiers, exactly as for GET /subscription.
 */
function serializeTransaction(transaction) {
  return {
    id: transaction._id,
    date: transaction.createdAt,
    amount: transaction.amount,
    currency: transaction.currency,
    type: transaction.type,
    status: transaction.status,
    invoiceUrl: transaction.hostedInvoiceUrl,
  };
}

/**
 * Public shape for one "Buy More Pages" billing-history row — the
 * PagePurchase counterpart to serializeTransaction() above, shaped
 * identically so the frontend can render both from one merged list
 * without a type check. `type: 'page_pack'` is a new, additive event-type
 * value; existing 'checkout'/'renewal'/etc. Transaction rows are
 * completely unaffected. `pagesPurchased` is the one extra field a
 * Transaction row never has — the frontend uses it only to render
 * "Purchased +N Pages" under the Event Type badge for this row type.
 * Deliberately excludes stripeSessionId/paymentIntentId, matching
 * serializeTransaction's own Stripe-id exclusion. `invoiceUrl` reads
 * `hostedInvoiceUrl` — `null` for any row created before Phase 18 added
 * invoice persistence, exactly like a Transaction row predating that
 * field; the frontend already renders `null` as "—".
 */
function serializePagePurchase(purchase) {
  return {
    id: purchase._id,
    date: purchase.createdAt,
    amount: purchase.pricePaid,
    currency: purchase.currency,
    type: 'page_pack',
    status: purchase.status,
    invoiceUrl: purchase.hostedInvoiceUrl || null,
    pagesPurchased: purchase.pagesPurchased,
  };
}

/**
 * Public shape for one "Buy Credits" billing-history row — the
 * CreditPurchase counterpart to serializePagePurchase() above, same
 * shape, same reasoning. `type: 'credit_pack'` is another new, additive
 * event-type value alongside 'page_pack'; `creditsPurchased` is the one
 * extra field this row type carries, used by the frontend to render
 * "Purchased +N Credits".
 */
function serializeCreditPurchase(purchase) {
  return {
    id: purchase._id,
    date: purchase.createdAt,
    amount: purchase.pricePaid,
    currency: purchase.currency,
    type: 'credit_pack',
    status: purchase.status,
    invoiceUrl: purchase.hostedInvoiceUrl || null,
    creditsPurchased: purchase.creditsPurchased,
  };
}

/**
 * GET /subscription/history (auth required)
 * Query: ?page=1&limit=20 (defaults; limit capped at 50)
 *
 * Returns the authenticated user's unified payment timeline — subscription
 * Transactions (checkout/renewal/etc, unchanged) merged with one-time
 * PagePurchase rows ("Buy More Pages", Phase 16) and CreditPurchase rows
 * ("Buy Credits", Phase 17) — newest first. None of the three source
 * collections is modified or duplicated; the merge happens only here, at
 * serialization time, by combining all three already-existing queries and
 * re-sorting. Only 'pending' rows are excluded from the purchase sources
 * (an unconfirmed/abandoned checkout attempt — no Transaction row is ever
 * created before a webhook settles it either, so this keeps every source
 * to the same "only ever shows settled events" invariant).
 *
 * Pagination is applied AFTER merging all sources (not per-collection),
 * since "page 1" must reflect the true newest-N across all of them
 * together. Each source query is soft-capped at 500 rows as a defensive
 * bound — real per-user billing history is realistically a few dozen rows
 * at most, so this only guards against a pathological edge case, never
 * real pagination of typical accounts.
 */
export const getBillingHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [transactions, pagePurchases, creditPurchases] = await Promise.all([
      Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(500).lean(),
      PagePurchase.find({ userId: req.user._id, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(500).lean(),
      CreditPurchase.find({ userId: req.user._id, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(500).lean(),
    ]);

    const merged = [
      ...transactions.map(serializeTransaction),
      ...creditPurchases.map(serializeCreditPurchase),
      ...pagePurchases.map(serializePagePurchase),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const total = merged.length;
    const pageItems = merged.slice(skip, skip + limit);

    return res.status(200).json(ResponseUtil.success({
      transactions: pageItems,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + pageItems.length < total,
      },
    }, 'Billing history retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting billing history', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to get billing history', 500));
  }
};

// GET /subscription/invoices — deliberately NOT implemented as a separate
// endpoint. Every field a dedicated "invoices" list would need (invoice
// id's hosted URL, amount, currency, status, date) is already present on
// every history-returning Transaction via `invoiceUrl` — a second endpoint
// would either (a) re-run the identical query filtered to
// `invoiceUrl: {$ne: null}`, duplicating the exact fetch this file already
// does once (violating "no duplicated fetching logic"), or (b) require a
// live Stripe Invoices API call for data not already captured by the
// webhook handlers, which is explicitly out of scope ("do not fabricate
// invoice data" — only reuse what webhooks already gave us). If a
// dedicated invoices view is ever needed, the correct implementation is a
// client-side filter over GET /subscription/history's existing response,
// not a new route.

/**
 * Public shape for one CustomPlanRequest — deliberately excludes
 * `adminNotes` (internal-only, Phase 5's admin panel concern) and `userId`
 * (the caller already knows whose request this is). `status` IS included —
 * it's exactly what the Custom card's CTA (Request Pending / View Request /
 * request again) branches on client-side.
 */
function serializeCustomPlanRequest(request) {
  return {
    id: request._id,
    companyName: request.companyName,
    companyWebsite: request.companyWebsite,
    contactName: request.contactName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    teamSize: request.teamSize,
    projectCount: request.projectCount,
    requiredCredits: request.requiredCredits,
    requiredPages: request.requiredPages,
    featureRequirements: request.featureRequirements,
    budgetRange: request.budgetRange,
    timeline: request.timeline,
    additionalRequirements: request.additionalRequirements,
    status: request.status,
    createdAt: request.createdAt,
  };
}

/**
 * POST /subscription/custom-request (auth required)
 *
 * Creates a Custom Plan lead. Never touches Stripe, User.subscription, or
 * credits/pages — this is purely a sales request captured for a human
 * follow-up (see customPlanRequestService.js). Rejects with 409 if the user
 * already has a pending/contacted request open (service-layer check).
 */
export const createCustomPlanRequest = async (req, res) => {
  try {
    let validated;
    try {
      validated = validateCustomPlanRequestInput(req.body);
    } catch (validationError) {
      return res.status(400).json({ success: false, code: validationError.code, message: validationError.message });
    }

    let request;
    try {
      request = await submitCustomPlanRequest(req.user._id, validated, { firstName: req.user.firstName });
    } catch (submitError) {
      if (submitError.code === 'DUPLICATE_OPEN_REQUEST') {
        return res.status(409).json({ success: false, code: submitError.code, message: submitError.message });
      }
      throw submitError;
    }

    return res.status(201).json(ResponseUtil.success(
      serializeCustomPlanRequest(request),
      'Custom plan request submitted successfully'
    ));
  } catch (error) {
    LoggerUtil.error('Error creating custom plan request', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to submit your request. Please try again.', 500));
  }
};

/**
 * GET /subscription/custom-request/me (auth required)
 *
 * Returns the authenticated user's most recent Custom Plan request, or
 * `null` if they've never submitted one. This is the ONLY read path the
 * Custom card needs — no separate "has a request" boolean endpoint, since
 * the status field alone tells the frontend everything it needs to decide
 * which CTA to show (see STEP 8's Request Custom Plan / Request Pending /
 * View Request / request-again branching).
 */
export const getMyCustomPlanRequest = async (req, res) => {
  try {
    const request = await getLatestCustomPlanRequest(req.user._id);
    return res.status(200).json(ResponseUtil.success(
      request ? serializeCustomPlanRequest(request) : null,
      'Custom plan request retrieved successfully'
    ));
  } catch (error) {
    LoggerUtil.error('Error getting custom plan request', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to get your request', 500));
  }
};
