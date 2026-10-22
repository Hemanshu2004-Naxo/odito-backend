import mongoose from 'mongoose';
import User from '../../user/model/User.js';
import SystemAdminAuditLog from '../model/SystemAdminAuditLog.js';
import { isValidPlan, getPlanLimits } from '../../../config/plans.js';
import { reallocateQuotaForPlanChange } from '../../../utils/creditService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

// Kept in sync with User.js's subscription.status enum by hand — Mongoose
// enums aren't introspectable at runtime in a form worth importing here.
const SUBSCRIPTION_STATUSES = ['inactive', 'active', 'paused', 'canceled', 'past_due'];

async function loadTargetUser(userId, res) {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400).json(ResponseUtil.error('Invalid user id', 400));
    return null;
  }
  const user = await User.findById(userId);
  if (!user) {
    res.status(404).json(ResponseUtil.error('User not found', 404));
    return null;
  }
  return user;
}

/**
 * POST /subscription/admin/users/:userId/plan
 * Body: { planId, reason? }
 *
 * A support/correction tool, not a billing action: this writes
 * subscription.plan directly and reallocates quota (preserving `used`, same
 * policy as the automatic webhook-driven path) — it never touches Stripe.
 * An admin plan assignment therefore does NOT change what the customer is
 * actually billed; it only changes what Odito grants them internally. That
 * asymmetry is intentional (grandfathering, comping, support fixes) but is
 * a real, disclosed limitation — Stripe and Odito's local plan can end up
 * disagreeing until the next Stripe-driven event resyncs them.
 *
 * Unlike the user-facing Change Plan API, an admin MAY assign an inactive
 * (retired) plan — that's the whole point of an override tool; a normal
 * user is blocked from ever choosing one, but a support agent correcting a
 * grandfathered account is not.
 */
export const adminAssignPlan = async (req, res) => {
  try {
    const { userId } = req.params;
    const { planId, reason } = req.body;

    if (!planId || typeof planId !== 'string' || !isValidPlan(planId)) {
      return res.status(400).json(ResponseUtil.error('A valid planId is required', 400));
    }

    const user = await loadTargetUser(userId, res);
    if (!user) return;

    const before = { plan: user.subscription.plan };
    const after = { plan: planId };

    // findByIdAndUpdate, not user.save() — matches the exact write pattern
    // every webhook handler already uses (see subscriptionWebhookService.js),
    // which skips Mongoose's schema-level enum validation on
    // subscription.plan by design (findByIdAndUpdate doesn't run validators
    // unless runValidators is passed, and nothing in this codebase passes
    // it). Consistency matters here specifically: config/plans.js is
    // designed to let new plans be added without every write path needing
    // simultaneous updates.
    await User.findByIdAndUpdate(user._id, { $set: { 'subscription.plan': planId } });
    await reallocateQuotaForPlanChange(user._id, getPlanLimits(planId));

    await SystemAdminAuditLog.create({
      admin: req.user._id,
      targetUser: user._id,
      action: 'plan_assignment',
      before,
      after,
      reason: reason || null,
    });

    LoggerUtil.info('System Admin manually assigned plan', { adminId: req.user._id, targetUserId: user._id, before, after });

    return res.status(200).json(ResponseUtil.success({ before, after }, 'Plan assigned'));
  } catch (error) {
    LoggerUtil.error('Error in adminAssignPlan', error, { adminId: req.user?._id, targetUserId: req.params?.userId });
    return res.status(500).json(ResponseUtil.error('Failed to assign plan', 500));
  }
};

/**
 * POST /subscription/admin/users/:userId/quota
 * Body: { credits?, pages?, reason? } — at least one of credits/pages
 *
 * Sets `limit` only (absolute), exactly like the plan-driven paths — never
 * touches `used`. At least one of credits/pages must be provided; either
 * may be omitted to leave that resource untouched.
 */
export const adminAdjustQuota = async (req, res) => {
  try {
    const { userId } = req.params;
    const { credits, pages, reason } = req.body;

    const hasCredits = credits !== undefined;
    const hasPages = pages !== undefined;

    if (!hasCredits && !hasPages) {
      return res.status(400).json(ResponseUtil.error('At least one of credits or pages is required', 400));
    }
    if (hasCredits && (typeof credits !== 'number' || credits < 0)) {
      return res.status(400).json(ResponseUtil.error('credits must be a non-negative number', 400));
    }
    if (hasPages && (typeof pages !== 'number' || pages < 0)) {
      return res.status(400).json(ResponseUtil.error('pages must be a non-negative number', 400));
    }

    const user = await loadTargetUser(userId, res);
    if (!user) return;

    const before = {
      credits: user.subscription.credits.limit,
      pages: user.subscription.pages.limit,
    };
    const after = {
      credits: hasCredits ? credits : before.credits,
      pages: hasPages ? pages : before.pages,
    };

    const update = { $set: {} };
    if (hasCredits) update.$set['subscription.credits.limit'] = credits;
    if (hasPages) update.$set['subscription.pages.limit'] = pages;
    await User.findByIdAndUpdate(user._id, update);

    await SystemAdminAuditLog.create({
      admin: req.user._id,
      targetUser: user._id,
      action: 'quota_adjustment',
      before,
      after,
      reason: reason || null,
    });

    LoggerUtil.info('System Admin manually adjusted quota', { adminId: req.user._id, targetUserId: user._id, before, after });

    return res.status(200).json(ResponseUtil.success({ before, after }, 'Quota adjusted'));
  } catch (error) {
    LoggerUtil.error('Error in adminAdjustQuota', error, { adminId: req.user?._id, targetUserId: req.params?.userId });
    return res.status(500).json(ResponseUtil.error('Failed to adjust quota', 500));
  }
};

/**
 * POST /subscription/admin/users/:userId/status
 * Body: { status, reason? }
 *
 * Direct override of subscription.status — never touches Stripe. Same
 * disclosed limitation as adminAssignPlan: this can put Odito's local view
 * out of sync with Stripe's until the next real Stripe event resyncs it.
 * Intended for support scenarios Stripe itself can't express locally (e.g.
 * a manually comped pause) — use sparingly.
 */
export const adminUpdateStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, reason } = req.body;

    if (!status || !SUBSCRIPTION_STATUSES.includes(status)) {
      return res.status(400).json(ResponseUtil.error(`status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`, 400));
    }

    const user = await loadTargetUser(userId, res);
    if (!user) return;

    const before = { status: user.subscription.status };
    const after = { status };

    await User.findByIdAndUpdate(user._id, { $set: { 'subscription.status': status } });

    await SystemAdminAuditLog.create({
      admin: req.user._id,
      targetUser: user._id,
      action: 'status_update',
      before,
      after,
      reason: reason || null,
    });

    LoggerUtil.info('System Admin manually updated subscription status', { adminId: req.user._id, targetUserId: user._id, before, after });

    return res.status(200).json(ResponseUtil.success({ before, after }, 'Status updated'));
  } catch (error) {
    LoggerUtil.error('Error in adminUpdateStatus', error, { adminId: req.user?._id, targetUserId: req.params?.userId });
    return res.status(500).json(ResponseUtil.error('Failed to update status', 500));
  }
};
