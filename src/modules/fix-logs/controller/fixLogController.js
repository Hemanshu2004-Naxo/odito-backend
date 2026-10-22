import mongoose from 'mongoose';
import AuditFixLog from '../model/AuditFixLog.js';

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}

/**
 * POST /fix-logs/fix
 *
 * Creates a fix log record. Idempotent — returns the existing record if already fixed
 * for the same projectId + issueKey + pageUrl combination.
 */
export async function markFixed(req, res) {
  try {
    console.log('[FIX_LOG] FIX REQUEST', req.body);
    const { projectId, auditId, issueKey, issueName, issueCategory, pageUrl, aiRecommendationId } = req.body;

    if (!projectId || !issueKey || !pageUrl) {
      return res.status(400).json({
        success: false,
        message: 'projectId, issueKey, and pageUrl are required',
      });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    // Idempotency — if there's already an active fixed record, return it
    const existing = await AuditFixLog.findOne({ projectId: pid, issueKey, pageUrl, status: 'fixed' });
    if (existing) {
      console.log('[FIX_LOG] Already fixed — returning existing record', existing._id);
      return res.status(200).json({ success: true, data: existing, alreadyFixed: true });
    }

    console.log('[FIX_LOG] CREATING FIX LOG for', { projectId: pid, issueKey, pageUrl });
    const log = await AuditFixLog.create({
      projectId:          pid,
      auditId:            auditId            || undefined,
      issueKey,
      issueName:          issueName          || issueKey,
      issueCategory:      issueCategory      || '',
      pageUrl,
      status:             'fixed',
      fixedAt:            new Date(),
      aiRecommendationId: aiRecommendationId || undefined,
    });
    console.log('[FIX_LOG] CREATED FIX LOG', log._id.toString());

    return res.status(201).json({ success: true, data: log });
  } catch (error) {
    console.error('[FIX_LOG] markFixed error:', error.message, error.stack);
    return res.status(500).json({ success: false, message: 'Failed to mark as fixed' });
  }
}

/**
 * POST /fix-logs/reopen
 *
 * Updates an existing fix log to status=reopened. Keeps full history intact.
 */
export async function reopenIssue(req, res) {
  try {
    const { fixLogId } = req.body;

    if (!fixLogId) {
      return res.status(400).json({ success: false, message: 'fixLogId is required' });
    }

    const log = await AuditFixLog.findByIdAndUpdate(
      fixLogId,
      { status: 'reopened', reopenedAt: new Date() },
      { new: true }
    );

    if (!log) {
      return res.status(404).json({ success: false, message: 'Fix log not found' });
    }

    return res.status(200).json({ success: true, data: log });
  } catch (error) {
    console.error('[FIX_LOG] reopenIssue error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to reopen issue' });
  }
}

/**
 * GET /fix-logs?projectId=&auditId=&issueKey=&status=&search=&page=&limit=
 *
 * Paginated list of fix logs for the History Logs page.
 */
export async function getFixLogs(req, res) {
  try {
    const { projectId, auditId, issueKey, status, search, page = 1, limit = 50 } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    const query = { projectId: pid };
    if (auditId)   query.auditId  = auditId;
    if (issueKey)  query.issueKey = issueKey;
    if (status)    query.status   = status;
    if (search) {
      query.$or = [
        { pageUrl:    { $regex: search, $options: 'i' } },
        { issueName:  { $regex: search, $options: 'i' } },
        { issueKey:   { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      AuditFixLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      AuditFixLog.countDocuments(query),
    ]);

    console.log('[FIX_LOG] HISTORY QUERY RESULT', { projectId: pid, total, page, returned: logs.length });

    return res.status(200).json({
      success: true,
      data: {
        logs,
        pagination: {
          page:  parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    console.error('[FIX_LOG] getFixLogs error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch fix logs' });
  }
}

/**
 * GET /fix-logs/fixed-urls?projectId=&issueKey=
 *
 * Lightweight endpoint used by the issue detail page to filter out fixed URLs
 * from the Affected URLs list and compute the fixed counter.
 */
export async function getFixedUrls(req, res) {
  try {
    const { projectId, issueKey } = req.query;

    if (!projectId || !issueKey) {
      return res.status(400).json({ success: false, message: 'projectId and issueKey are required' });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    const fixedUrls = await AuditFixLog.distinct('pageUrl', {
      projectId: pid,
      issueKey,
      status: 'fixed',
    });

    console.log('[FIX_LOG] FIXED URLS for', { projectId: pid, issueKey, count: fixedUrls.length });

    return res.status(200).json({
      success: true,
      data: { fixedUrls, fixedCount: fixedUrls.length },
    });
  } catch (error) {
    console.error('[FIX_LOG] getFixedUrls error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch fixed URLs' });
  }
}
