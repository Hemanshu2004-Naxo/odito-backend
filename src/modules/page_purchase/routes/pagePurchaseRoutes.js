import express from 'express';
import { createPagePurchaseCheckout } from '../controller/pagePurchaseController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * @route   POST /api/page-purchases/checkout
 * @desc    Create a Stripe Checkout Session (mode: 'payment') for a
 *          one-time page-quota top-up. Returns only a checkout URL — no
 *          quota mutation happens here; that's the webhook's job (routed
 *          through the existing POST /api/subscription/webhook endpoint —
 *          there is no second webhook route for this module).
 * @access  Private
 */
router.post('/page-purchases/checkout', auth, createPagePurchaseCheckout);

export default router;
