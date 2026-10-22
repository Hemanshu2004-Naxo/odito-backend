import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * SocialAccount
 *
 * Phase 2 — a real, persisted connection between an Odito project and a
 * specific Facebook Page (Instagram in Phase 3 will use this same model:
 * platform: 'instagram', with instagramBusinessAccountId set). One
 * document per connected platform account, unlike GoogleConnection's
 * one-per-purpose shape — a project can have multiple Facebook Pages, so
 * this can't be a singleton the way GoogleConnection's
 * (user_id, project_id, purpose) uniqueness is.
 *
 * Same AES-256-GCM / versioned-ciphertext scheme as GoogleConnection.js's
 * encryptToken/decryptToken and WordPressConnection.js's
 * encryptCredential/decryptCredential — deliberately a THIRD, separate
 * key (META_TOKEN_ENCRYPTION_KEY, not GOOGLE_TOKEN_ENCRYPTION_KEY or
 * WORDPRESS_CREDENTIAL_ENCRYPTION_KEY) so rotating any one vendor's key
 * never affects another vendor's stored connections — the same reasoning
 * WordPressConnection.js's own header comment documents for its key.
 */
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const keyHex = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('META_TOKEN_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptToken(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return plainText;
  if (typeof plainText === 'string' && plainText.startsWith(ENCRYPTION_PREFIX)) return plainText;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return cipherText;
  }

  try {
    const [ivHex, authTagHex, dataHex] = cipherText.slice(ENCRYPTION_PREFIX.length).split(':');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('[SOCIAL_ACCOUNT] Failed to decrypt token:', error.message);
    return null;
  }
}

const PLATFORMS = ['facebook', 'instagram'];
const ACCOUNT_TYPES = ['page', 'business', 'professional'];
const STATUSES = ['active', 'revoked', 'expired', 'error'];

const socialAccountSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    required: true,
  },
  // The platform's own stable ID for this account — the Facebook Page ID
  // for platform: 'facebook'. Kept generic (not `pageId` as the primary
  // key) so the same field name/index works unmodified once Instagram
  // rows (platform: 'instagram', platformAccountId = the IG Business
  // Account ID) are added in Phase 3.
  platformAccountId: {
    type: String,
    required: true,
    trim: true,
  },
  platformAccountName: {
    type: String,
    trim: true,
    default: null,
  },
  accountType: {
    type: String,
    enum: ACCOUNT_TYPES,
    required: true,
  },
  // Facebook Page ID — redundant with platformAccountId for a 'facebook'
  // row (same value), but explicit per the Phase 2 spec's required field
  // list, and becomes meaningfully DIFFERENT from platformAccountId once
  // a Phase 3 Instagram row exists: that row's platformAccountId is the
  // IG Business Account ID, while pageId still points back to the parent
  // Facebook Page it was discovered through.
  pageId: {
    type: String,
    trim: true,
    default: null,
  },
  // Populated in Phase 3 (Instagram discovery) — present on the schema
  // now so that phase is additive (no migration needed), left null here.
  instagramBusinessAccountId: {
    type: String,
    trim: true,
    default: null,
  },
  // Encrypted at rest — for platform: 'facebook' this is the PAGE access
  // token (never the user access token; see metaOAuthController.js's
  // selectMetaPage — the two are never confused).
  accessToken: {
    type: String,
    required: true,
    set: encryptToken,
    get: decryptToken,
  },
  // Meta does not return an expiry for most Page tokens obtained this way
  // — null is stored (never invented) unless a real value was present in
  // the /me/accounts response.
  tokenExpiresAt: {
    type: Date,
    default: null,
  },
  scopes: {
    type: [String],
    default: [],
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'active',
    index: true,
  },
  // Switch Account feature: a project can have several connected Facebook
  // Pages (the unique index below was always project+platform+
  // platformAccountId, never project+platform alone — multiple Pages per
  // project were already schema-legal, just never surfaced in the UI).
  // Exactly one row per (project_id, platform) may be isActive:true at a
  // time — enforced by the partial unique index below, not just app logic
  // — and that's the one the dashboard (status endpoint, Facebook overview)
  // reads. Unused for platform:'instagram' today (Instagram switching is
  // out of scope for this feature); left generic on the schema rather than
  // Facebook-only so a future Instagram-switching phase is additive.
  isActive: {
    type: Boolean,
    default: false,
  },
  // Non-sensitive display data only (category, profile picture URL) —
  // never a token, never anything from the pending connection's stored
  // credentials.
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  lastSyncedAt: {
    type: Date,
    default: null,
  },
  // Last time Meta itself confirmed (via the debug_token endpoint — see
  // metaTokenService.js) whether this connection's token is still valid.
  // null = never verified; distinct from lastSyncedAt (which tracks content
  // syncs). Never a token.
  lastVerifiedAt: {
    type: Date,
    default: null,
  },
  // Meta separately expires a user's *data access* (≈90 days after they
  // last authorized the app) even when the access token itself never
  // expires. When it passes, calls start failing with the token-invalid
  // family of errors, so it is tracked alongside tokenExpiresAt.
  dataAccessExpiresAt: {
    type: Date,
    default: null,
  },
  // Stable, machine-readable reason the last time `status` left 'active'
  // (e.g. 'META_TOKEN_INVALID', 'USER_DISCONNECTED') — safe to expose, never
  // Meta's raw message. null while active.
  statusReason: {
    type: String,
    default: null,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

// One connection per (project, platform, platform account) — re-selecting
// the same Page for the same project updates this row (see
// metaOAuthController.js's selectMetaPage, which upserts on this exact
// key) rather than creating a duplicate. A DIFFERENT project connecting
// the same Facebook Page is a separate, valid row (Pages aren't
// exclusive to one Odito project).
socialAccountSchema.index({ project_id: 1, platform: 1, platformAccountId: 1 }, { unique: true });
socialAccountSchema.index({ user_id: 1, status: 1 });
socialAccountSchema.index({ project_id: 1, status: 1 });
// DB-level guarantee (not just application logic) that at most one row per
// (project, platform) is ever isActive:true — a partial index so it only
// applies to documents where isActive is actually true; inactive rows
// (the common case) never compete for this uniqueness at all.
socialAccountSchema.index(
  { project_id: 1, platform: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

/** Mirrors GoogleConnection.js's stripSecrets — never let the encrypted OR decrypted token leave this process via serialization. */
function stripSecrets(doc, ret) {
  delete ret.accessToken;
  delete ret.__v;
  return ret;
}
socialAccountSchema.set('toJSON', { virtuals: true, transform: stripSecrets });
socialAccountSchema.set('toObject', { virtuals: true, transform: stripSecrets });

socialAccountSchema.statics.findActiveForProject = function (projectId, platform) {
  const query = { project_id: projectId, status: 'active' };
  if (platform) query.platform = platform;
  return this.find(query);
};

// The Meta permission each platform's real publish call actually requires
// — live-confirmed via the real Graph API (see facebookAdapter.js /
// instagramAdapter.js's normalizeFailure comments for the exact
// OAuthException errors this maps to). Single source of truth so
// socialAccountController.js's status endpoint and
// socialPublishingService.js's publish preflight can never disagree about
// what "publish-ready" means.
const REQUIRED_PUBLISH_SCOPE = {
  facebook: 'pages_manage_posts',
  instagram: 'instagram_content_publish',
};

/**
 * Derives publish-readiness directly from the account's own persisted
 * `scopes` (the permissions Meta ACTUALLY granted — see
 * metaOAuthService.js's fetchGrantedScopes) rather than a separate stored
 * boolean, so it can never drift out of sync with the real grant: a
 * connection is either read-only (missing the publish scope) or
 * publish-ready, and that fact is recomputed fresh every time, never
 * cached. Returns false for an unrecognized platform rather than
 * assuming readiness.
 */
export function isPublishingReady(account) {
  if (!account) return false;
  const required = REQUIRED_PUBLISH_SCOPE[account.platform];
  if (!required) return false;
  return Array.isArray(account.scopes) && account.scopes.includes(required);
}

const SocialAccount = mongoose.model('SocialAccount', socialAccountSchema);
export default SocialAccount;
export { PLATFORMS, ACCOUNT_TYPES, STATUSES, REQUIRED_PUBLISH_SCOPE };
