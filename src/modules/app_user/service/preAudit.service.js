import HomepageAudit from '../../external/model/HomepageAudit.js';
import SeoProject from '../model/SeoProject.js';

export class PreAuditService {
  async getPreAudit(projectId, userId) {
    const project = await SeoProject.findOne({ _id: projectId, user_id: userId })
      .select('pre_audit_id')
      .lean();

    if (!project) return null;
    if (!project.pre_audit_id) return { exists: false };

    const audit = await HomepageAudit.findById(project.pre_audit_id)
      .select('snapshot score created_at url')
      .lean();

    if (!audit) return { exists: false };

    return {
      exists: true,
      audit_id: audit._id,
      url: audit.url,
      score: audit.score,
      snapshot: audit.snapshot,
      audited_at: audit.created_at
    };
  }
}
