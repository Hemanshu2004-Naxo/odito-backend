import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * AIVisibilityExtractor
 *
 * Fetches seo_ai_visibility (extracted signals) for a specific page.
 *
 * Phase 4: used to also query seo_ai_visibility_issues (scored rule
 * failures) — that collection is confirmed dead (exhaustive repo-wide
 * audit: zero writers, no model, no reachable frontend/API dependency; see
 * project_ai_visibility_cleanup memory / Phase 4 report). The query always
 * returned zero rows, and this extractor's only caller already tolerates
 * an empty visibilityIssues/issuesByRuleId (it's only reachable today for
 * legacy pre-V2 rule_ids that nothing currently sends), so returning empty
 * results directly — instead of running a query that could only ever
 * return empty — changes nothing observable while dropping a wasted DB
 * round-trip.
 */
export class AIVisibilityExtractor {
  constructor() {
    this.name = 'ai_visibility';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const visibilityData = await db.collection('seo_ai_visibility').findOne(
      { projectId: projectIdObj, page_url: pageUrl },
      {
        projection: {
          structured_data: 1,
          heading_metrics: 1,
          content_metrics: 1,
          metadata: 1,
          links: 1,
          images: 1,
          page_type_properties: 1,
          normalized_signals: 1,
          ai_visibility: 1,
        },
      }
    );

    return { visibilityData, visibilityIssues: [], issuesByRuleId: {} };
  }
}

export default new AIVisibilityExtractor();
