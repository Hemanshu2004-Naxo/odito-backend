import PagePurchase from '../model/PagePurchase.js';
import User from '../../user/model/User.js';
import { addPages } from '../../../utils/creditService.js';
import { fetchInvoiceUrls } from '../../../services/stripeService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { getEnvVar } from '../../../config/env.js';

// Same CORS_ORIGIN-as-frontend-URL idiom used in subscriptionWebhookService.js.
const MANAGE_SUBSCRIPTION_URL = `${getEnvVar('CORS_ORIGIN')}/settings/subscription`;

/**
 * checkout.session.completed for a page-pack purchase (mode: 'payment',
 * session.metadata.purchaseType === 'page_pack') — dispatched here from
 * subscriptionWebhookService.js's processStripeEvent(), which already
 * verified the Stripe signature and claimed this event id via
 * WebhookEvent's unique index before this ever runs (that is the PRIMARY
 * duplicate-delivery guard — see that file). Everything below is specific
 * to page purchases and deliberately does not touch subscription.plan,
 * subscription.status, or credits.
 *
 * addPages() only ever runs once per Stripe Checkout Session: the
 * `findOneAndUpdate({stripeSessionId, status:'pending'}, ...)` below only
 * matches a row still in 'pending'. If some future retry path ever let a
 * second delivery of this same event reach this function (defense in
 * depth beyond the WebhookEvent-level guard, not the expected path), the
 * row would already be 'paid'/'failed', the update would match nothing,
 * and pages are never granted twice.
 */
export async function handlePagePurchaseCompleted(session, eventId) {
  const { userId, pagesPurchased: pagesPurchasedRaw, projectId } = session.metadata || {};
  const pagesPurchased = Number(pagesPurchasedRaw);

  if (!userId || !Number.isInteger(pagesPurchased) || pagesPurchased < 1) {
    throw new Error(
      `page_pack checkout.session.completed: invalid metadata (userId=${userId}, pagesPurchased=${pagesPurchasedRaw})`
    );
  }

  const paymentSucceeded = session.payment_status !== 'unpaid';
  const newStatus = paymentSucceeded ? 'paid' : 'failed';

  // session.invoice is only populated because invoice_creation is enabled
  // on this Checkout Session (stripeService.createOneTimePaymentSession) —
  // it's only ever an ID, so the hosted URL/PDF link require this separate
  // fetch, same as the subscription checkout handler.
  const { hostedInvoiceUrl, invoicePdfUrl } = await fetchInvoiceUrls(session.invoice);

  const updated = await PagePurchase.findOneAndUpdate(
    { stripeSessionId: session.id, status: 'pending' },
    { $set: { status: newStatus, paymentIntentId: session.payment_intent || null, hostedInvoiceUrl, invoicePdfUrl } },
    { new: true }
  );

  let firstTimeSettled = Boolean(updated);

  if (!updated) {
    // No pending row matched — either the checkout endpoint's
    // PagePurchase.create() never landed (e.g. a DB blip right after the
    // Stripe session was already created), or this session was already
    // settled by an earlier delivery. The unique index on stripeSessionId
    // makes this branch idempotent on its own: a genuine duplicate hits
    // code 11000 and is swallowed, granting nothing a second time.
    try {
      await PagePurchase.create({
        userId,
        projectId: projectId || null,
        pagesPurchased,
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
      LoggerUtil.info('Duplicate page purchase webhook ignored (already recorded)', {
        stripeSessionId: session.id,
        eventId,
      });
    }
  }

  if (!firstTimeSettled) {
    return;
  }

  if (!paymentSucceeded) {
    LoggerUtil.warn('Page purchase checkout completed but payment_status is unpaid — no pages granted', {
      userId,
      stripeSessionId: session.id,
    });
    return;
  }

  await addPages(userId, pagesPurchased);

  LoggerUtil.info('Pages granted via page-pack checkout.session.completed', {
    userId,
    pagesPurchased,
    stripeSessionId: session.id,
  });

  // Email failure must never affect the pages already granted above — same
  // isolation principle as recordTransaction() in subscriptionWebhookService.js.
  const user = await User.findById(userId).select('email firstName').lean();
  if (user) {
    await sendMail(MAIL_TYPES.ADDITIONAL_PAGES_PURCHASED, user.email, {
      firstName: user.firstName,
      pagesPurchased,
      amount: typeof session.amount_total === 'number' ? session.amount_total : null,
      currency: session.currency || null,
      invoiceUrl: hostedInvoiceUrl,
      manageUrl: MANAGE_SUBSCRIPTION_URL,
    });
  } else {
    LoggerUtil.warn('Could not send additional-pages-purchased email: user not found', { userId });
  }
}
