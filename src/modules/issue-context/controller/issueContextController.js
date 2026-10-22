import IssueContextEngine from '../service/IssueContextEngine.js';
import { isKnownIssue } from '../service/ResolverRegistry.js';

/**
 * Issue Context Controller
 *
 * Express handlers for the Issue Context Engine API.
 * Returns IssueContext objects — no recommendations, no AI.
 */

/**
 * GET /issue-context/:projectId/:issueId?pageUrl=
 *
 * Resolve context for a single issue + page.
 */
export async function getIssueContext(req, res) {
  try {
    const { projectId, issueId } = req.params;
    const { pageUrl } = req.query;

    console.log(`[ISSUE_CONTEXT_CTRL] GET /${projectId}/${issueId} | pageUrl=${pageUrl || 'none'}`);

    if (!projectId || !issueId) {
      return res.status(400).json({
        success: false,
        message: 'projectId and issueId are required',
      });
    }

    if (!pageUrl) {
      return res.status(400).json({
        success: false,
        message: 'pageUrl query parameter is required',
      });
    }

    const decodedUrl = decodeURIComponent(pageUrl);
    const context = await IssueContextEngine.resolve(projectId, issueId, decodedUrl);

    return res.status(200).json({
      success: true,
      data: context,
      meta: {
        resolutionMs: context.metadata.resolutionMs,
        readinessScore: context.metadata.readinessScore,
        recommendationReady: context.recommendationReady,
      },
    });
  } catch (error) {
    console.error('[ISSUE_CONTEXT_CTRL] getIssueContext error:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to resolve issue context',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined,
    });
  }
}

/**
 * POST /issue-context/batch
 *
 * Resolve context for multiple pages of the same issue.
 *
 * Body:
 *   - projectId  (required)
 *   - issueId    (required)
 *   - pageUrls   (required) string[]
 *   - concurrency (optional, default 10, max 20)
 */
export async function batchIssueContext(req, res) {
  try {
    const { projectId, issueId, pageUrls, concurrency = 10 } = req.body;

    console.log(`[ISSUE_CONTEXT_CTRL] POST /batch | issueId=${issueId} | pages=${pageUrls?.length}`);

    if (!projectId || !issueId || !Array.isArray(pageUrls) || pageUrls.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'projectId, issueId, and pageUrls[] are required',
      });
    }

    if (pageUrls.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 100 pages per batch request',
      });
    }

    const safeConcurrency = Math.min(Math.max(1, concurrency), 20);
    const contexts = await IssueContextEngine.resolveBatch(
      projectId, issueId, pageUrls, safeConcurrency
    );

    return res.status(200).json({
      success: true,
      data: contexts,
      meta: {
        total: contexts.length,
        readyCount: contexts.filter(c => c.recommendationReady).length,
      },
    });
  } catch (error) {
    console.error('[ISSUE_CONTEXT_CTRL] batchIssueContext error:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to resolve batch issue context',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined,
    });
  }
}

/**
 * GET /issue-context/registry-check/:issueId
 *
 * Quick check: is this issueId supported?
 * Useful for debugging.
 */
export async function registryCheck(req, res) {
  const { issueId } = req.params;
  return res.status(200).json({
    success: true,
    data: {
      issueId,
      supported: isKnownIssue(issueId),
    },
  });
}
