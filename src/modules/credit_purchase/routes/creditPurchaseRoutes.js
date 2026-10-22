import express from 'express';
import { createCreditPurchaseCheckout } from '../controller/creditPurchaseController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * @route   POST /api/credit-purchases/checkout
 * @desc    Create a Stripe Checkout Session (mode: 'payment') for a
 *          one-time project-credit top-up. Returns only a checkout URL —
 *          no quota mutation happens here; that's the webhook's job
 *          (routed through the existing POST /api/subscription/webhook
 *          endpoint — there is no second webhook route for this module,
 *          same as page_purchase).
 * @access  Private
 */
router.post('/credit-purchases/checkout', auth, createCreditPurchaseCheckout);

export default router;
