import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * V2IssueExtractor
 *
 * Fetches the ai_issues document and the ai_pages document for a given
 * V2 rule ID + URL combination.
 *
 * Used exclusively by IssueContextEngine._resolveV2() — called only when
 * issueId matches the AISO-*, AEO-*, or GEO-* pattern.
 *
 * Collections queried:
 *   ai_projects   — to get the latest job_id for the project
 *   ai_issues     — the V2 issue document (evidence, recommendation, etc.)
 *   ai_pages      — the V2 page document (framework, CMS, page type)
 */
class V2IssueExtractor {
  async extract(projectId, ruleId, pageUrl) {
    const db  = mongoose.connection.db;
    const pid = new ObjectId(projectId);

    // Resolve the latest job for this project so we query the freshest data.
    const latestJob = await db.collection('ai_projects')
      .find({ project_id: pid })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();

    const jobId = latestJob?.job_id ?? null;

    // Build queries — always include project_id and rule_id; add job_id when known.
    const issueFilter = jobId
      ? { project_id: pid, job_id: jobId, rule_id: ruleId, url: pageUrl }
      : { project_id: pid, rule_id: ruleId, url: pageUrl };

    const pageFilter = jobId
      ? { project_id: pid, job_id: jobId, url: pageUrl }
      : { project_id: pid, url: pageUrl };

    const [issueDoc, pageDoc] = await Promise.all([
      db.collection('ai_issues').findOne(issueFilter),

      db.collection('ai_pages').findOne(pageFilter, {
        projection: {
          url:                    1,
          'meta.title':           1,
          'meta.description':     1,
          word_count:             1,
          technical:              1,
          page_type_properties:   1,
          'crawlability.status_code': 1,
        },
      }),
    ]);

    return { issueDoc, pageDoc, jobId };
  }
}

export default new V2IssueExtractor();
