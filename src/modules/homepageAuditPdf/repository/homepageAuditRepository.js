import mongoose from 'mongoose';
import HomepageAudit from '../../external/model/HomepageAudit.js';

/**
 * Sole data-access point for HomepageAudit documents within the Homepage
 * Audit PDF module. Controllers and services must never import the
 * HomepageAudit model directly — always go through this repository, so
 * caching and permission checks can be added here later without touching
 * any caller.
 */
class HomepageAuditRepository {
  isValidObjectId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
  }

  /**
   * @param {string} auditId - Caller must validate via isValidObjectId() first.
   * @returns {Promise<object|null>} Plain object (lean), or null if not found.
   */
  async getById(auditId) {
    // TODO(caching): PDF generation is read-heavy against a document that
    // rarely changes once its async PATCH operations settle — a short-TTL
    // cache (in-memory or Redis) belongs here, not in the service/controller.
    // TODO(permissions): if Homepage Audit PDF later gains user-scoped
    // access control, accept a requestingUserId param here and check it
    // against the document's user_id, so every caller gets it uniformly
    // instead of each controller re-implementing the check.
    return HomepageAudit.findById(auditId).lean();
  }

  async exists(auditId) {
    if (!this.isValidObjectId(auditId)) return false;
    const doc = await HomepageAudit.exists({ _id: auditId });
    return Boolean(doc);
  }

  /**
   * Update PDF generation metadata for a HomepageAudit document.
   *
   * @param {string} auditId
   * @param {object} pdfData
   * @returns {Promise<object|null>} The updated document (lean).
   */
  async updatePdf(auditId, pdfData) {
    if (!this.isValidObjectId(auditId)) return null;
    return HomepageAudit.findByIdAndUpdate(
      auditId,
      { $set: { pdf: pdfData } },
      { new: true }
    ).lean();
  }
}

export default HomepageAuditRepository;
