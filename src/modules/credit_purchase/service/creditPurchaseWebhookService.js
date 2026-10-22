import CreditPurchase from '../model/CreditPurchase.js';
import User from '../../user/model/User.js';
import { addCredits } from '../../../utils/creditService.js';
import { fetchInvoiceUrls } from '../../../services/stripeService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { getEnvVar } from '../../../config/env.js';

// Same CORS_ORIGIN-as-frontend-URL idiom used in subscriptionWebhookService.js.
const MANAGE_SUBSCRIPTION_URL = `${getEnvVar('CORS_ORIGIN')}/settings/subscription`;

/**
 * checkout.session.completed for a credit-pack purchase (mode: 'payment',
 * session.metadata.purchaseType === 'credit_pack') — dispatched here from
 * subscriptionWebhookService.js's processStripeEvent(), which already
 * verified the Stripe signature and claimed this event id via
 * WebhookEvent's unique index before this ever runs (the PRIMARY
 * duplicate-delivery guard — see that file). This is the exact same
 * structure as page_purchase/service/pagePurchaseWebhookService.js's
 * handlePagePurchaseCompleted(), with credits substituted for pages —
 * deliberately not shared/parameterized into one generic function, since
 * the two purchase kinds are independent domain concepts (see this
 * module's own model, CreditPurchase, which is a separate collection from
 * PagePurchase) even though their mechanics mirror each other exactly.
 *
 * addCredits() only ever runs once per Stripe Checkout Session: the
 * `findOneAndUpdate({stripeSessionId, status:'pending'}, ...)` below only
 * matches a row still in 'pending'. If some future retry path ever let a
 * second delivery of this same event reach this function (defense in
 * depth beyond the WebhookEvent-level guard, not the expected path), the
 * row would already be 'paid'/'failed', the update would match nothing,
 * and credits are never granted twice.
 */
export async function handleCreditPurchaseCompleted(session, eventId) {
  const { userId, creditsPurchased: creditsPurchasedRaw } = session.metadata || {};
  const creditsPurchased = Number(creditsPurchasedRaw);

  if (!userId || !Number.isInteger(creditsPurchased) || creditsPurchased < 1) {
    throw new Error(
      `credit_pack checkout.session.completed: invalid metadata (userId=${userId}, creditsPurchased=${creditsPurchasedRaw})`
    );
  }

  const paymentSucceeded = session.payment_status !== 'unpaid';
  const newStatus = paymentSucceeded ? 'paid' : 'failed';

  // session.invoice is only populated because invoice_creation is enabled
  // on this Checkout Session (stripeService.createOneTimePaymentSession) —
  // it's only ever an ID, so the hosted URL/PDF link require this separate
  // fetch, same as the subscription checkout handler.
  const { hostedInvoiceUrl, invoicePdfUrl } = await fetchInvoiceUrls(session.invoice);

  const updated = await CreditPurchase.findOneAndUpdate(
    { stripeSessionId: session.id, status: 'pending' },
    { $set: { status: newStatus, paymentIntentId: session.payment_intent || null, hostedInvoiceUrl, invoicePdfUrl } },
    { new: true }
  );

  let firstTimeSettled = Boolean(updated);

  if (!updated) {
    // No pending row matched — either the checkout endpoint's
    // CreditPurchase.create() never landed (e.g. a DB blip right after the
    // Stripe session was already created), or this session was already
    // settled by an earlier delivery. The unique index on stripeSessionId
    // makes this branch idempotent on its own: a genuine duplicate hits
    // code 11000 and is swallowed, granting nothing a second time.
    try {
      await CreditPurchase.create({
        userId,
        creditsPurchased,
        pricePaid: typeof session.amount_total === 'number' ? session.amount_total : 0,
        currency: session.currency || 'usd',
        stripeSessionId: session.id,
        paymentIntentId: session.payment_intent || null,
        hostedInvoiceUrl,
        invoicePdfUrl,
        status: newStatus,
      });
      firstTimeSettled = true;
    } catch (createError) {
      if (createError.code !== 11000) throw createError;
      firstTimeSettled = false;
      LoggerUtil.info('Duplicate credit purchase webhook ignored (already recorded)', {
        stripeSessionId: session.id,
        eventId,
      });
    }
  }

  if (!firstTimeSettled) {
    return;
  }

  if (!paymentSucceeded) {
    LoggerUtil.warn('Credit purchase checkout completed but payment_status is unpaid — no credits granted', {
      userId,
      stripeSessionId: session.id,
    });
    return;
  }

  await addCredits(userId, creditsPurchased);

  LoggerUtil.info('Credits granted via credit-pack checkout.session.completed', {
    userId,
    creditsPurchased,
    stripeSessionId: session.id,
  });

  // Email failure must never affect the credits already granted above — same
  // isolation principle as recordTransaction() in subscriptionWebhookService.js.
  const user = await User.findById(userId).select('email firstName').lean();
  if (user) {
    await sendMail(MAIL_TYPES.CREDITS_PURCHASED, user.email, {
      firstName: user.firstName,
      creditsPurchased,
      amount: typeof session.amount_total === 'number' ? session.amount_total : null,
      currency: session.currency || null,
      invoiceUrl: hostedInvoiceUrl,
      manageUrl: MANAGE_SUBSCRIPTION_URL,
    });
  } else {
    LoggerUtil.warn('Could not send credits-purchased email: user not found', { userId });
  }
}
