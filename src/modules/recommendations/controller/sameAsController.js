import mongoose from 'mongoose';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import organizationFixService from '../../external_integration/schemaFix/organizationFixService.js';
import { discoverSameAsProfiles } from '../../schema-evidence/sameAs/sameAsDiscovery.js';
import { PROFILE_LIMITS, validateProfileList } from '../../schema-evidence/sameAs/profileUrl.js';
import { SAMEAS_ISSUE_KEY } from '../../external_integration/schemaFix/sameAsFixPlan.js';

/**
 * HTTP layer of the Organization sameAs workflow that runs BEFORE a task exists: discover candidate profiles, validate what the
 * owner typed, and preview the exact change. All three are read-only — they write nothing to WordPress, start no audit or job and
 * charge no credit. Applying is a separate, approved, task-bound step (POST /tasks/:taskId/apply-wordpress).
 *
 * Authentication and project ownership run before these handlers (router.use(auth) + validateProjectAccess). Beyond that they trust
 * nothing from the client: the page must be one of THIS project's crawled pages, every URL is validated server-side, and no
 * client-supplied URL is ever requested.
 */

const MAX_BODY_BYTES = 16 * 1024;

const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; } };

/** Resolves the audited page inside THIS project's crawl; writes the response and returns null when it cannot. */
async function loadProjectPage(req, res) {
  const declared = Number(req.get?.('content-length') || 0);
  if (declared > MAX_BODY_BYTES) { res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' }); return null; }
  const { projectId, pageUrl } = req.body || {};
  if (typeof pageUrl !== 'string' || !pageUrl.trim() || pageUrl.length > 2048) {
    res.status(400).json({ success: false, code: 'PAGE_URL_REQUIRED', message: 'pageUrl is required.' });
    return null;
  }
  const pid = toObjectId(projectId);
  if (!pid) { res.status(400).json({ success: false, code: 'PROJECT_REQUIRED', message: 'projectId is required.' }); return null; }
  const page = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: pid, url: pageUrl }, { projection: { url: 1 } });
  if (!page) {
    res.status(404).json({ success: false, code: 'PAGE_NOT_FOUND', message: 'This page is not part of the project\'s latest crawl.' });
    return null;
  }
  return { pid, pageUrl: page.url };
}

const listOf = (value) => {
  if (value === undefined || value === null) return [];
  return value;
};

function sendError(res, event, error) {
  if (error instanceof WordPressConnectionError) {
    return res.status(error.statusCode || 502).json({ success: false, message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  console.error(`[SAMEAS_CTRL] ${event} error: ${error.message}`);
  return res.status(500).json({ success: false, message: 'Failed to process the sameAs request' });
}

/** POST /recommendations/same-as/discovery  { projectId, pageUrl, refresh? } */
export async function discoverSameAs(req, res) {
  try {
    const found = await loadProjectPage(req, res);
    if (!found) return;
    const data = await discoverSameAsProfiles({ projectId: found.pid, pageUrl: found.pageUrl, refresh: req.body?.refresh === true });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, 'discoverSameAs', error);
  }
}

/**
 * POST /recommendations/same-as/validate  { projectId, pageUrl, urls }
 * Pure validation of the owner's typed links: per-line errors and the normalized form of each valid one. Fetches nothing.
 */
export async function validateSameAsUrls(req, res) {
  try {
    const found = await loadProjectPage(req, res);
    if (!found) return;
    const urls = listOf(req.body?.urls);
    const checked = validateProfileList(urls, { siteUrl: (() => { try { return `${new URL(found.pageUrl).origin}/`; } catch { return undefined; } })(), source: 'manual', max: PROFILE_LIMITS.maxProfilesPerRequest });
    return res.status(200).json({
      success: true,
      data: {
        valid: checked.valid,
        errors: checked.errors,
        items: checked.items.map((i) => ({ url: i.url, platform: i.platform, platformLabel: i.platformLabel, kind: i.kind, warnings: i.warnings, normalized: i.normalized })),
      },
    });
  } catch (error) {
    return sendError(res, 'validateSameAsUrls', error);
  }
}

/** POST /recommendations/same-as/preview  { projectId, pageUrl, urls, removeUrls? } — the read-only plan, before a task exists. */
export async function previewSameAs(req, res) {
  try {
    const found = await loadProjectPage(req, res);
    if (!found) return;
    const data = await organizationFixService.getOrganizationFixPreview(
      { projectId: found.pid, pageUrl: found.pageUrl, issueKey: SAMEAS_ISSUE_KEY },
      {},
      { urls: listOf(req.body?.urls), removeUrls: listOf(req.body?.removeUrls) },
    );
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, 'previewSameAs', error);
  }
}

export default { discoverSameAs, validateSameAsUrls, previewSameAs };
