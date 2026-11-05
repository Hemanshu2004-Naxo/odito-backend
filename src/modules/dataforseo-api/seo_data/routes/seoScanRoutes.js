import express from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import auth from '../../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../../middleware/auth.middleware.js';
import { postScan, getLatestScan, listScans, getScan, getSnapshots, getComparison } from '../controller/seoScanController.js';
import { datasetStatus, datasetChanges, keywordHistoryRoute, listKeywords, listBacklinks, listReferringDomains, listDerived, datasetFreshness, usageSummary } from '../controller/seoDatasetController.js';
import { SCAN_START_LIMIT } from '../config.js';

/**
 * Mounted at /api/projects (routes/index.js), next to the domain-overview routes:
 *   POST /api/projects/:projectId/seo-scans                         start an explicit scan (the only call here that can buy provider data)
 *   GET  /api/projects/:projectId/seo-scans[/latest|/:scanId]       scan status / audit trail (MongoDB only)
 *   GET  /api/projects/:projectId/seo-snapshots[/comparison]        stored history and week / month comparison (MongoDB only)
 *   GET  /api/projects/:projectId/seo-datasets[/keywords|backlinks|referring-domains|anchors|pages|changes|keywords/history]   stored row sets (MongoDB only)
 */
const router = express.Router();

const userKey = (req) => String(req.user?._id || 'anonymous');
const limiterOptions = { standardHeaders: true, legacyHeaders: false, keyGenerator: userKey };
const readLimiter = rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, max: 600, message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } });
const startLimiter = rateLimit({ ...limiterOptions, windowMs: SCAN_START_LIMIT.windowMs, max: SCAN_START_LIMIT.max, message: { success: false, code: 'RATE_LIMITED', message: 'Too many scans. Please wait a few minutes and try again.' } });

function requireValidProjectId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.projectId)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'projectId', message: 'A valid projectId is required' });
  }
  return next();
}

const projectScoped = [auth, readLimiter, requireValidProjectId, validateProjectAccess()];
router.post('/:projectId/seo-scans', ...projectScoped, startLimiter, postScan);
router.get('/:projectId/seo-scans/latest', ...projectScoped, getLatestScan);
router.get('/:projectId/seo-scans', ...projectScoped, listScans);
router.get('/:projectId/seo-scans/:scanId', ...projectScoped, getScan);
router.get('/:projectId/seo-snapshots/comparison', ...projectScoped, getComparison);
router.get('/:projectId/seo-snapshots', ...projectScoped, getSnapshots);

// Stored row-level datasets (MongoDB only; none of these can reach the provider).
router.get('/:projectId/seo-datasets', ...projectScoped, datasetStatus);
router.get('/:projectId/seo-datasets/freshness', ...projectScoped, datasetFreshness);
router.get('/:projectId/seo-datasets/changes', ...projectScoped, datasetChanges);
router.get('/:projectId/seo-datasets/keywords/history', ...projectScoped, keywordHistoryRoute);
router.get('/:projectId/seo-datasets/keywords', ...projectScoped, listKeywords);
router.get('/:projectId/seo-datasets/backlinks', ...projectScoped, listBacklinks);
router.get('/:projectId/seo-datasets/referring-domains', ...projectScoped, listReferringDomains);
router.get('/:projectId/seo-datasets/anchors', ...projectScoped, listDerived('anchors'));
router.get('/:projectId/seo-datasets/pages', ...projectScoped, listDerived('pages'));

// Provider request accounting (what scans and explicit refreshes really bought).
router.get('/:projectId/seo-usage', ...projectScoped, usageSummary);

export default router;
