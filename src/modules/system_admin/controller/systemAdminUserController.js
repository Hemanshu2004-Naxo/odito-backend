import mongoose from 'mongoose';
import * as systemAdminUserService from '../service/systemAdminUserService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/users
 * Query: page, limit, search, role, subscriptionStatus, emailVerified,
 * accountStatus, sort — all optional, all parsed/validated in the service.
 */
const listUsers = async (req, res) => {
  try {
    const result = await systemAdminUserService.listUsers(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin users', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list users', 500));
  }
};

/**
 * GET /api/system-admin/users/:id
 */
const getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid user id', 400));
    }

    const detail = await systemAdminUserService.getUserDetail(id);
    if (!detail) {
      return res.status(404).json(ResponseUtil.error('User not found', 404));
    }

    return res.status(200).json(ResponseUtil.success(detail));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin user detail', error, {
      adminId: req.user?._id,
      targetUserId: req.params?.id,
    });
    return res.status(500).json(ResponseUtil.error('Failed to load user', 500));
  }
};

/**
 * POST /api/system-admin/users/:id/suspend
 * Body: { reason? }
 */
const suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid user id', 400));
    }

    // A reason is mandatory for this action — never trust the frontend's own
    // validation. Checked before any mutation or audit log write.
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json(ResponseUtil.error('A reason is required to suspend a user', 400));
    }

    // Fails closed against an admin locking themselves out — isActive:false
    // now blocks every subsequent authenticated request (see
    // modules/user/middleware/auth.js), including the admin's own.
    if (String(id) === String(req.user._id)) {
      return res.status(400).json(ResponseUtil.error('You cannot suspend your own account', 400));
    }

    const result = await systemAdminUserService.suspendUser(id, req.user._id, reason.trim());
    if (!result) {
      return res.status(404).json(ResponseUtil.error('User not found', 404));
    }

    LoggerUtil.info('System Admin suspended user account', { adminId: req.user._id, targetUserId: id });
    return res.status(200).json(ResponseUtil.success(result, 'User suspended'));
  } catch (error) {
    LoggerUtil.error('Error suspending user', error, { adminId: req.user?._id, targetUserId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to suspend user', 500));
  }
};

/**
 * POST /api/system-admin/users/:id/activate
 * Body: { reason? }
 */
const activateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid user id', 400));
    }

    const result = await systemAdminUserService.activateUser(id, req.user._id, reason);
    if (!result) {
      return res.status(404).json(ResponseUtil.error('User not found', 404));
    }

    LoggerUtil.info('System Admin activated user account', { adminId: req.user._id, targetUserId: id });
    return res.status(200).json(ResponseUtil.success(result, 'User activated'));
  } catch (error) {
    LoggerUtil.error('Error activating user', error, { adminId: req.user?._id, targetUserId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to activate user', 500));
  }
};

export { listUsers, getUserDetail, suspendUser, activateUser };
