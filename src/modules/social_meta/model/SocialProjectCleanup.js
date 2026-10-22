import mongoose from 'mongoose';

/**
 * SocialProjectCleanup - a small, NON-SENSITIVE record that a project's social connections were removed, and what (if
 * anything) the account owner still has to do on the provider's side.
 *
 * Why it exists: Odito can destroy its own copy of a Page access token, but it cannot ask Meta to revoke it - revoking needs
 * the connecting USER's token, which Odito deliberately never keeps after Page selection. So a purge leaves Meta's grant in
 * place, and this record is the durable, actionable trace of that ("remove Odito from Facebook > Business Integrations").
 *
 * It holds no token, no secret and no content - only public account ids and a status - and is deliberately NOT in the
 * project cascade registry (it must outlive the project). It expires on its own (TTL).
 */
export const EXTERNAL_REVOCATION = Object.freeze({
  NOT_SUPPORTED: 'not_supported', // no provider API is available with the credential Odito holds
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const RETENTION_DAYS = 180;

const accountSchema = new mongoose.Schema({
  platform: { type: String, required: true },
  platformAccountId: { type: String, required: true },
  externalRevocation: { type: String, enum: Object.values(EXTERNAL_REVOCATION), required: true },
}, { _id: false });

const socialProjectCleanupSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  completedAt: { type: Date, required: true },
  accounts: { type: [accountSchema], default: [] },
  counts: {
    accounts: { type: Number, default: 0 },
    publications: { type: Number, default: 0 },
    scheduledPublications: { type: Number, default: 0 },
  },
  // Plain-language next step for the owner; null when nothing is left to do.
  actionRequired: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_cleanup_records',
});

socialProjectCleanupSchema.index({ project_id: 1 }, { unique: true, name: 'unique_social_cleanup_project' });
socialProjectCleanupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'social_cleanup_ttl' });

export const cleanupExpiry = (from = new Date()) => new Date(from.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

const SocialProjectCleanup = mongoose.model('SocialProjectCleanup', socialProjectCleanupSchema);
export default SocialProjectCleanup;
