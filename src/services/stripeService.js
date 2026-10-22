import Stripe from 'stripe';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Centralized Stripe integration. This is the ONLY file in the backend
 * that instantiates the Stripe SDK or reads STRIPE_SECRET_KEY — every
 * controller that needs Stripe goes through the functions exported here.
 *
 * The client is a lazy singleton: importing this module (which happens at
 * server boot, transitively, via the route graph) never requires
 * STRIPE_SECRET_KEY to be set. The clear failure only happens the moment
 * something actually tries to use Stripe (getStripeClient()/
 * createCheckoutSession()) without it configured — matching this
 * codebase's existing convention for feature-specific API keys (see
 * services/googlePlacesService.js) rather than crashing the entire server
 * at boot for a feature most of the app doesn't depend on yet.
 */

let stripeClient = null;

/**
 * @returns {Stripe} the shared Stripe client
 * @throws if STRIPE_SECRET_KEY is not configured
 */
export function getStripeClient() {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required to use Stripe.');
    }
    stripeClient = new Stripe(secretKey, {
      apiVersion: '2024-06-20',
    });
  }
  return stripeClient;
}

/**
 * Creates a Stripe Checkout Session in subscription mode. Pure passthrough
 * to the Stripe API — no database read/write happens here or in any
 * caller of this function in this phase.
 * @param {Object} params
 * @param {string} params.priceId - Stripe Price ID (never a raw amount)
 * @param {string} params.userId - Odito user id, attached as session metadata
 * @param {string} params.planId - Odito plan id, attached as session metadata
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @param {string} [params.customerEmail] - prefills the Checkout email field
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 */
export async function createCheckoutSession({ priceId, userId, planId, successUrl, cancelUrl, customerEmail }) {
  const stripe = getStripeClient();

  const metadata = {
    userId: String(userId),
    planId: String(planId),
  };

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail,
    // Session-level metadata — read directly by checkout.session.completed.
    metadata,
    // Also stamped onto the underlying Stripe Subscription object itself,
    // so every subsequent customer.subscription.* and invoice.* event for
    // this subscription carries userId/planId directly, without depending
    // on checkout.session.completed having already run and stored
    // stripeSubscriptionId first (defense-in-depth against event ordering).
    subscription_data: {
      metadata,
    },
  });
}

/**
 * Creates a Stripe Checkout Session in one-time PAYMENT mode (never
 * 'subscription') — used for one-off product purchases such as "Buy More
 * Pages" that must never create or touch a recurring Stripe Subscription.
 * The price is built inline via `price_data` (not a pre-created Stripe
 * Price ID) since the amount is computed per-request from a continuous
 * page count, not one of a fixed set of plan tiers.
 * @param {Object} params
 * @param {number} params.priceCents - amount to charge, in cents. The
 *   caller is solely responsible for computing this server-side; this
 *   function never trusts or accepts a price from client input.
 * @param {string} params.productName - shown on the Stripe Checkout page
 * @param {string} params.userId - Odito user id, attached as session metadata
 * @param {Object} [params.metadata] - additional metadata merged with userId
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @param {string} [params.customerEmail] - prefills the Checkout email field
 *   (used only when stripeCustomerId is not supplied)
 * @param {string} [params.stripeCustomerId] - reuse an existing Stripe
 *   Customer instead of creating a new one from customerEmail
 * @returns {Promise<import('stripe').Stripe.Checkout.Session>}
 */
export async function createOneTimePaymentSession({
  priceCents,
  productName,
  userId,
  metadata = {},
  successUrl,
  cancelUrl,
  customerEmail,
  stripeCustomerId,
}) {
  const stripe = getStripeClient();

  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: productName },
        unit_amount: priceCents,
      },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: customerEmail }),
    metadata: {
      userId: String(userId),
      ...metadata,
    },
    // Without this, Stripe generates NO Invoice at all for a one-time
    // 'payment' mode session (confirmed empirically — session.invoice is
    // null by default) — there would be nothing to ever link a "View
    // Invoice" row to. This is the standard, Stripe-hosted way to get a
    // real receipt/invoice for a one-time purchase; it does not change
    // what the customer is charged. Stripe auto-creates a Customer for the
    // invoice if one doesn't already exist, so this works whether or not
    // stripeCustomerId was passed above.
    invoice_creation: {
      enabled: true,
    },
  });
}

/**
 * Retrieves a Stripe Invoice by id — used by every webhook handler that
 * needs to persist `hosted_invoice_url`/`invoice_pdf` onto a billing-history
 * row once a checkout/payment completes (a session/invoice object only
 * carries the invoice ID, not the hosted URL, until fetched). Pure
 * passthrough, same convention as every other function in this file — the
 * ONE place this lookup is implemented, reused by the subscription,
 * page_purchase, and credit_purchase webhook handlers rather than each
 * calling stripe.invoices.retrieve() itself.
 * @param {string} invoiceId
 * @returns {Promise<import('stripe').Stripe.Invoice>}
 */
export async function retrieveInvoice(invoiceId) {
  const stripe = getStripeClient();
  return stripe.invoices.retrieve(invoiceId);
}

/**
 * Best-effort fetch of a Stripe Invoice's hosted URL/PDF link, given only
 * its id. The ONE shared implementation of this lookup — the subscription,
 * page_purchase, and credit_purchase webhook handlers all call this
 * instead of each wrapping retrieveInvoice() in their own try/catch.
 * Deliberately never throws: an invoice lookup failing (network blip,
 * invoice not yet finalized, etc.) must never block the core
 * activation/grant flow it's called from — it just means the resulting
 * billing-history row keeps `null` invoice fields, exactly like rows
 * created before this lookup existed.
 * @param {string|null|undefined} invoiceId
 * @returns {Promise<{hostedInvoiceUrl: string|null, invoicePdfUrl: string|null}>}
 */
export async function fetchInvoiceUrls(invoiceId) {
  if (!invoiceId) return { hostedInvoiceUrl: null, invoicePdfUrl: null };
  try {
    const invoice = await retrieveInvoice(invoiceId);
    return {
      hostedInvoiceUrl: invoice.hosted_invoice_url || null,
      invoicePdfUrl: invoice.invoice_pdf || null,
    };
  } catch (invoiceError) {
    LoggerUtil.warn('Failed to fetch Stripe invoice for billing history (core flow continues)', {
      invoiceId, error: invoiceError.message,
    });
    return { hostedInvoiceUrl: null, invoicePdfUrl: null };
  }
}

/**
 * Best-effort fetch of a live Stripe Subscription's renewal info, given
 * only its id. Deliberately never throws — same convention as
 * fetchInvoiceUrls() above. Nothing in this codebase stores a renewal/
 * current-period-end date locally (see User.subscription), so the System
 * Admin subscription detail page is the only caller of this; it is NOT
 * called from a list/table context (that would mean one live Stripe call
 * per row on every page load — an N+1 pattern this function deliberately
 * is not used for).
 * @param {string|null|undefined} stripeSubscriptionId
 * @returns {Promise<{renewsAt: string|null, cancelAtPeriodEnd: boolean, stripeStatus: string|null}|null>}
 */
export async function fetchSubscriptionRenewalInfo(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  try {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    return {
      renewsAt: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      stripeStatus: subscription.status || null,
    };
  } catch (subscriptionError) {
    LoggerUtil.warn('Failed to fetch Stripe subscription renewal info (admin display only)', {
      stripeSubscriptionId, error: subscriptionError.message,
    });
    return null;
  }
}

/**
 * Verifies a webhook payload's Stripe-Signature header against
 * STRIPE_WEBHOOK_SECRET and returns the parsed, trusted event. This is the
 * ONLY function in the codebase that should ever call
 * stripe.webhooks.constructEvent — never trust a webhook payload without
 * going through this first.
 * @param {Buffer|string} rawBody - the exact, unparsed request body
 * @param {string} signature - the Stripe-Signature request header
 * @returns {import('stripe').Stripe.Event}
 * @throws if STRIPE_WEBHOOK_SECRET is not configured, or the signature is invalid
 */
export function verifyWebhookSignature(rawBody, signature) {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required to verify webhooks.');
  }
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Changes an existing Stripe subscription to a different Price — the
 * mechanism behind Phase 15's Change Plan API. Pure passthrough to the
 * Stripe API, same convention as every other function in this file: no
 * database read/write happens here or in any caller. The caller is
 * responsible for validating the new plan is valid/active/different before
 * calling this — this function trusts its inputs.
 *
 * `proration_behavior: 'create_prorations'` is Stripe's own standard
 * mid-cycle plan-change behavior (charges/credits the difference on the
 * customer's next invoice) — not a custom proration scheme built here.
 * @param {Object} params
 * @param {string} params.stripeSubscriptionId
 * @param {string} params.newPriceId
 * @returns {Promise<import('stripe').Stripe.Subscription>} the updated subscription
 */
export async function updateSubscriptionPrice({ stripeSubscriptionId, newPriceId }) {
  const stripe = getStripeClient();

  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const itemId = subscription.items.data[0]?.id;
  if (!itemId) {
    throw new Error(`Stripe subscription "${stripeSubscriptionId}" has no subscription item to update.`);
  }

  return stripe.subscriptions.update(stripeSubscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'create_prorations',
  });
}

/**
 * Creates a Stripe Billing Portal session for an existing Stripe customer.
 * Pure passthrough to the Stripe API, same as createCheckoutSession — no
 * database read/write happens here or in any caller of this function.
 * Deliberately returns only `{portalUrl}`, not the raw Stripe session
 * object, since nothing outside this file should need any other field off
 * a Billing Portal session.
 * @param {Object} params
 * @param {string} params.stripeCustomerId
 * @param {string} params.returnUrl
 * @returns {Promise<{portalUrl: string}>}
 */
export async function createBillingPortalSession({ stripeCustomerId, returnUrl }) {
  const stripe = getStripeClient();

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return { portalUrl: session.url };
}

/**
 * Cancels a Stripe subscription immediately (not at period end) — used
 * exclusively by account deletion, where "the subscription stops at the
 * end of the billing period" is the wrong semantic (the account itself is
 * being removed now). Every other cancellation path in this codebase is
 * the ordinary customer-driven Billing Portal flow, which is inherently
 * "cancel at period end unless the customer picks otherwise" and is
 * reconciled locally via the customer.subscription.* webhook — not this
 * function.
 *
 * Treats "already canceled" as success (idempotent), since account
 * deletion must be safe to retry after a partial failure without erroring
 * on a subscription it already cancelled on a previous attempt.
 * @param {string} stripeSubscriptionId
 * @returns {Promise<{cancelled: boolean, alreadyCancelled: boolean}>}
 */
export async function cancelSubscriptionImmediately(stripeSubscriptionId) {
  const stripe = getStripeClient();

  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId);
    return { cancelled: true, alreadyCancelled: false };
  } catch (error) {
    // Stripe's own signal for "this subscription is already canceled or
    // doesn't exist" — resource_missing on a cancel call. Not a failure
    // from account deletion's point of view.
    if (error.code === 'resource_missing' || error.message?.includes('No such subscription')) {
      return { cancelled: false, alreadyCancelled: true };
    }
    throw error;
  }
}
