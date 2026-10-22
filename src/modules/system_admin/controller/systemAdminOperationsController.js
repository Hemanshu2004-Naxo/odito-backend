import * as systemAdminOperationsService from '../service/systemAdminOperationsService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/* ────────────────────────────── Jobs ────────────────────────────── */

const listJobs = async (req, res) => {
  try {
    const result = await systemAdminOperationsService.listJobs(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin jobs', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list jobs', 500));
  }
};

const getJobDetail = async (req, res) => {
  try {
    const job = await systemAdminOperationsService.getJobDetail(req.params.jobId);
    if (!job) return res.status(404).json(ResponseUtil.error('Job not found', 404));
    return res.status(200).json(ResponseUtil.success(job));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin job detail', error, { adminId: req.user?._id, jobId: req.params?.jobId });
    return res.status(500).json(ResponseUtil.error('Failed to load job', 500));
  }
};

const getJobsSummary = async (req, res) => {
  try {
    const summary = await systemAdminOperationsService.getJobsSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin jobs summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load jobs summary', 500));
  }
};

/* ──────────────────────────── Webhooks ──────────────────────────── */

const listWebhooks = async (req, res) => {
  try {
    const result = await systemAdminOperationsService.listWebhooks(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin webhooks', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list webhooks', 500));
  }
};

const getWebhookDetail = async (req, res) => {
  try {
    const webhook = await systemAdminOperationsService.getWebhookDetail(req.params.id);
    if (!webhook) return res.status(404).json(ResponseUtil.error('Webhook event not found', 404));
    return res.status(200).json(ResponseUtil.success(webhook));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin webhook detail', error, { adminId: req.user?._id, webhookId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to load webhook', 500));
  }
};

const getWebhooksSummary = async (req, res) => {
  try {
    const summary = await systemAdminOperationsService.getWebhooksSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin webhooks summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load webhooks summary', 500));
  }
};

/* ─────────────────────────── Audit Logs ─────────────────────────── */

const listAuditLogs = async (req, res) => {
  try {
    const result = await systemAdminOperationsService.listAuditLogs(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin audit logs', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list audit logs', 500));
  }
};

const getAuditLogDetail = async (req, res) => {
  try {
    const log = await systemAdminOperationsService.getAuditLogDetail(req.params.id);
    if (!log) return res.status(404).json(ResponseUtil.error('Audit log entry not found', 404));
    return res.status(200).json(ResponseUtil.success(log));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin audit log detail', error, { adminId: req.user?._id, auditLogId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to load audit log entry', 500));
  }
};

const getAuditLogsSummary = async (req, res) => {
  try {
    const summary = await systemAdminOperationsService.getAuditLogsSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin audit logs summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load audit logs summary', 500));
  }
};

export {
  listJobs,
  getJobDetail,
  getJobsSummary,
  listWebhooks,
  getWebhookDetail,
  getWebhooksSummary,
  listAuditLogs,
  getAuditLogDetail,
  getAuditLogsSummary,
};
