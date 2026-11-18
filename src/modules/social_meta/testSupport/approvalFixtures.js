import SocialPublication from '../model/SocialPublication.js';
import SocialApprovalSettings from '../model/SocialApprovalSettings.js';

/**
 * Test fixtures for the approval workflow.
 *
 * Since text posts skip design review, approving the content of a Facebook post without media makes it fully approved (design_approved).
 * A post whose content is approved and which still WAITS for a design (content_approved) is, in production, an Instagram post without
 * media - or a text post approved before that rule. Tests about "a post waiting for its design" (AI design generation, the studio, the
 * gates) use a Facebook fixture, so they build that state directly with this helper.
 */
export async function asWaitingForDesign(publicationId) {
  // with design approval switched off a post is approved with its content whatever it holds: nothing to build
  const pub = await SocialPublication.findById(publicationId).select('project_id').lean();
  const settings = pub ? await SocialApprovalSettings.findOne({ project_id: pub.project_id }).lean() : null;
  if (settings && settings.designApprovalRequired === false) return;
  await SocialPublication.updateOne(
    { _id: publicationId, approvalState: 'design_approved' },
    { $set: { approvalState: 'content_approved', designApprovedAt: null, designApprovedBy: null, designApprovedVersion: null, designSubmittedAt: null, designSubmittedBy: null } },
  );
}

/** Puts a post with no media into design review (the state a post with media reaches when its content is approved). */
export async function asInDesignReview(publicationId, userId) {
  await SocialPublication.updateOne(
    { _id: publicationId, approvalState: { $in: ['content_approved', 'design_approved'] } },
    { $set: { approvalState: 'design_review', designSubmittedAt: new Date(), designSubmittedBy: userId, designApprovedAt: null, designApprovedBy: null, designApprovedVersion: null } },
  );
}

export default { asWaitingForDesign, asInDesignReview };
