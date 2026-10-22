import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * HeadlessExtractor
 *
 * Fetches seo_headless_data for a specific page.
 * Contains axe-core violations, contrast ratios, keyboard accessibility data.
 */
export class HeadlessExtractor {
  constructor() {
    this.name = 'headless';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    // seo_headless_data is keyed by `url` (see HeadlessData.js) and stores the audit as
    // keyboard_analysis / axeViolations / domMetrics. This used to query a non-existent
    // `page_url` field and project non-existent snake_case fields, so it ALWAYS returned
    // null and every accessibility resolver fell back to the one-line diagnostic string.
    // Trailing-slash variants are tried because crawl URLs are not always normalised.
    const bare = pageUrl.replace(/\/+$/, '');
    const headlessData = await db.collection('seo_headless_data').findOne(
      { projectId: projectIdObj, url: { $in: [pageUrl, bare, `${bare}/`] } },
      {
        projection: {
          url: 1,
          scannedAt: 1,
          keyboard_analysis: 1,
          axeViolations: 1,
          domMetrics: 1,
        },
      }
    );

    return { headlessData };
  }
}

export default new HeadlessExtractor();
