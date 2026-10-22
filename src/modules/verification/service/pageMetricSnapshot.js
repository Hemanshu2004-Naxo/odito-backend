import mongoose from 'mongoose';

/**
 * Reads the CURRENT per-page metric snapshot for a project/URL from
 * seo_page_scores and ai_scores. Used to capture PageVerificationRun's
 * `before` snapshot at verification-start time (urlVerificationService)
 * and mirrored independently (not imported) by VerificationFinalizer's
 * own `after`-collection step, since VerificationFinalizer.js is a
 * frozen, untouched file for this task — this is a deliberate, small
 * duplication rather than a shared import into that file.
 */
export async function collectPageMetricSnapshot(projectId, pageUrl) {
  const db = mongoose.connection.db;

  const [pageScoreDoc, aiScoreDoc] = await Promise.all([
    db.collection('seo_page_scores').findOne({ projectId, page_url: pageUrl }),
    db.collection('ai_scores').findOne({ project_id: projectId, url: pageUrl }),
  ]);

  return {
    pageScore: pageScoreDoc?.page_score ?? null,
    aisoScore: aiScoreDoc?.hubs?.aiso?.score ?? null,
    aeoScore: aiScoreDoc?.hubs?.aeo?.score ?? null,
    geoScore: aiScoreDoc?.hubs?.geo?.score ?? null,
    criticalIssues: pageScoreDoc?.high_issues_count ?? 0,
    warningIssues: pageScoreDoc?.medium_issues_count ?? 0,
    infoIssues: pageScoreDoc?.low_issues_count ?? 0,
  };
}

export default collectPageMetricSnapshot;
