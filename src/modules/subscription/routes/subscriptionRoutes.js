import express from 'express';
import {
  getMySubscription,
  getPlans,
  createCheckoutSession,
  createBillingPortalSession,
  getBillingHistory,
  changePlan,
  createCustomPlanRequest,
  getMyCustomPlanRequest,
} from '../controller/subscriptionController.js';
import {
  adminAssignPlan,
  adminAdjustQuota,
  adminUpdateStatus,
} from '../controller/adminSubscriptionController.js';
import {
  updateCustomPlanRequestStatus,
  addCustomPlanRequestNote,
} from '../controller/adminCustomPlanRequestController.js';
import auth from '../../user/middleware/auth.js';
import { requireAdmin } from '../../../middleware/auth.middleware.js';

const router = express.Router();

/**
 * @route   GET /api/plans
 * @desc    List every active subscription plan (public — no auth)
 * @access  Public
 */
router.get('/plans', getPlans);

/**
 * @route   GET /api/subscription
 * @desc    The authenticated user's current plan, status, and live quota
 * @access  Private
 */
router.get('/subscription', auth, getMySubscription);

/**
 * @route   POST /api/subscription/checkout
 * @desc    Create a Stripe Checkout Session for a plan. Returns only a
 *          checkout URL — no user/quota mutation happens here.
 * @access  Private
 */
router.post('/subscription/checkout', auth, createCheckoutSession);

/**
 * @route   POST /api/subscription/portal
 * @desc    Create a Stripe Billing Portal session for the authenticated
 *          user's existing Stripe customer. Returns only a portal URL — no
 *          user/quota mutation happens here. Not a webhook — a normal
 *          authenticated JSON request, so it belongs here rather than
 *          server.js (which only the raw-body webhook route needs).
 * @access  Private
 */
router.post('/subscription/portal', auth, createBillingPortalSession);

/**
 * @route   GET /api/subscription/history
 * @desc    The authenticated user's billing history, newest first,
 *          pagination-ready (?page, ?limit).
 * @access  Private
 */
router.get('/subscription/history', auth, getBillingHistory);

/**
 * @route   POST /api/subscription/change-plan
 * @desc    Request an upgrade/downgrade on the user's existing Stripe
 *          subscription. Only calls Stripe — the resulting webhook event is
 *          what actually syncs plan/quota (see subscriptionWebhookService.js).
 * @access  Private
 */
router.post('/subscription/change-plan', auth, changePlan);

/**
 * @route   POST /api/subscription/custom-request
 * @desc    Submit a Custom Plan lead. Never touches Stripe, User.subscription,
 *          or credits/pages — purely a sales request for a human follow-up.
 *          Rejects 409 if the user already has a pending/contacted request.
 * @access  Private
 */
router.post('/subscription/custom-request', auth, createCustomPlanRequest);

/**
 * @route   GET /api/subscription/custom-request/me
 * @desc    The authenticated user's most recent Custom Plan request, or null.
 * @access  Private
 */
router.get('/subscription/custom-request/me', auth, getMyCustomPlanRequest);

/**
 * @route   POST /api/subscription/admin/users/:userId/plan
 * @desc    Admin-only manual plan assignment (support/correction tool —
 *          does NOT call Stripe, does NOT change what the customer is
 *          billed). Every call is written to SystemAdminAuditLog.
 * @access  Private (admin roleId 1-3 only)
 */
router.post('/subscription/admin/users/:userId/plan', auth, requireAdmin(), adminAssignPlan);

/**
 * @route   POST /api/subscription/admin/users/:userId/quota
 * @desc    Admin-only manual credits/pages limit override. Audit-logged.
 * @access  Private (admin roleId 1-3 only)
 */
router.post('/subscription/admin/users/:userId/quota', auth, requireAdmin(), adminAdjustQuota);

/**
 * @route   POST /api/subscription/admin/users/:userId/status
 * @desc    Admin-only manual subscription.status override. Audit-logged.
 * @access  Private (admin roleId 1-3 only)
 */
router.post('/subscription/admin/users/:userId/status', auth, requireAdmin(), adminUpdateStatus);

/**
 * @route   POST /api/subscription/admin/custom-plan-requests/:id/status
 * @desc    Admin-only Custom Plan request status change (pending/contacted/
 *          closed). Recorded in the request's own embedded statusHistory.
 * @access  Private (admin roleId 1-3 only)
 */
router.post('/subscription/admin/custom-plan-requests/:id/status', auth, requireAdmin(), updateCustomPlanRequestStatus);

/**
 * @route   POST /api/subscription/admin/custom-plan-requests/:id/notes
 * @desc    Admin-only internal note — never exposed to the customer.
 * @access  Private (admin roleId 1-3 only)
 */
router.post('/subscription/admin/custom-plan-requests/:id/notes', auth, requireAdmin(), addCustomPlanRequestNote);

export default router;
