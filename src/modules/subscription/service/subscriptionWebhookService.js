import User from '../../user/model/User.js';
import WebhookEvent from '../model/WebhookEvent.js';
import Transaction from '../model/Transaction.js';
import { getPlan, getPlanLimits, isValidPlan, getPlanIdByStripePriceId } from '../../../config/plans.js';
import { allocateQuotaFromPlan, reallocateQuotaForPlanChange } from '../../../utils/creditService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { getEnvVar } from '../../../config/env.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { handlePagePurchaseCompleted } from '../../page_purchase/service/pagePurchaseWebhookService.js';
import { handleCreditPurchaseCompleted } from '../../credit_purchase/service/creditPurchaseWebhookService.js';
import { fetchInvoiceUrls } from '../../../services/stripeService.js';

// Same idiom already used for the frontend base URL elsewhere in this
// codebase (homepageAuditPuppeteerService.js, puppeteerPdfService.js,
// oauth.routes.js) — CORS_ORIGIN is the app's only configured frontend URL,
// and it's a hard-required env var (validateEnvironment()), so reading it
// at module load time is safe.
const FRONTEND_URL = getEnvVar('CORS_ORIGIN');
const MANAGE_SUBSCRIPTION_URL = `${FRONTEND_URL}/settings/subscription`;

/**
 * All Stripe webhook business logic lives here. The controller only
 * verifies the signature and calls processStripeEvent() — nothing here
 * ever touches req/res.
 */

const SUPPORTED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

// Stripe's real subscription-status vocabulary, mapped onto the narrower
// set User.subscription.status actually models. 'trialing' reads as full
// access (active); 'unpaid'/'past_due' both mean "payment problem, not yet
// canceled" (past_due); 'incomplete'/'incomplete_expired' mean the very
// first payment never went through, so there is nothing to treat as active
// (canceled is the closest existing meaning — never subscribe successfully).
const STRIPE_STATUS_MAP = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'canceled',
  incomplete_expired: 'canceled',
  paused: 'paused',
};

/**
 * @param {string} stripeStatus
 * @returns {string|null} the mapped status, or null if unrecognized (the
 *   caller should then leave the existing status untouched rather than
 *   guess).
 */
function mapStripeStatus(stripeStatus) {
  return STRIPE_STATUS_MAP[stripeStatus] ?? null;
}

/**
 * Records one billing-history row. Deliberately isolated from the calling
 * handler's error flow: a failure to write a Transaction (e.g. the
 * `stripeEventId` unique-index safety net firing on a genuine duplicate
 * call) is logged and swallowed, never thrown. Billing-history bookkeeping
 * must never fail, retry, or duplicate the core subscription-state change
 * it's recording — those two concerns stay fully independent. If this
 * threw, a bookkeeping failure could mark the whole webhook event 'failed'
 * in WebhookEvent, which (by design, since Phase 11) allows a future retry
 * to reprocess the entire handler — safe for the idempotent quota/status
 * writes, but not a risk worth taking for a non-critical audit row.
 * @param {Object} fields - Transaction schema fields (minus timestamps)
 */
async function recordTransaction(fields) {
  try {
    await Transaction.create(fields);
  } catch (transactionError) {
    LoggerUtil.error('Failed to record billing transaction (core subscription state was still updated)', transactionError, {
      stripeEventId: fields.stripeEventId,
      type: fields.type,
    });
  }
}

/**
 * Entry point called by the webhook controller with an already
 * signature-verified Stripe event. Handles idempotency (via WebhookEvent's
 * unique index on stripeEventId) before doing anything else, then
 * dispatches to the appropriate handler for supported event types.
 *
 * @param {import('stripe').Stripe.Event} event
 * @returns {Promise<{duplicate?:boolean, ignored?:boolean, processed?:boolean}>}
 */
export async function processStripeEvent(event) {
  // Atomic claim, retry-aware. Two cases can legitimately proceed:
  //  1. This event id has never been seen before -> the upsert inserts it.
  //  2. This event id previously failed processing -> Stripe's own retry
  //     mechanism (or a redelivery) should get a genuine second attempt,
  //     not be silently swallowed as "already handled."
  // Anything else (an existing 'completed'/'ignored' entry, or one another
  // concurrent request is actively working on right now, 'processing')
  // does NOT match the filter below, so the upsert instead collides with
  // the unique index on stripeEventId and throws 11000 — treated as a
  // duplicate, zero business logic. This is the entire idempotency
  // mechanism; there is no other guard anywhere else.
  let logEntry;
  try {
    logEntry = await WebhookEvent.findOneAndUpdate(
      { stripeEventId: event.id, status: 'failed' },
      {
        $set: { status: 'processing', processingError: null },
        $setOnInsert: {
          stripeEventId: event.id,
          eventType: event.type,
          metadata: { livemode: event.livemode },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (claimError) {
    if (claimError.code === 11000) {
      LoggerUtil.info('Duplicate Stripe webhook event ignored', { eventId: event.id, eventType: event.type });
      return { duplicate: true };
    }
    throw claimError;
  }

  if (!SUPPORTED_EVENTS.has(event.type)) {
    await WebhookEvent.findByIdAndUpdate(logEntry._id, { status: 'ignored', processedAt: new Date() });
    LoggerUtil.info('Unsupported Stripe event type ignored', { eventId: event.id, eventType: event.type });
    return { ignored: true };
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        // Stripe has exactly one webhook URL for this app, so plan
        // subscriptions AND every one-time purchase kind (page-pack,
        // credit-pack) all land here as the same event type. Branch on
        // metadata.purchaseType (stamped by
        // stripeService.createOneTimePaymentSession) before the plan
        // subscription's own handleCheckoutCompleted, which unconditionally
        // expects a planId and would throw for a one-time-purchase session.
        // All purchase-specific business logic lives in its own module
        // (page_purchase / credit_purchase) — this is only a dispatch
        // decision.
        if (event.data.object.metadata?.purchaseType === 'page_pack') {
          await handlePagePurchaseCompleted(event.data.object, event.id);
        } else if (event.data.object.metadata?.purchaseType === 'credit_pack') {
          await handleCreditPurchaseCompleted(event.data.object, event.id);
        } else {
          await handleCheckoutCompleted(event.data.object, event.id);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object, event.id);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object, event.id);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object, event.id);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object, event.id);
        break;
    }

    await WebhookEvent.findByIdAndUpdate(logEntry._id, { status: 'completed', processedAt: new Date() });
    return { processed: true };
  } catch (processingError) {
    await WebhookEvent.findByIdAndUpdate(logEntry._id, {
      status: 'failed',
      processedAt: new Date(),
      processingError: processingError.message,
    });
    // Re-thrown so the controller returns 5xx and Stripe retries later —
    // appropriate for a genuine processing failure (e.g. a transient DB
    // error), as opposed to the duplicate/ignored paths above, which
    // always return success.
    throw processingError;
  }
}

/**
 * checkout.session.completed — the initial activation event. Reads
 * userId/planId from session metadata (set in stripeService.createCheckoutSession),
 * validates both, then sets the plan/status and allocates fresh quotas from
 * config/plans.js. This is one of exactly two places quotas are ever set to
 * plan defaults (the other is invoice.paid, for renewals) — everywhere
 * else, quota changes are relative ($inc) via creditService.js.
 */
async function handleCheckoutCompleted(session, eventId) {
  const { userId, planId } = session.metadata || {};

  if (!userId || !planId) {
    throw new Error(`checkout.session.completed: missing metadata (userId=${userId}, planId=${planId})`);
  }
  if (!isValidPlan(planId)) {
    throw new Error(`checkout.session.completed: unknown plan "${planId}"`);
  }

  const plan = getPlan(planId);
  if (!plan.active) {
    throw new Error(`checkout.session.completed: plan "${planId}" is not active`);
  }

  const planFieldsUpdate = { 'subscription.plan': planId, 'subscription.status': 'active' };
  if (session.customer) planFieldsUpdate['subscription.stripeCustomerId'] = session.customer;
  if (session.subscription) planFieldsUpdate['subscription.stripeSubscriptionId'] = session.subscription;

  const updated = await User.findByIdAndUpdate(userId, { $set: planFieldsUpdate }, { new: false });
  if (!updated) {
    throw new Error(`checkout.session.completed: user "${userId}" not found`);
  }

  // Quota allocation goes through the shared quota-service function — the
  // same one invoice.paid uses for renewals — so "what does allocating a
  // plan's quota mean" is defined in exactly one place.
  await allocateQuotaFromPlan(userId, getPlanLimits(planId));

  const paymentSucceeded = session.payment_status !== 'unpaid';

  // session.invoice is only ever an ID — the hosted URL/PDF link require a
  // separate fetch. Stripe reliably has the invoice finalized by the time
  // checkout.session.completed fires (confirmed directly against a real
  // subscription invoice), so this doesn't need to wait for a later
  // invoice.* event.
  const { hostedInvoiceUrl, invoicePdfUrl } = await fetchInvoiceUrls(session.invoice);

  await recordTransaction({
    user: userId,
    stripeSubscriptionId: session.subscription || null,
    stripeEventId: eventId,
    stripeInvoiceId: session.invoice || null,
    stripePaymentIntentId: session.payment_intent || null,
    stripeCheckoutSessionId: session.id || null,
    hostedInvoiceUrl,
    invoicePdfUrl,
    amount: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || null,
    status: paymentSucceeded ? 'succeeded' : 'failed',
    type: 'checkout',
  });

  LoggerUtil.info('Subscription activated via checkout.session.completed', { userId, planId });

  // Only a real activation gets the welcome email — a checkout session
  // that completed with payment_status 'unpaid' has no working
  // subscription yet, so "you're all set" would be actively misleading.
  if (paymentSucceeded) {
    await sendMail(MAIL_TYPES.SUBSCRIPTION_ACTIVATED, updated.email, {
      firstName: updated.firstName,
      planName: plan.name,
      credits: plan.credits,
      pages: plan.pages,
      manageUrl: MANAGE_SUBSCRIPTION_URL,
    });
  }
}

/**
 * customer.subscription.created / customer.subscription.updated — syncs
 * subscription status and Stripe correlation IDs, AND (Phase 15) detects a
 * plan change by resolving the subscription's current Stripe Price ID back
 * to an Odito plan id. This is the ONLY place `subscription.plan` is ever
 * changed outside the initial checkout.session.completed activation — the
 * Change Plan API (subscriptionController.js's changePlan) never writes it
 * directly, it only asks Stripe to change the subscription's price; this
 * handler is what makes that change real locally once Stripe confirms it.
 * Quota is reallocated via reallocateQuotaForPlanChange(), which preserves
 * `used` — a plan change must never erase usage already consumed this
 * period (see that function's own doc comment in creditService.js).
 */
async function handleSubscriptionUpdated(subscription, eventId) {
  const userId = subscription.metadata?.userId || null;
  const query = userId ? { _id: userId } : { 'subscription.stripeSubscriptionId': subscription.id };

  const mappedStatus = mapStripeStatus(subscription.status);

  if (!mappedStatus) {
    LoggerUtil.warn('customer.subscription event: unrecognized Stripe status, leaving subscription.status unchanged', {
      subscriptionId: subscription.id,
      stripeStatus: subscription.status,
    });
  }

  // Read prior status AND plan before overwriting either — the only way to
  // tell a genuine "paused/past_due -> active" resume apart from a
  // brand-new subscription's first sync, and the only way to tell a real
  // plan change apart from a status-only update (e.g. payment retried).
  const before = await User.findOne(query).select('subscription.status subscription.plan').lean();

  // A price on the subscription that doesn't resolve to any configured
  // active plan (e.g. STRIPE_STARTER_PRICE_ID not set, or a subscription
  // created outside this app's checkout) is left alone entirely — never
  // guessed at, never falls back to a default plan.
  const currentPriceId = subscription.items?.data?.[0]?.price?.id || null;
  const resolvedPlanId = currentPriceId ? getPlanIdByStripePriceId(currentPriceId) : null;
  const isPlanChange = Boolean(
    resolvedPlanId && before?.subscription?.plan && resolvedPlanId !== before.subscription.plan
  );

  const update = {
    $set: {
      'subscription.stripeSubscriptionId': subscription.id,
      ...(subscription.customer && { 'subscription.stripeCustomerId': subscription.customer }),
      ...(mappedStatus && { 'subscription.status': mappedStatus }),
      ...(isPlanChange && { 'subscription.plan': resolvedPlanId }),
    },
  };

  const updated = await User.findOneAndUpdate(query, update, { new: true });
  if (!updated) {
    LoggerUtil.warn('customer.subscription event: no matching user found', { subscriptionId: subscription.id, userId });
    return;
  }

  if (isPlanChange) {
    await reallocateQuotaForPlanChange(updated._id, getPlanLimits(resolvedPlanId));

    const oldPlan = getPlan(before.subscription.plan);
    const newPlan = getPlan(resolvedPlanId);
    const direction = newPlan.price > oldPlan.price ? 'upgraded' : 'downgraded';

    LoggerUtil.info('Plan changed via customer.subscription.updated', {
      userId: updated._id, fromPlan: oldPlan.id, toPlan: newPlan.id, direction,
    });

    // Non-monetary timeline entry — amount/currency stay null. Any actual
    // prorated charge Stripe generates arrives on its own invoice.paid
    // event and is recorded there as a 'renewal' Transaction, exactly like
    // every other invoice.
    await recordTransaction({
      user: updated._id,
      stripeSubscriptionId: subscription.id || null,
      stripeEventId: eventId,
      status: 'succeeded',
      type: direction,
    });
  }

  const wasInterrupted = ['canceled', 'past_due', 'paused'].includes(before?.subscription?.status);
  if (wasInterrupted && mappedStatus === 'active') {
    LoggerUtil.info('Subscription resumed via customer.subscription.updated', { userId: updated._id, previousStatus: before.subscription.status });

    // 'resumed' has been a reserved Transaction.type value since Phase 13
    // but was never written until now — this is the only place it fires.
    // NOTE: if a plan change and a resume land in the SAME Stripe event
    // (rare — both a status and a price changing at once), the plan-change
    // Transaction above already claimed this eventId as its unique
    // stripeEventId; this call will then fail the uniqueness check and be
    // logged/swallowed by recordTransaction() rather than throwing. The
    // resume email below still sends regardless — only the second
    // Transaction row is skipped in that narrow compound case.
    await recordTransaction({
      user: updated._id,
      stripeSubscriptionId: subscription.id || null,
      stripeEventId: eventId,
      status: 'succeeded',
      type: 'resumed',
    });

    const plan = isValidPlan(updated.subscription.plan) ? getPlan(updated.subscription.plan) : null;
    await sendMail(MAIL_TYPES.SUBSCRIPTION_RESUMED, updated.email, {
      firstName: updated.firstName,
      planName: plan?.name || updated.subscription.plan,
      manageUrl: MANAGE_SUBSCRIPTION_URL,
    });
  }
}

/**
 * customer.subscription.deleted — status only. Never deletes the user,
 * their projects, or any history — confirmed by this function touching
 * nothing but `subscription.status`.
 */
async function handleSubscriptionDeleted(subscription, eventId) {
  const userId = subscription.metadata?.userId || null;
  const query = userId ? { _id: userId } : { 'subscription.stripeSubscriptionId': subscription.id };

  const updated = await User.findOneAndUpdate(query, {
    $set: { 'subscription.status': 'canceled' },
  }, { new: true });

  if (!updated) {
    LoggerUtil.warn('customer.subscription.deleted: no matching user found', { subscriptionId: subscription.id, userId });
    return;
  }

  LoggerUtil.info('Subscription canceled via customer.subscription.deleted', { userId: updated._id });

  // Not a monetary event — amount/currency stay null. Still a meaningful
  // billing-history row ("your subscription was canceled").
  await recordTransaction({
    user: updated._id,
    stripeSubscriptionId: subscription.id || null,
    stripeEventId: eventId,
    status: 'canceled',
    type: 'cancelled',
  });

  const plan = isValidPlan(updated.subscription.plan) ? getPlan(updated.subscription.plan) : null;
  await sendMail(MAIL_TYPES.SUBSCRIPTION_CANCELLED, updated.email, {
    firstName: updated.firstName,
    planName: plan?.name || updated.subscription.plan,
    manageUrl: MANAGE_SUBSCRIPTION_URL,
  });
}

/**
 * invoice.paid — the ONLY place a monthly quota renewal happens. Reloads
 * the user's current plan from config/plans.js (never cached/hardcoded)
 * and resets both credits and pages to that plan's defaults.
 */
async function handleInvoicePaid(invoice, eventId) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) {
    // Not a subscription invoice (e.g. a one-off) — nothing for this
    // phase's subscription-renewal logic to do.
    LoggerUtil.info('invoice.paid: no subscription id on invoice, skipping', { invoiceId: invoice.id });
    return;
  }

  const user = await User.findOne({ 'subscription.stripeSubscriptionId': subscriptionId }).select('subscription firstName email').lean();
  if (!user) {
    throw new Error(`invoice.paid: no user found for subscription "${subscriptionId}"`);
  }

  const planId = user.subscription.plan;
  if (!isValidPlan(planId)) {
    throw new Error(`invoice.paid: user "${user._id}" has unknown plan "${planId}"`);
  }

  // "Reload plan definition" — getPlanLimits() reads config/plans.js fresh
  // on every call; nothing is cached from a prior event or an earlier point
  // in this handler.
  await User.findByIdAndUpdate(user._id, { $set: { 'subscription.status': 'active' } });
  await allocateQuotaFromPlan(user._id, getPlanLimits(planId));

  await recordTransaction({
    user: user._id,
    stripeSubscriptionId: subscriptionId,
    stripeEventId: eventId,
    stripeInvoiceId: invoice.id || null,
    stripePaymentIntentId: invoice.payment_intent || null,
    hostedInvoiceUrl: invoice.hosted_invoice_url || null,
    invoicePdfUrl: invoice.invoice_pdf || null,
    amount: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : null,
    currency: invoice.currency || null,
    status: 'succeeded',
    type: 'renewal',
  });

  LoggerUtil.info('Quota renewed via invoice.paid', { userId: user._id, planId });

  // checkout.session.completed already sends the "Activated" welcome email
  // for a brand-new subscription's first payment — invoice.paid still
  // fires for that same first payment (both events are expected per Phase
  // 13's already-documented dual-transaction behavior), so it gets its own
  // "Payment Successful" receipt rather than a second activation email.
  // Stripe's own billing_reason is the correct way to tell "first payment"
  // apart from "renewal" — not a local heuristic.
  const plan = getPlan(planId);
  const emailType = invoice.billing_reason === 'subscription_create' ? MAIL_TYPES.PAYMENT_SUCCESS : MAIL_TYPES.SUBSCRIPTION_RENEWED;
  await sendMail(emailType, user.email, {
    firstName: user.firstName,
    planName: plan.name,
    amount: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : null,
    currency: invoice.currency || null,
    date: new Date(),
    credits: plan.credits,
    pages: plan.pages,
    invoiceUrl: invoice.hosted_invoice_url || null,
    manageUrl: MANAGE_SUBSCRIPTION_URL,
  });
}

/**
 * invoice.payment_failed — status only. Never removes quota, never deletes
 * data — confirmed by this function touching nothing but
 * `subscription.status`.
 */
async function handleInvoicePaymentFailed(invoice, eventId) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) {
    LoggerUtil.info('invoice.payment_failed: no subscription id on invoice, skipping', { invoiceId: invoice.id });
    return;
  }

  const updated = await User.findOneAndUpdate(
    { 'subscription.stripeSubscriptionId': subscriptionId },
    { $set: { 'subscription.status': 'past_due' } },
    { new: true }
  );

  if (!updated) {
    LoggerUtil.warn('invoice.payment_failed: no matching user found', { subscriptionId });
    return;
  }

  LoggerUtil.info('Subscription marked past_due via invoice.payment_failed', { userId: updated._id });

  await recordTransaction({
    user: updated._id,
    stripeSubscriptionId: subscriptionId,
    stripeEventId: eventId,
    stripeInvoiceId: invoice.id || null,
    stripePaymentIntentId: invoice.payment_intent || null,
    hostedInvoiceUrl: invoice.hosted_invoice_url || null,
    invoicePdfUrl: invoice.invoice_pdf || null,
    amount: typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
    currency: invoice.currency || null,
    status: 'failed',
    type: 'payment_failed',
  });

  const plan = isValidPlan(updated.subscription.plan) ? getPlan(updated.subscription.plan) : null;
  await sendMail(MAIL_TYPES.PAYMENT_FAILED, updated.email, {
    firstName: updated.firstName,
    planName: plan?.name || updated.subscription.plan,
    amount: typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
    currency: invoice.currency || null,
    manageUrl: MANAGE_SUBSCRIPTION_URL,
  });
}
