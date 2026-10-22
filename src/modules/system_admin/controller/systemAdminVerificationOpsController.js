import * as systemAdminVerificationOpsService from '../service/systemAdminVerificationOpsService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/* ────────────────────────── Batch Dashboard ────────────────────────── */

const listBatches = async (req, res) => {
  try {
    const result = await systemAdminVerificationOpsService.listBatches(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing verification batches', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list verification batches', 500));
  }
};

const getBatchesSummary = async (req, res) => {
  try {
    const summary = await systemAdminVerificationOpsService.getBatchesSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading verification batches summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load verification batches summary', 500));
  }
};

const getBatchDetail = async (req, res) => {
  try {
    const batch = await systemAdminVerificationOpsService.getBatchDetail(req.params.batchId);
    if (!batch) return res.status(404).json(ResponseUtil.error('Verification batch not found', 404));
    return res.status(200).json(ResponseUtil.success(batch));
  } catch (error) {
    LoggerUtil.error('Error loading verification batch detail', error, { adminId: req.user?._id, batchId: req.params?.batchId });
    return res.status(500).json(ResponseUtil.error('Failed to load verification batch', 500));
  }
};

/* ────────────────────────── Queue Dashboard ────────────────────────── */

const getQueueSummary = async (req, res) => {
  try {
    const summary = await systemAdminVerificationOpsService.getQueueSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading verification queue summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load queue summary', 500));
  }
};

/* ───────────────────────── Recovery Dashboard ───────────────────────── */

const listRecoveryEvents = async (req, res) => {
  try {
    const result = await systemAdminVerificationOpsService.listRecoveryEvents(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing recovery events', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list recovery events', 500));
  }
};

const getRecoverySummary = async (req, res) => {
  try {
    const summary = await systemAdminVerificationOpsService.getRecoverySummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading recovery summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load recovery summary', 500));
  }
};

/* ─────────────────────────── Worker Health ─────────────────────────── */

const getWorkerHealth = async (req, res) => {
  try {
    const health = await systemAdminVerificationOpsService.getWorkerHealth();
    return res.status(200).json(ResponseUtil.success(health));
  } catch (error) {
    LoggerUtil.error('Error loading worker health', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load worker health', 500));
  }
};

export {
  listBatches,
  getBatchesSummary,
  getBatchDetail,
  getQueueSummary,
  listRecoveryEvents,
  getRecoverySummary,
  getWorkerHealth,
};
