import { createOneTimePaymentSession } from '../../../services/stripeService.js';
import {
  calculatePagePackPriceCents,
  isValidPageCount,
  MIN_PAGES_PER_PURCHASE,
  MAX_PAGES_PER_PURCHASE,
} from '../config/pagePackPricing.js';
import PagePurchase from '../model/PagePurchase.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { getServiceUrls } from '../../../config/env.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Only a same-origin relative path is ever honored as a return
 * destination — `returnPath` comes from client input, and unlike the page
 * count it is never itself charged for, but an unvalidated absolute
 * URL/protocol-relative path would be an open-redirect vector once
 * prefixed onto the real frontend origin.
 * @param {unknown} path
 * @returns {boolean}
 */
function isSafeReturnPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('://');
}

/**
 * POST /page-purchases/checkout (auth required)
 * Body: { pages: number, projectId?: string, returnPath?: string }
 *
 * Creates a one-time (mode: 'payment') Stripe Checkout Session for a
 * page-quota top-up. This is NOT a subscription change — plan/status/
 * credits are never read or written here. Mirrors
 * subscriptionController.createCheckoutSession's own shape (only ever
 * returns a checkoutUrl; no quota mutation happens until the webhook
 * confirms payment — see service/pagePurchaseWebhookService.js).
 *
 * Security: the client sends only a page count (and, optionally, which
 * project to return to). The price that Stripe actually charges comes
 * exclusively from calculatePagePackPriceCents() — config/pagePackPricing.js
 * resolved server-side — so a tampered request body can change which
 * (valid) page count is being purchased, never what it costs.
 */
export const createPagePurchaseCheckout = async (req, res) => {
  try {
    const { pages, projectId, returnPath } = req.body;
    const pagesNum = Number(pages);

    if (!isValidPageCount(pagesNum)) {
      return res.status(400).json(ResponseUtil.error(
        `pages must be a whole number between ${MIN_PAGES_PER_PURCHASE} and ${MAX_PAGES_PER_PURCHASE}`,
        400
      ));
    }

    let validatedProjectId = null;
    if (projectId) {
      // Ownership check — never trust a project id the client sends
      // without confirming it belongs to this user, same pattern as every
      // other project-scoped endpoint.
      const project = await SeoProject.findOne({
        _id: projectId,
        user_id: req.user._id,
        is_deleted: { $ne: true },
      }).select('_id').lean();

      if (!project) {
        return res.status(404).json(ResponseUtil.error('Project not found', 404));
      }
      validatedProjectId = project._id;
    }

    const frontendUrl = getServiceUrls().frontend;
    const safeReturnPath = isSafeReturnPath(returnPath) ? returnPath : '/settings/subscription';
    const separator = safeReturnPath.includes('?') ? '&' : '?';
    const successUrl = `${frontendUrl}${safeReturnPath}${separator}pagesPurchased=true`;
    const cancelUrl = `${frontendUrl}${safeReturnPath}${separator}pagesPurchaseCancelled=true`;

    const priceCents = calculatePagePackPriceCents(pagesNum);

    let session;
    try {
      session = await createOneTimePaymentSession({
        priceCents,
        productName: `${pagesNum} Additional Audit Pages`,
        userId: req.user._id,
        stripeCustomerId: req.user.subscription?.stripeCustomerId || null,
        customerEmail: req.user.email,
        successUrl,
        cancelUrl,
        metadata: {
          purchaseType: 'page_pack',
          pagesPurchased: String(pagesNum),
          projectId: validatedProjectId ? String(validatedProjectId) : '',
        },
      });
    } catch (stripeError) {
      LoggerUtil.error('Failed to create page purchase checkout session', stripeError, { userId: req.user._id });
      return res.status(503).json(ResponseUtil.error('Checkout is not available right now. Please try again later.', 503));
    }

    // Created as 'pending' here, flipped to 'paid'/'failed' by the webhook
    // once Stripe confirms payment — one document per session, never
    // created a second time (see PagePurchase.js / the webhook service's
    // own comments for the fallback path if this write never lands).
    await PagePurchase.create({
      userId: req.user._id,
      projectId: validatedProjectId,
      pagesPurchased: pagesNum,
      pricePaid: priceCents,
      currency: 'usd',
      stripeSessionId: session.id,
      status: 'pending',
    });

    LoggerUtil.info('Page purchase checkout session created', { userId: req.user._id, pages: pagesNum, priceCents });

    return res.status(200).json(ResponseUtil.success({ checkoutUrl: session.url }, 'Checkout session created'));
  } catch (error) {
    LoggerUtil.error('Error creating page purchase checkout session', error, { userId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to create checkout session', 500));
  }
};
