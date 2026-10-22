import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * TechnicalReportExtractor
 *
 * Fetches domain_technical_reports — robots.txt rules,
 * XML sitemap status, HTTPS enforcement data.
 * This is project-scoped (not per-page).
 */
export class TechnicalReportExtractor {
  constructor() {
    this.name = 'technical';
  }

  async extract(projectId, _pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const technicalReport = await db.collection('domain_technical_reports').findOne(
      { projectId: projectIdObj },
      {
        projection: {
          robots_txt: 1,
          sitemap: 1,
          https_enforced: 1,
          blocked_resources: 1,
          ssl_valid: 1,
          frameworkType: 1,
        },
      }
    );

    // Normalize frameworkType into the flat string the recommendation engine expects.
    // Both the new structured format { name, key, confidence, source } and any
    // legacy plain-string values are handled here.
    let framework = null;
    if (technicalReport?.frameworkType) {
      const ft = technicalReport.frameworkType;
      framework = typeof ft === 'object' ? (ft.key || ft.name || null) : String(ft);
      if (framework) framework = framework.toLowerCase();
    }

    return { technicalReport, framework };
  }
}

export default new TechnicalReportExtractor();
