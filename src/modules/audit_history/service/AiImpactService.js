import mongoose from 'mongoose';
import Task from '../../tasks/model/Task.js';
import Recommendation from '../../recommendations/model/Recommendation.js';

const KNOWN_ORIGINS = ['ai_fix', 'diy_guide', 'auditiq', 'manual'];

class AiImpactService {

  async getAiImpact(projectId) {
    const oid = new mongoose.Types.ObjectId(projectId);

    const [taskResult, recsGenerated, qualityResult] = await Promise.all([

      // Task aggregation — three facets in one pass
      Task.aggregate([
        { $match: { projectId: oid } },
        {
          $facet: {
            byStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            byOriginStatus: [
              {
                $group: {
                  _id: {
                    origin: { $ifNull: ['$origin', 'manual'] },
                    status: '$status',
                  },
                  count: { $sum: 1 },
                },
              },
            ],
            withRec: [
              { $match: { recommendationId: { $ne: null } } },
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
          },
        },
      ]),

      // Total recommendations ever generated for this project
      Recommendation.countDocuments({ projectId: oid }),

      // Quality breakdown — only active (non-invalidated) recs
      Recommendation.aggregate([
        { $match: { projectId: oid, invalidatedAt: null } },
        {
          $facet: {
            bySource: [
              {
                $group: {
                  _id: { $ifNull: ['$generatedBy', 'unknown'] },
                  count: { $sum: 1 },
                },
              },
            ],
            byTier: [
              {
                $group: {
                  _id: { $ifNull: ['$sections.confidence.tier', 'unknown'] },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]),
    ]);

    // ── Task summary by status ──────────────────────────────────────────────────
    const facet = taskResult[0] || { byStatus: [], byOriginStatus: [], withRec: [] };

    const byStatus = {};
    for (const r of facet.byStatus) byStatus[r._id] = r.count;

    const withRecByStatus = {};
    for (const r of facet.withRec) withRecByStatus[r._id] = r.count;

    // AI-recommendation impact metrics
    const applied  = (withRecByStatus.implemented    || 0)
                   + (withRecByStatus.verified_fixed  || 0)
                   + (withRecByStatus.reopened        || 0);
    const verified = withRecByStatus.verified_fixed || 0;
    const reopened = withRecByStatus.reopened       || 0;
    const successRate = applied > 0
      ? Math.round((verified / applied) * 1000) / 10
      : 0;

    // ── Origin breakdown ────────────────────────────────────────────────────────
    const originMap = {};
    for (const r of facet.byOriginStatus) {
      const origin = r._id.origin;
      const status = r._id.status;
      if (!originMap[origin]) {
        originMap[origin] = {
          origin,
          task_created:  0,
          implemented:   0,
          verified_fixed: 0,
          reopened:      0,
          total:         0,
        };
      }
      originMap[origin][status] = (originMap[origin][status] || 0) + r.count;
      originMap[origin].total  += r.count;
    }
    for (const o of KNOWN_ORIGINS) {
      if (!originMap[o]) {
        originMap[o] = { origin: o, task_created: 0, implemented: 0, verified_fixed: 0, reopened: 0, total: 0 };
      }
    }

    // ── Quality breakdown ───────────────────────────────────────────────────────
    const qualityFacet = qualityResult[0] || { bySource: [], byTier: [] };
    const bySource = {};
    const byTier   = {};
    for (const r of qualityFacet.bySource) bySource[r._id] = r.count;
    for (const r of qualityFacet.byTier)   byTier[r._id]   = r.count;

    return {
      recommendations: {
        generated: recsGenerated,
        applied,
        verified,
        reopened,
        successRate,
      },
      taskSummary: {
        task_created:   byStatus.task_created   || 0,
        implemented:    byStatus.implemented    || 0,
        verified_fixed: byStatus.verified_fixed || 0,
        reopened:       byStatus.reopened       || 0,
        total: Object.values(byStatus).reduce((s, n) => s + n, 0),
      },
      originBreakdown: Object.values(originMap),
      qualityBreakdown: { bySource, byTier },
    };
  }
}

export default new AiImpactService();
