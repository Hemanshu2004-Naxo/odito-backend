import * as systemAdminPaymentService from '../service/systemAdminPaymentService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/payments
 * Query: page, limit, search, paymentType, status, invoice, currency, sort.
 */
const listPayments = async (req, res) => {
  try {
    const result = await systemAdminPaymentService.listPayments(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin payments', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list payments', 500));
  }
};

/**
 * GET /api/system-admin/payments/summary
 */
const getPaymentsSummary = async (req, res) => {
  try {
    const summary = await systemAdminPaymentService.getPaymentsSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin payments summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load payments summary', 500));
  }
};

/**
 * GET /api/system-admin/payments/:paymentId
 */
const getPaymentDetail = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const detail = await systemAdminPaymentService.getPaymentDetail(paymentId);
    if (!detail) {
      return res.status(404).json(ResponseUtil.error('Payment not found', 404));
    }
    return res.status(200).json(ResponseUtil.success(detail));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin payment detail', error, {
      adminId: req.user?._id,
      paymentId: req.params?.paymentId,
    });
    return res.status(500).json(ResponseUtil.error('Failed to load payment', 500));
  }
};

export { listPayments, getPaymentsSummary, getPaymentDetail };
