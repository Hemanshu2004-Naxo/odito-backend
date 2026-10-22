import mongoose from 'mongoose';

/**
 * SocialApprovalSettings — the minimum per-project configuration the content
 * approval workflow needs: which review stages are REQUIRED.
 *
 *   contentApprovalRequired  true  -> a submitted post waits in content_review
 *                            false -> its content is auto-approved at submit
 *   designApprovalRequired   true  -> approved content waits in design_review
 *                            false -> its design is auto-approved
 *
 * One document per project (unique index), created lazily with the defaults
 * below — "nothing publishes without approval" is the product's stated
 * default, so both stages are required until a project turns one off. The
 * values are read by the BACKEND approval service; no client decides stage
 * routing. This is deliberately not the full Settings backend (brand kit,
 * auto-publish, team members have none yet) — only what the workflow needs.
 */
const socialApprovalSettingsSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    unique: true,
  },
  contentApprovalRequired: { type: Boolean, default: true },
  designApprovalRequired: { type: Boolean, default: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

export const APPROVAL_SETTING_DEFAULTS = Object.freeze({ contentApprovalRequired: true, designApprovalRequired: true });

const SocialApprovalSettings = mongoose.model('SocialApprovalSettings', socialApprovalSettingsSchema);
export default SocialApprovalSettings;
