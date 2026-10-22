import { createOneTimePaymentSession } from '../../../services/stripeService.js';
import {
  calculateCreditPackPriceCents,
  isValidCreditCount,
  MIN_CREDITS_PER_PURCHASE,
  MAX_CREDITS_PER_PURCHASE,
} from '../config/creditPackPricing.js';
import CreditPurchase from '../model/CreditPurchase.js';
import { getServiceUrls } from '../../../config/env.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Only a same-origin relative path is ever honored as a return
 * destination — same guard as pagePurchaseController.js's own
 * isSafeReturnPath(), duplicated rather than imported cross-module since
 * it's a single three-line pure function, not a Stripe/business-logic
 * helper.
 * @param {unknown} path
 * @returns {boolean}
 */
function isSafeReturnPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('://');
}

/**
 * POST /credit-purchases/checkout (auth required)
 * Body: { credits: number, returnPath?: string }
 *
 * Creates a one-time (mode: 'payment') Stripe Checkout Session for a
 * project-credit top-up. This is NOT a subscription change — plan/status/
 * pages are never read or written here. Exact structural mirror of
 * pagePurchaseController.js's createPagePurchaseCheckout — reuses the
 * SAME createOneTimePaymentSession() from services/stripeService.js
 * (nothing new added there), just with credits' own pricing config and
 * model.
 *
 * Security: the client sends only a credit count (and, optionally, where
 * to return to). The price that Stripe actually charges comes exclusively
 * from calculateCreditPackPriceCents() — config/creditPackPricing.js
 * resolved server-side — so a tampered request body can change which
 * (valid) credit count is being purchased, never what it costs.
 */
export const createCreditPurchaseCheckout = async (req, res) => {
  try {
    const { credits, returnPath } = req.body;
    const creditsNum = Number(credits);

    if (!isValidCreditCount(creditsNum)) {
      return res.status(400).json(ResponseUtil.error(
        `credits must be a whole number between ${MIN_CREDITS_PER_PURCHASE} and ${MAX_CREDITS_PER_PURCHASE}`,
        400
      ));
    }

    const frontendUrl = getServiceUrls().frontend;
    const safeReturnPath = isSafeReturnPath(returnPath) ? returnPath : '/settings/subscription';
    const separator = safeReturnPath.includes('?') ? '&' : '?';
    const successUrl = `${frontendUrl}${safeReturnPath}${separator}creditsPurchased=true`;
    const cancelUrl = `${frontendUrl}${safeReturnPath}${separator}creditsPurchaseCancelled=true`;

    const priceCents = calculateCreditPackPriceCents(creditsNum);

    let session;
    try {
      session = await createOneTimePaymentSession({
        priceCents,
        productName: `${creditsNum} Additional Project Credit${creditsNum === 1 ? '' : 's'}`,
        userId: req.user._id,
        stripeCustomerId: req.user.subscription?.stripeCustomerId || null,
        customerEmail: req.user.email,
        successUrl,
        cancelUrl,
        metadata: {
          purchaseType: 'credit_pack',
          creditsPurchased: String(creditsNum),
        },
      });
    } catch (stripeError) {
      LoggerUtil.error('Failed to create credit purchase checkout session', stripeError, { userId: req.user._id });
      return res.status(503).json(ResponseUtil.error('Checkout is not available right now. Please try again later.', 503));
    }

    // Created as 'pending' here, flipped to 'paid'/'failed' by the webhook
    // once Stripe confirms payment — one document per session, never
    // created a second time (see CreditPurchase.js / the webhook
    // service's own comments for the fallback path if this write never
    // lands).
    await CreditPurchase.create({
      userId: req.user._id,
      creditsPurchased: creditsNum,
      pricePaid: priceCents,
      currency: 'usd',
      stripeSessionId: session.id,
      status: 'pending',
    });

    LoggerUtil.info('Credit purchase checkout session created', { userId: req.user._id, credits: creditsNum, priceCents });

    return res.status(200).json(ResponseUtil.success({ checkoutUrl: session.url }, 'Checkout session created'));
  } catch (error) {
    LoggerUtil.error('Error creating credit purchase checkout session', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to create checkout session', 500));
  }
};
