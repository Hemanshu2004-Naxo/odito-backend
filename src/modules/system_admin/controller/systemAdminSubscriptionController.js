import mongoose from 'mongoose';
import * as systemAdminSubscriptionService from '../service/systemAdminSubscriptionService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/subscriptions
 * Query: page, limit, search, plan, status, hasStripeCustomer,
 * hasSubscription, sort — all optional, parsed/validated in the service.
 */
const listSubscriptions = async (req, res) => {
  try {
    const result = await systemAdminSubscriptionService.listSubscriptions(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin subscriptions', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list subscriptions', 500));
  }
};

/**
 * GET /api/system-admin/subscriptions/:userId
 */
const getSubscriptionDetail = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json(ResponseUtil.error('Invalid user id', 400));
    }

    const detail = await systemAdminSubscriptionService.getSubscriptionDetail(userId);
    if (!detail) {
      return res.status(404).json(ResponseUtil.error('User not found', 404));
    }

    return res.status(200).json(ResponseUtil.success(detail));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin subscription detail', error, {
      adminId: req.user?._id,
      targetUserId: req.params?.userId,
    });
    return res.status(500).json(ResponseUtil.error('Failed to load subscription', 500));
  }
};

export { listSubscriptions, getSubscriptionDetail };
