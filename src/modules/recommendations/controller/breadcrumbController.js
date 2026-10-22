import mongoose from 'mongoose';
import { discoverBreadcrumbs, inspectPagesBreadcrumbs } from '../../schema-evidence/breadcrumbs/breadcrumbDiscovery.js';

/**
 * HTTP layer of the breadcrumb discovery that runs BEFORE any task exists. Read-only: nothing is written to WordPress, no audit or job is
 * started and no credit is used. Applying stays the task-bound, approved step (POST /tasks/:taskId/apply-wordpress).
 *
 * Authentication and project ownership run before these handlers (router.use(auth) + validateProjectAccess). Beyond that they trust nothing
 * from the client: the page must be one of THIS project's crawled pages, and no client-supplied URL is ever requested — the pages that get
 * fetched are the audited page, the site's home page and same-path parents taken from the project's own crawl.
 */

const MAX_BODY_BYTES = 8 * 1024;
const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; } };

function sendError(res, event, error) {
  console.error(`[BREADCRUMB_CTRL] ${event} error: ${error.message}`);
  return res.status(500).json({ success: false, message: 'Failed to process the breadcrumb request' });
}

/** POST /recommendations/breadcrumb/discovery  { projectId, pageUrl, refresh? } */
export async function discoverBreadcrumbTrail(req, res) {
  try {
    if (Number(req.get?.('content-length') || 0) > MAX_BODY_BYTES) return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
    const { projectId, pageUrl } = req.body || {};
    if (typeof pageUrl !== 'string' || !pageUrl.trim() || pageUrl.length > 2048) return res.status(400).json({ success: false, code: 'PAGE_URL_REQUIRED', message: 'pageUrl is required.' });
    const pid = toObjectId(projectId);
    if (!pid) return res.status(400).json({ success: false, code: 'PROJECT_REQUIRED', message: 'projectId is required.' });
    const page = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: pid, url: pageUrl }, { projection: { url: 1 } });
    if (!page) return res.status(404).json({ success: false, code: 'PAGE_NOT_FOUND', message: 'This page is not part of the project\'s latest crawl.' });
    const data = await discoverBreadcrumbs({ projectId: pid, pageUrl: page.url, refresh: req.body?.refresh === true });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, 'discoverBreadcrumbTrail', error);
  }
}

/**
 * POST /recommendations/breadcrumb/pages  { projectId }
 * Classifies EVERY page that has an open breadcrumb finding, each from its own live markup (bounded). The URLs come from the project's
 * own issue records, never from the request.
 */
export async function classifyBreadcrumbPages(req, res) {
  try {
    if (Number(req.get?.('content-length') || 0) > MAX_BODY_BYTES) return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
    const pid = toObjectId(req.body?.projectId);
    if (!pid) return res.status(400).json({ success: false, code: 'PROJECT_REQUIRED', message: 'projectId is required.' });
    const rows = await mongoose.connection.db.collection('seo_page_issues')
      .find({ projectId: pid, status: 'open', $or: [{ rule_id: 'breadcrumblist_schema' }, { issue_code: 'breadcrumblist_schema' }] })
      .project({ page_url: 1 }).limit(200).toArray();
    const urls = [...new Set(rows.map((r) => r.page_url).filter(Boolean))];
    const pages = await inspectPagesBreadcrumbs({ urls });
    const counts = pages.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
    return res.status(200).json({ success: true, data: { total: urls.length, checked: pages.length, counts, pages: pages.map((p) => ({ url: p.url, status: p.status, itemCount: p.items.length, problems: p.problems, reason: p.reason })) } });
  } catch (error) {
    return sendError(res, 'classifyBreadcrumbPages', error);
  }
}

export default { discoverBreadcrumbTrail, classifyBreadcrumbPages };
