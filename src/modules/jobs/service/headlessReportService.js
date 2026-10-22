import HeadlessData from '../model/HeadlessData.js';

/**
 * Persists a HEADLESS_ACCESSIBILITY worker report (one document per project+URL,
 * upserted). Extracted from the /jobs/headless-accessibility-report route so the
 * exact production write path can be tested against the real schema — the
 * schema's strict mode decides which of the worker's fields survive.
 */

/** Maps one worker result to the document that is $set on the (project, url) upsert. */
export function buildHeadlessDocument(projectId, seoJobId, result) {
  return {
    projectId,
    jobId: seoJobId,
    url: result.url,
    render_status: result.render_status,
    statusCode: result.statusCode,
    axeViolations: result.axeViolations || [],
    axeViolationCount: result.axeViolationCount || 0,
    axePassedCount: result.axePassedCount || 0,
    domMetrics: result.domMetrics || {},
    error: result.error || null,
    keyboard_analysis: result.keyboard_analysis || null,
    scannedAt: result.scannedAt ? new Date(result.scannedAt) : new Date(),
  };
}

export async function storeHeadlessReport({ projectId, seo_jobId: seoJobId, results }) {
  const bulkOps = results.map((result) => {
    const doc = buildHeadlessDocument(projectId, seoJobId, result);
    return {
      updateOne: {
        filter: { projectId: doc.projectId, url: doc.url },
        update: { $set: doc },
        upsert: true,
      },
    };
  });
  return HeadlessData.bulkWrite(bulkOps);
}

export default { buildHeadlessDocument, storeHeadlessReport };
