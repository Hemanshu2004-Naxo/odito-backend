import mongoose from 'mongoose';
import * as systemAdminCustomPlanRequestService from '../service/systemAdminCustomPlanRequestService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/custom-plan-requests
 * Query: page, limit, search, status, sort — all optional, parsed/validated
 * in the service.
 */
const listCustomPlanRequests = async (req, res) => {
  try {
    const result = await systemAdminCustomPlanRequestService.listCustomPlanRequests(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin custom plan requests', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list custom plan requests', 500));
  }
};

/**
 * GET /api/system-admin/custom-plan-requests/:id
 */
const getCustomPlanRequestDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid request id', 400));
    }

    const detail = await systemAdminCustomPlanRequestService.getCustomPlanRequestDetail(id);
    if (!detail) {
      return res.status(404).json(ResponseUtil.error('Custom plan request not found', 404));
    }

    return res.status(200).json(ResponseUtil.success(detail));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin custom plan request detail', error, {
      adminId: req.user?._id,
      requestId: req.params?.id,
    });
    return res.status(500).json(ResponseUtil.error('Failed to load custom plan request', 500));
  }
};

export { listCustomPlanRequests, getCustomPlanRequestDetail };
